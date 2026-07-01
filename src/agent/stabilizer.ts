import Anthropic from '@anthropic-ai/sdk';
import type { Scenario, TraceStep, SelectorRecord } from './trace.js';

/**
 * Stabilizer — LLM-guided flake recovery for Stage 5b.
 *
 * Triggered ONLY when a scenario is classified `flaky` (passed at least one
 * stability iteration, failed at least one). `broken` scenarios (zero passes)
 * are not eligible.
 *
 * Remediation hierarchy (tries in order, never skips ahead to a sleep):
 *
 * 1. timeout_raise  — assertion races animation/async state. Raise the
 *                     assertion timeout so Playwright keeps polling.
 *                     Emits { timeout: N } on the assertion step.
 *
 * 2. wait_for_state — element not ready before a click/fill/press. Insert
 *                     locator.waitFor({ state }) — a condition-based wait,
 *                     NOT a fixed sleep.
 *
 * 3. swap           — locator is wrong or unstable. Replace with role/label.
 *
 * 4. broken         — semantic defect. The assertion expects a value never
 *                     reachable in this scenario. Reclassify as BROKEN; do
 *                     NOT attempt timing fixes.
 *
 * 5. none           — Stabilizer cannot categorise the failure.
 *
 * FORBIDDEN: page.waitForTimeout, sleep, any fixed delay. A scenario kept
 * alive by a hard sleep MUST NOT be reported as stable.
 */

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 700;

export interface FailureContext {
  /** Index in scenario.steps of the step that failed. */
  failedStep: number;
  stepKind: TraceStep['kind'] | 'unknown';
  /** Error message from the failed iteration. */
  error: string;
  /** Pattern string from stability, e.g. "P-F-P" — gives the proposer context. */
  pattern: string;
}

export type StabilizerProposal =
  /**
   * Raise the assertion timeout so Playwright keeps polling for the expected
   * value. Only valid when the failing step is an `assert` step. The timeout
   * is patched on the assertion object in-place; pom.ts / transcriber.ts
   * emit `{ timeout: N }` in the generated spec automatically.
   */
  | { kind: 'timeout_raise'; timeout: number; reason: string }
  /**
   * Insert `await locator.waitFor({ state })` BEFORE the failing step. A
   * condition-based wait — NOT a fixed sleep. Only valid when the failing
   * step has a target locator (click, fill, press).
   */
  | { kind: 'wait_for_state'; state: 'visible' | 'hidden' | 'attached' | 'detached'; stateTimeout?: number; reason: string }
  /** Replace the failing step's target with a stronger selector. */
  | { kind: 'swap'; newTarget: SelectorRecord; reason: string }
  /**
   * The scenario has a semantic defect — the assertion expects a value that
   * is never reachable in this case. Reclassifies the scenario as BROKEN in
   * the stability report. No timing fix is attempted.
   */
  | { kind: 'broken'; reason: string }
  /** Stabilizer cannot determine a fix. Scenario is dropped as flaky. */
  | { kind: 'none'; reason: string };

/**
 * One previous fix attempt — what was proposed, and what happened when the
 * patched scenario was re-run.
 */
export interface PreviousAttempt {
  proposal: StabilizerProposal;
  /** Iteration pattern from the re-run after the proposal was applied, e.g. "F-F-F". */
  pattern: string;
}

export interface StabilizerOptions {
  scenario: Scenario;
  failure: FailureContext;
  previousAttempts?: PreviousAttempt[];
  model?: string;
  client?: Anthropic;
}

export interface StabilizerResult {
  proposal: StabilizerProposal;
  costUsd: number;
}

