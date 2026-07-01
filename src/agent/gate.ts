import type { Scenario, SelectorRecord } from './trace.js';
import { ADAPTIVE_FLOOR_MS } from './adaptive-timeout.js';

/**
 * Static validation gate — runs after the Explorer closes a scenario and
 * before Reality-Check. Enforces rules that prevent flakiness from reaching
 * the emitted spec:
 *
 *   RULE 1: No hard sleeps ({ kind: 'wait' } steps). Exception: stability_wait
 *           steps (tagged explicitly) between two reads are allowed up to 1000ms.
 *   RULE 2: Floor enforcement on async/animated assertions. Timeouts come from
 *           the page (the adaptive timeout measured during exploration), so the
 *           gate no longer injects a completion constant. It only raises a
 *           missing or below-floor timeout up to the 5000 ms floor, so legacy or
 *           externally-built scenarios never ship with a too-short budget.
 *   RULE 3: No FRAGILE CSS-tier locator on animated or dynamically-changing
 *           elements. Stable selectors (unique ID, data-* attr, single semantic
 *           class) are always allowed, even on animated elements. Exception:
 *           inside a table, a positional address (nth-child / nth-of-type on a
 *           tr/td/th or a row/cell role) is allowed for capture/assert_compare —
 *           a cell's position IS its address there, and a sort test must read it.
 *           Positional selectors outside a table stay fragile and rejected.
 *   RULE 4: No intermediate numeric text assertion on a known-animated element.
 *           Asserting "50%" on a progress bar that is also the target of
 *           assert_freeze will almost certainly be flaky.
 *
 * The gate is pure and synchronous: no network, no LLM. It reads and
 * optionally mutates the Scenario object that end_scenario is about to push
 * to ctx.scenarios.
 */

export interface GateViolation {
  rule: 1 | 3 | 4;
  stepIndex: number;
  detail: string;
}

export interface GateInjection {
  stepIndex: number;
  assertionType: string;
  detail: string;
}

export interface GateResult {
  /**
   * RULE 1, RULE 3, and RULE 4 blocking violations. When non-empty the caller
   * must reject the scenario and give the Explorer a chance to regenerate.
   */
  violations: GateViolation[];
  /**
   * RULE 2 auto-injections that were applied in-place. Only populated when
   * violations is empty (i.e. the scenario was accepted). The caller should
   * add these to the run-level injection log so they appear in the report.
   */
  injections: GateInjection[];
}

// Floor only. The real timeout is the adaptive value measured from the page
// during exploration (see adaptive-timeout.ts). This is not a completion
// constant — it is the lowest budget the gate will let any async assertion ship
// with, so a missing or too-small timeout gets raised to the floor.
const ASYNC_TIMEOUT_FLOOR = ADAPTIVE_FLOOR_MS;
const DYNAMIC_TIMEOUT_THRESHOLD = 5_000;

// Positional pseudo-classes that make a selector fragile under DOM changes
const POSITIONAL_RE = /:nth-child|:nth-of-type|:first-child|:last-child|:nth-last/i;
// Known CSS-in-JS auto-generated class prefixes (css-1a2b3c, sc-9f2k, etc.)
const HASHED_CLASS_RE = /\.(css|sc|jss|styled)-[\w]+/i;