const SYSTEM_PROMPT = `You are a Playwright flake doctor. A test scenario passed at least one stability iteration but failed at least one — it is timing-sensitive or selector-sensitive.

Apply this remediation hierarchy in order. Pick the FIRST fix that fits.

1. TIMEOUT_RAISE — the assertion races an animation or async state.
   Conditions: the failing step is an assert, the error shows "expected X" or "assertion not met", and the element updates asynchronously (progress bar, counter, spinner, banner, toast, live text, any value that changes over time).
   Fix: raise the assertion timeout so Playwright keeps polling. Range: 10000–30000ms.
   This is a web-first polling assertion — Playwright retries until the value matches or the timeout expires. It is NOT a sleep.
   Do NOT use for click or fill steps.

2. WAIT_FOR_STATE — the element is not ready when the step runs.
   Conditions: the failing step is a click, fill, or press; the error says "not visible", "not attached", "not stable", "not enabled", "target closed", or "element is not in the DOM".
   Fix: insert locator.waitFor({ state }) BEFORE the failing step. This blocks until the DOM condition is met — not a fixed sleep.
   Choose state:
     - visible   for "not visible" or "not enabled" errors
     - attached  for "not attached" or "element is not in the DOM"
     - detached  for "element is still in the DOM" when you expect a modal/loader to leave
     - hidden    rarely needed; use when waiting for an overlay to disappear before clicking through

3. SWAP — the locator is wrong or unstable.
   Conditions: error mentions "strict mode violation", "resolved to N elements", "not found", or the current selector is CSS-based.
   Fix: replace with a role+name or testid selector.

4. BROKEN — semantic defect. Do not attempt timing fixes.
   Conditions: any of the following:
     - the assertion expects a hardcoded value that is only valid in one specific run (e.g. a price, a count, a user-specific string)
     - the flow navigates to a state where the asserted element can never exist
     - a previous timeout_raise or wait_for_state attempt at the upper end of the range already failed
     - fixing this would require a page.waitForTimeout or a sleep — that signal means the assertion or locator is wrong
   This is a spec defect. The scenario is reclassified as BROKEN and removed from the emitted spec.

5. NONE — cannot categorise the failure. The scenario is dropped.

FORBIDDEN: Never propose page.waitForTimeout, sleep, or any fixed delay. If the only fix is an arbitrary sleep, classify as BROKEN instead.

Previous attempts (if any) will be listed. Do NOT repeat a proposal of the same kind+value.

Output STRICT format (no markdown, no extra prose):

<kind>timeout_raise|wait_for_state|swap|broken|none</kind>
<timeout>10000..30000</timeout>                                   <!-- only if kind=timeout_raise -->
<state>visible|hidden|attached|detached</state>                  <!-- only if kind=wait_for_state -->
<state_timeout>5000..30000</state_timeout>                       <!-- only if kind=wait_for_state -->
<level>role|label|placeholder|testid|css</level>                 <!-- only if kind=swap -->
<arg>JSON-encoded selector arg matching the level</arg>          <!-- only if kind=swap -->
<reason>one short sentence</reason>

For role swap: arg is {"role":"button","name":"Submit","exact":true}
For label/placeholder/testid swap: arg is "Submit"
For css swap: arg is ".my-class > button"`;

/* ─────────────────── Proposer ─────────────────── */

export async function proposeStabilityFix(opts: StabilizerOptions): Promise<StabilizerResult> {
  const step = opts.scenario.steps[opts.failure.failedStep];
  if (!step) {
    return { proposal: { kind: 'none', reason: 'failing step index out of range' }, costUsd: 0 };
  }

  const client = opts.client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = opts.model ?? process.env.QA_CORE_MODEL_STABILIZER ?? DEFAULT_MODEL;

  const stepDescription = describeStep(step);
  const history = (opts.previousAttempts ?? []).map((a, i) =>
    `  ${i + 1}. ${describeProposal(a.proposal)} — re-run pattern: ${a.pattern}`,
  );
  const historyBlock = history.length
    ? `Previous fix attempts (in order):\n${history.join('\n')}\n` +
      `Do NOT repeat any of the above — propose something materially different.\n\n`
    : '';
  const userMsg =
    `Scenario: "${opts.scenario.name}"\n` +
    `Iteration pattern (original): ${opts.failure.pattern}\n` +
    `Failing step (#${opts.failure.failedStep}): ${stepDescription}\n` +
    `Error:\n  ${opts.failure.error.slice(0, 600)}\n\n` +
    historyBlock +
    `Propose one fix using the remediation hierarchy.`;

  let raw = '';
  let costUsd = 0;
  try {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam],
      messages: [{ role: 'user', content: userMsg }],
    });
    raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    costUsd = estimateCost(model, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown LLM error';
    return { proposal: { kind: 'none', reason: `LLM call failed: ${reason}` }, costUsd: 0 };
  }

  return { proposal: parseProposal(raw), costUsd };
}

/* ─────────────────── Apply ─────────────────── */

/**
 * Apply a proposal to `scenario.steps` in place. Returns the modified scenario
 * (also mutated). Caller is responsible for re-running stability on it.
 *
 * timeout_raise: patches the assertion step's timeout field in-place. Replay
 * reads a.timeout ?? timeoutMs, so the raised value is honoured immediately.
 * pom.ts / transcriber.ts emit { timeout: N } in the generated spec.
 *
 * wait_for_state: inserts a new wait_for_state step BEFORE the failing step.
 * This calls locator.waitFor({ state }) — a condition-based wait, not a sleep.
 *
 * swap: replaces the failing step's target. Original intent is preserved.
 *
 * broken / none: no mutation — caller handles classification change.
 */
export function applyProposal(scenario: Scenario, failedStepIdx: number, proposal: StabilizerProposal): Scenario {
  if (proposal.kind === 'none' || proposal.kind === 'broken') return scenario;

  if (proposal.kind === 'timeout_raise') {
    const target = scenario.steps[failedStepIdx];
    if (target?.kind === 'assert') {
      (target.assertion as { timeout?: number }).timeout = proposal.timeout;
    }
    return scenario;
  }

  if (proposal.kind === 'wait_for_state') {
    const failingStep = scenario.steps[failedStepIdx];
    if (!failingStep) return scenario;
    const stepTarget = 'target' in failingStep ? failingStep.target as SelectorRecord : null;
    if (!stepTarget) return scenario;
    const waitStep: TraceStep = {
      kind: 'wait_for_state',
      target: stepTarget,
      state: proposal.state,
      timeoutMs: proposal.stateTimeout,
    };
    scenario.steps.splice(Math.max(0, failedStepIdx), 0, waitStep);
    return scenario;
  }

  // kind === 'swap'
  const target = scenario.steps[failedStepIdx];
  if (!target) return scenario;
  if ('target' in target && target.target) {
    const originalIntent = (target.target as SelectorRecord).intent;
    (target as { target: SelectorRecord }).target = { ...proposal.newTarget, intent: originalIntent };
  }
  return scenario;
}

/* ─────────────────── Parsing ─────────────────── */

const TAG_RE = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');