// Table structural elements as type selectors (matched at a selector boundary so
// "td" inside another word never trips it) and the ARIA table roles.
const TABLE_ELEMENT_RE = /(^|[\s>~+(,])(table|thead|tbody|tfoot|tr|td|th)([\s>~+:.[#)\],]|$)/i;
const TABLE_ROLE_RE = /\[\s*role\s*[~|^$*]?=\s*["']?(row|cell|columnheader|rowheader|gridcell|grid|table)\b/i;

/**
 * Run all gate rules on a completed Scenario.
 *
 * Mutations: RULE 2 injects timeouts directly onto assertion objects when
 * there are no violations. If the caller rejects the scenario, the mutated
 * object is abandoned (never pushed to ctx.scenarios), so the mutation is
 * harmless.
 */
export function runGate(scenario: Scenario): GateResult {
  const violations: GateViolation[] = [];

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;

    // RULE 1: any { kind: 'wait' } step emits page.waitForTimeout — forbidden.
    // { kind: 'stability_wait' } is explicitly tagged and allowed because it
    // sits between two reads in a stability comparison, not before a one-shot
    // assertion.
    if (step.kind === 'wait') {
      violations.push({
        rule: 1,
        stepIndex: i,
        detail: `step ${i + 1}: page.waitForTimeout(${step.ms}ms) is a hard sleep; use wait_for_text or a polling assertion with an explicit timeout instead`,
      });
    }

    // RULE 3a: capture / assert_compare on a FRAGILE CSS-tier locator.
    // Stable selectors (#id, data-*, single semantic class) are explicitly
    // allowed — they remain unique even as the value animates. Capture-and-
    // compare reads the same element twice, so a fragile selector that drifts
    // between reads would silently compare two different elements.
    if ((step.kind === 'capture' || step.kind === 'assert_compare') && step.target.level === 'css') {
      const sel = String(step.target.arg);
      // Table-context exception: inside a table, a positional address (row 1,
      // column 1) is stable and correct — that cell HAS no role or id of its own
      // because its content changes by design when you sort. Position is exactly
      // what a sort test must read, so the gate allows it here. Outside a table,
      // and for hashed/auto-generated classes even inside one, position stays
      // fragile and rejected.
      if (isFragileCssSelector(sel) && !isTablePositionalSelector(sel)) {
        violations.push({
          rule: 3,
          stepIndex: i,
          detail: `step ${i + 1}: fragile CSS-tier selector "${sel}" used with ${step.kind} — switch to role/label tier, or use a stable #id or [data-*] selector`,
        });
      }
    }

    // RULE 3b: fragile CSS-tier assertion on an element shown to be dynamic
    if (step.kind === 'assert' && 'target' in step.assertion && step.assertion.target.level === 'css') {
      const a = step.assertion;
      if (a.type === 'toHaveText' || a.type === 'toContainText' || a.type === 'toHaveAttribute' || a.type === 'toHaveValue' || a.type === 'toBeVisible') {
        const sel = String(a.target.arg);
        if (isFragileCssSelector(sel) && !isTablePositionalSelector(sel)) {
          const existingTimeout = (a as { timeout?: number }).timeout ?? 0;
          const knownLong = existingTimeout >= DYNAMIC_TIMEOUT_THRESHOLD;
          const corroborated = hasDynamicCorroboration(scenario, i, sel);
          if (knownLong || corroborated) {
            violations.push({
              rule: 3,
              stepIndex: i,
              detail: `step ${i + 1}: fragile CSS-tier selector "${sel}" on a dynamic element — switch to role/label tier, or use a stable #id or [data-*] selector`,
            });
          }
        }
      }
    }

    // RULE 4: no intermediate numeric text assertion on a known-animated element.
    // Asserting "25%" or "50%" on a progress bar that is also targeted by
    // assert_freeze will fail non-deterministically — the value is still moving.
    // Use wait_for_text to wait for the terminal state, or assert_freeze to
    // verify the animation stopped.
    if (step.kind === 'assert') {
      const a = step.assertion;
      if ((a.type === 'toHaveText' || a.type === 'toContainText') && 'target' in a && 'text' in a) {
        const text = (a as { text: string }).text.trim();
        if (looksLikeIntermediateValue(text)) {
          const intent = (a as { target: SelectorRecord }).target.intent;
          if (hasDynamicCorroborationByIntent(scenario, i, intent)) {
            violations.push({
              rule: 4,
              stepIndex: i,
              detail: `step ${i + 1}: asserting "${text}" on an animated element looks like an intermediate value — use wait_for_text for the terminal state, or assert_freeze to verify the animation stopped`,
            });
          }
        }
      }
    }
  }

  // RULE 2: floor enforcement on async/animated assertions — only when the
  // scenario passes RULE 1 + RULE 3 + RULE 4 (no point touching a rejected one).
  // The timeout itself comes from the page (the adaptive value recorded during
  // exploration). The gate only steps in when a timeout is missing or below the
  // floor, raising it to the floor so nothing ships with a too-short budget.
  const injections: GateInjection[] = [];
  if (violations.length === 0) {
    const hasAction = scenario.steps.some(
      (s) => s.kind === 'click' || s.kind === 'fill' || s.kind === 'press' || s.kind === 'navigate'
        || s.kind === 'select_option' || s.kind === 'set_checked' || s.kind === 'set_input_files',
    );
    if (hasAction) {
      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i]!;
        if (step.kind !== 'assert') continue;
        const a = step.assertion;
        if (a.type !== 'toHaveText' && a.type !== 'toContainText' && a.type !== 'toHaveAttribute' && a.type !== 'toHaveValue' && a.type !== 'toBeVisible') continue;
        const current = (a as { timeout?: number }).timeout;
        if (!current || current < ASYNC_TIMEOUT_FLOOR) {
          (a as { timeout?: number }).timeout = ASYNC_TIMEOUT_FLOOR;
          injections.push({
            stepIndex: i,
            assertionType: a.type,
            detail: `step ${i + 1}: raised timeout to the ${ASYNC_TIMEOUT_FLOOR}ms floor on ${a.type} (was ${current ?? 'unset'})`,
          });
        }
      }
    }
  }

  return { violations, injections };
}

/**
 * Returns true when the text looks like an intermediate counter value:
 * 1%–99% (progress bars), or a bare integer 1–99 (countdown counters).
 * Terminal values (0%, 100%, 0) and non-numeric strings are excluded.
 */
function looksLikeIntermediateValue(text: string): boolean {
  // 1%–99% — intermediate for any progress bar
  if (/^([1-9]|[1-9]\d)%$/.test(text)) return true;
  // Bare integers 1–99 — intermediate for countdown/counter widgets
  if (/^[1-9]\d?$/.test(text)) return true;
  return false;
}

/**
 * Returns true when the CSS selector is stable enough to be allowed even on
 * animated elements. Stable selectors are unique and do not drift when the
 * DOM re-renders.
 *
 *   - Bare unique ID:            #progressBar, #foo-bar
 *   - Pure data-* attribute:     [data-testid="submit"], [data-cy]
 *   - Single semantic class:     .progress-bar, .container (no hashed prefix)
 */
export function isStableCssSelector(sel: string): boolean {
  if (/^#[\w-]+$/.test(sel)) return true;
  if (/^\[data-[\w-]+/.test(sel)) return true;
  // Single class with letters+hyphens only (e.g. .progress-bar), no hashed prefix
  if (/^\.[a-zA-Z][a-zA-Z-]*[a-zA-Z]$/.test(sel) && !HASHED_CLASS_RE.test(sel)) return true;
  // Single short class that may end with a digit (e.g. .h2, .mb4) but not a long numeric run
  if (/^\.[a-zA-Z][a-zA-Z0-9-]*$/.test(sel) && !/\d{3,}/.test(sel) && !HASHED_CLASS_RE.test(sel)) return true;
  return false;
}

/**
 * Returns true when the CSS selector is fragile — positional, auto-generated,
 * or a deep descendant chain that will break under DOM refactors.
 *
 * Fragile patterns:
 *   - Positional pseudo-classes (:nth-child, :first-child, …)
 *   - Auto-generated/hashed class names (css-1a2b3c, sc-9f2k, …)
 *   - Descendant chains deeper than 2 levels (.a .b .c or .a > .b > .c)
 *
 * Stable selectors are never fragile.
 */
/**
 * True when the CSS selector addresses an element inside a table — by table
 * structural element (tr/td/th/thead/tbody/tfoot/table) or by an ARIA table
 * role (row/cell/columnheader/rowheader/gridcell/grid/table).
 *
 * Position inside a table is a valid, stable address: "row 1, column 1" has no
 * role or id of its own because its content changes by design when you sort, and
 * proving the order changed is the whole point of a sort test. So RULE 3 allows
 * the positional pseudo-classes and deep table chains it rejects everywhere else.
 *
 * A hashed / auto-generated class is fragile even inside a table (it drifts on
 * every rebuild, not just on a sort), so this exception explicitly does NOT
 * cover those — they stay rejected.
 */
export function isTablePositionalSelector(sel: string): boolean {
  if (HASHED_CLASS_RE.test(sel)) return false;
  return TABLE_ELEMENT_RE.test(sel) || TABLE_ROLE_RE.test(sel);
}

export function isFragileCssSelector(sel: string): boolean {
  if (isStableCssSelector(sel)) return false;
  if (POSITIONAL_RE.test(sel)) return true;
  if (HASHED_CLASS_RE.test(sel)) return true;
  // Count selector parts by splitting on combinators/whitespace.
  // More than 2 parts = chain deeper than 2 levels = fragile.
  const parts = sel
    .replace(/\[[^\]]*\]/g, '[x]')            // collapse attribute selectors
    .replace(/:[a-zA-Z-]+(\([^)]*\))?/g, '')  // strip pseudo-classes/elements
    .split(/\s*[>~+]\s*|\s+/)
    .filter((p) => p.trim().length > 0);
  if (parts.length > 2) return true;
  return false;
}

/**
 * Returns true when the given CSS selector arg is the target of a
 * capture/assert_compare step or a long-timeout assertion step ELSEWHERE in the
 * scenario. Cross-step corroboration that the element is animated or its
 * value changes over time.
 */
function hasDynamicCorroboration(scenario: Scenario, excludeIdx: number, cssArg: string): boolean {
  return scenario.steps.some((s, idx) => {
    if (idx === excludeIdx) return false;
    if ((s.kind === 'capture' || s.kind === 'assert_compare') && String(s.target.arg) === cssArg) return true;
    if (
      s.kind === 'assert' &&
      'target' in s.assertion &&
      String(s.assertion.target.arg) === cssArg &&
      ((s.assertion as { timeout?: number }).timeout ?? 0) >= DYNAMIC_TIMEOUT_THRESHOLD
    ) return true;
    return false;
  });
}

/**
 * Returns true when the given intent is the target of a capture/assert_compare
 * step or a long-timeout toHaveText assertion ELSEWHERE in the scenario. Used
 * by RULE 4 to confirm the element is animated before flagging an intermediate
 * value assertion.
 */
function hasDynamicCorroborationByIntent(scenario: Scenario, excludeIdx: number, intent: string): boolean {
  return scenario.steps.some((s, idx) => {
    if (idx === excludeIdx) return false;
    if ((s.kind === 'capture' || s.kind === 'assert_compare') && s.target.intent === intent) return true;
    if (
      s.kind === 'assert' &&
      'target' in s.assertion &&
      s.assertion.type === 'toHaveText' &&
      (s.assertion as unknown as { target: SelectorRecord }).target.intent === intent &&
      ((s.assertion as { timeout?: number }).timeout ?? 0) >= DYNAMIC_TIMEOUT_THRESHOLD
    ) return true;
    return false;
  });
}