export function parseProposal(raw: string): StabilizerProposal {
  const kindMatch = raw.match(TAG_RE('kind'));
  const kind = kindMatch?.[1]?.trim().toLowerCase();
  const reason = raw.match(TAG_RE('reason'))?.[1]?.trim() || 'no reason given';

  if (kind === 'timeout_raise') {
    const timeoutStr = raw.match(TAG_RE('timeout'))?.[1]?.trim();
    const timeout = timeoutStr ? Number(timeoutStr) : NaN;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return { kind: 'none', reason: `timeout_raise had invalid timeout: "${timeoutStr ?? '<missing>'}"` };
    }
    return { kind: 'timeout_raise', timeout: Math.max(5000, Math.min(60000, Math.round(timeout))), reason };
  }

  if (kind === 'wait_for_state') {
    const state = raw.match(TAG_RE('state'))?.[1]?.trim().toLowerCase();
    const validStates = ['visible', 'hidden', 'attached', 'detached'] as const;
    if (!state || !validStates.includes(state as typeof validStates[number])) {
      return { kind: 'none', reason: `wait_for_state had invalid state: "${state ?? '<missing>'}"` };
    }
    const stateTimeoutStr = raw.match(TAG_RE('state_timeout'))?.[1]?.trim();
    const stateTimeout = stateTimeoutStr ? Number(stateTimeoutStr) : undefined;
    return {
      kind: 'wait_for_state',
      state: state as 'visible' | 'hidden' | 'attached' | 'detached',
      stateTimeout: (stateTimeout && Number.isFinite(stateTimeout))
        ? Math.max(2000, Math.min(30000, Math.round(stateTimeout)))
        : undefined,
      reason,
    };
  }

  if (kind === 'swap') {
    const level = raw.match(TAG_RE('level'))?.[1]?.trim().toLowerCase();
    const argStr = raw.match(TAG_RE('arg'))?.[1]?.trim();
    if (!level || !argStr) {
      return { kind: 'none', reason: 'swap proposal missing level or arg' };
    }
    if (!isCascadeLevel(level)) {
      return { kind: 'none', reason: `unknown cascade level: "${level}"` };
    }

    let arg: SelectorRecord['arg'];
    try {
      arg = JSON.parse(argStr);
    } catch {
      arg = argStr.replace(/^"(.*)"$/, '$1');
    }

    if (level === 'role') {
      if (typeof arg !== 'object' || !arg || typeof (arg as { role?: unknown }).role !== 'string') {
        return { kind: 'none', reason: 'role-level arg must be {role, name, exact?}' };
      }
    } else {
      if (typeof arg !== 'string') {
        return { kind: 'none', reason: `${level}-level arg must be a string` };
      }
    }

    return {
      kind: 'swap',
      newTarget: { level, arg, intent: '' /* caller fills via applyProposal */ },
      reason,
    };
  }

  if (kind === 'broken') return { kind: 'broken', reason };
  if (kind === 'none') return { kind: 'none', reason };
  return { kind: 'none', reason: `unrecognized proposal kind: "${kind ?? '<missing>'}"` };
}

/* ─────────────────── Helpers ─────────────────── */

/** Compact human-readable form of a proposal — used in the LLM history block. */
export function describeProposal(p: StabilizerProposal): string {
  if (p.kind === 'timeout_raise') return `timeout_raise(${p.timeout}ms)`;
  if (p.kind === 'wait_for_state') {
    const t = p.stateTimeout ? `, ${p.stateTimeout}ms` : '';
    return `wait_for_state(${p.state}${t})`;
  }
  if (p.kind === 'swap') {
    const arg = typeof p.newTarget.arg === 'string' ? p.newTarget.arg : JSON.stringify(p.newTarget.arg);
    return `swap → ${p.newTarget.level}(${arg})`;
  }
  if (p.kind === 'broken') return `broken (spec defect: ${p.reason})`;
  return `none (${p.reason})`;
}

function describeStep(step: TraceStep): string {
  const base = `kind=${step.kind}`;
  if ('target' in step && step.target) {
    return `${base}, target=${step.target.level}(${JSON.stringify(step.target.arg)}), intent="${step.target.intent}"`;
  }
  if (step.kind === 'navigate') return `${base}, url=${step.url}`;
  if (step.kind === 'wait') return `${base}, ms=${step.ms}`;
  if (step.kind === 'press') return `${base}, key=${step.key}`;
  if (step.kind === 'assert') return `${base}, assertion=${step.assertion.type}`;
  return base;
}

function isCascadeLevel(s: string): s is SelectorRecord['level'] {
  return s === 'role' || s === 'label' || s === 'placeholder' || s === 'text' ||
    s === 'alt' || s === 'title' || s === 'testid' || s === 'css' || s === 'xpath';
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const isOpus = /opus/i.test(model);
  const isHaiku = /haiku/i.test(model);
  const inputPerM = isOpus ? 15 : isHaiku ? 1 : 3;
  const outputPerM = isOpus ? 75 : isHaiku ? 5 : 15;
  return (inputTokens * inputPerM + outputTokens * outputPerM) / 1_000_000;
}
