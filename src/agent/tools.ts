import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { resolve, parsePiercingSelector, type CascadeLevel, escapeRegex } from './selectors.js';
import { recoverResolve, type ResolveInput } from './selector-recovery.js';
// Re-exported for back-compat with older consumers of tools.ts. New code
// should import from selector-recovery.ts directly.
export { recoverResolve, type ResolveInput };
import type { Assertion, Scenario, SelectorRecord, TraceStep, CaptureSource, CompareRelation } from './trace.js';
import { baseLocator } from './replay.js';
import { detectUniqueField, generateUnique } from './unique-data.js';
import { runGate } from './gate.js';
import { adaptiveTimeout, ADAPTIVE_CEILING_MS } from './adaptive-timeout.js';
import {
  chooseStateAssertion,
  SEMANTIC_STATE_ATTRS,
  VALUE_NOW_ATTR,
  VALUE_MIN_ATTR,
  VALUE_MAX_ATTR,
} from './aria-assertion.js';

/**
 * How many times the SAME assertion may fail in one scenario before the
 * Explorer must stop retrying. The classic failure is a happy-path success
 * signal that was assumed, not verified: the test asserts "land on /auth/login"
 * but the form never redirects, so the model re-fills the whole form and
 * re-submits over and over, burning the budget on one scenario. After this many
 * failures of the same assertion we stop, capture what the page actually did,
 * record a finding, and force the model on to the next scenario. Two is the
 * floor that still allows one honest retry (slow settle, transient state).
 */
const OUTCOME_RETRY_CAP = 2;

/**
 * Steps a scenario already in progress may run PAST the budget purely to close
 * itself out: assert the outcome, capture/compare, end_scenario. This salvages a
 * scenario that spent the budget filling a long form and only needs its cheap
 * closing assertion. Small on purpose: 4 covers one or two asserts plus
 * end_scenario, never enough to fit another scenario. See the guard in runTool.
 */
const CLOSEOUT_GRACE = 4;

/**
 * Recovery cap: how many times a selector that FAILS TO RESOLVE is re-resolved
 * against the live page before the run gives up and records it as a finding.
 * Small on purpose so a genuinely-missing element cannot loop. Selector recovery
 * is scoped to locators only — an assertion that fails (element found,
 * value/state wrong) is NEVER recovered, because that may be a real regression.
 * See resolveAndRecord (the locate path) versus assertWithRetryCap (the
 * assertion path).
 */
const RECOVERY_CAP = 2;

/**
 * Thrown by resolveAndRecord when a selector could not be resolved OR recovered
 * after RECOVERY_CAP attempts. The finding is already recorded and further
 * actions are already blocked by the time this is thrown, so callers (including
 * the assertion retry-cap) must pass it straight through without double-counting
 * it as an assertion failure.
 */
export class LocatorFindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocatorFindingError';
  }
}

/**
 * Tool surface exposed to Claude via tool-use.
 *
 * Hardening over v1:
 *   - `navigate` waits for `load` (not just DOMContentLoaded) to give SPAs
 *     a chance to hydrate before the next get_dom call.
 *   - `get_dom` reports form state (disabled / required / readonly / value /
 *     aria-invalid / aria-required) and uses a real visibility check.
 *   - `begin_scenario` clears cookies + storage so scenarios do not inherit
 *     state from each other (matches how the transcribed tests will run).
 *   - `toHaveURL` escapes the user pattern; the agent passes a substring,
 *     not a regex.
 *   - Console errors and 4xx/5xx responses are captured per scenario.
 */

export interface ToolContext {
  page: Page;
  scenarios: Scenario[];
  current: Scenario | null;
  cascadeStats: Record<CascadeLevel, number>;
  steps: number;
  maxSteps: number;
  /**
   * Wall-clock of the last state-changing action (navigate/click/fill/press).
   * Async assertions anchor their adaptive-timeout measurement here, not at the
   * moment the assertion is issued, so an animated value (a progress bar filling
   * to aria-valuenow="100") is measured across the FULL action-to-target window.
   * Measuring only from the assert call under-counts when the model spent a turn
   * thinking — the bar may already be done, collapsing the observation to the
   * 5000ms floor. The last action always precedes the assert, so this can only
   * lengthen the window, never shorten it.
   */
  lastActionAt: number;
  /** Rolling capture for the current scenario; flushed onto it at end_scenario. */
  consoleErrors: Array<{ kind: 'error' | 'warning'; text: string }>;
  networkErrors: Array<{ status: number; url: string }>;
  /** Installed listener disposers so we can detach on page swap. */
  _detachListeners?: () => void;
  /** Gate: how many times each scenario name has been rejected (RULE 1 or RULE 3). */
  _gateAttempts: Map<string, number>;
  /** Gate: scenarios permanently dropped after hitting the 2-attempt cap. */
  brokenByGate: Array<{ scenario: string; reason: string; attempts: number }>;
  /** Scenarios begun but never finalized (step budget exhausted, abandoned). */
  incomplete: Array<{ scenario: string; reason: string }>;
  /** Gate: RULE 2 timeout injections applied to accepted scenarios. */
  _gateInjectionLog: Array<{ scenario: string; stepIndex: number; assertionType: string; detail: string }>;
  /**
   * Capture-and-compare registry for the CURRENT scenario. Maps the model's
   * variable name to what was captured: the emitted spec identifier, how it was
   * read, the live value at capture time, and how to re-read it. Cleared on
   * every begin_scenario so captures never leak across scenarios. assert_compare
   * looks up here to re-read the same element and to keep varNames collision
   * free in the emitted spec.
   */
  captures: Map<string, CaptureEntry>;
  /**
   * Retry cap: how many times each assertion (by signature) has failed in this
   * run. Keyed by signature and persisted across begin_scenario ON PURPOSE: when
   * an outcome never happens, the model restarts the scenario (its own choice or
   * a gate rejection) and tries the same assertion again. If this were cleared on
   * begin_scenario, every restart would reset the count to zero and the cap could
   * never accumulate, which is exactly the bug that let a happy path burn the
   * whole budget across restarts. A signature's count is cleared only when that
   * assertion finally PASSES. When a signature reaches OUTCOME_RETRY_CAP the
   * scenario is recorded as a finding and further actions are blocked.
   */
  _assertFailures: Map<string, number>;
  /**
   * Set true after the retry cap trips. While set, every action tool is rejected
   * cheaply (no page action, no re-fill) until the model starts the next
   * scenario with begin_scenario or calls finish. This is what actually stops
   * the form-refill thrash instead of just recording it.
   */
  _blockUntilNewScenario: boolean;
  /**
   * Scenarios whose expected outcome never occurred (retry cap tripped). Each is
   * a real finding: the success signal the plan assumed was wrong or absent, and
   * the page stayed somewhere else. Surfaced in the run report and reconciliation
   * so a wrong success signal fails loudly instead of vanishing or shipping green.
   */
  findings: Array<{ scenario: string; category?: string; expected: string; url: string; messages: string[] }>;
  /**
   * Recovery attempts: how many times each selector (by signature) has failed to
   * resolve AND failed to recover in a row. A selector that recovers
   * successfully never accumulates (the run moves on). A selector that keeps
   * failing to resolve trips RECOVERY_CAP and becomes a finding. Keyed by
   * selector signature.
   */
  _recoveryAttempts: Map<string, number>;
  /**
   * In-run selector recoveries applied this run: a locator that failed to
   * resolve was re-resolved by the ladder and found a different way, so
   * exploration continued. Each is a distinct, visible event surfaced in the run
   * output and carried into the RunReport so a human can see exactly what was
   * recovered. Purely a locator recovery — assertions are never recovered. The
   * field keeps its `heals` name because RunReport.heals and the dashboard's
   * 'heal' event consume it.
   */
  heals: Array<{ scenario?: string; intent: string; from: string; to: string }>;
}

/** A single live capture, held for the current scenario only. */
interface CaptureEntry {
  /** Collision-free JS identifier declared in the emitted spec. */
  varName: string;
  source: CaptureSource;
  target: SelectorRecord;
  attribute?: string;
  /** The real value read off the page at capture time. */
  value: string;
}

export function createContext(page: Page, maxSteps: number): ToolContext {
  const ctx: ToolContext = {
    page,
    scenarios: [],
    current: null,
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    steps: 0,
    maxSteps,
    lastActionAt: Date.now(),
    consoleErrors: [],
    networkErrors: [],
    _gateAttempts: new Map(),
    brokenByGate: [],
    incomplete: [],
    _gateInjectionLog: [],
    captures: new Map(),
    _assertFailures: new Map(),
    _blockUntilNewScenario: false,
    findings: [],
    _recoveryAttempts: new Map(),
    heals: [],
  };
  attachDiagnostics(ctx);
  return ctx;
}

function attachDiagnostics(ctx: ToolContext): void {
  const onConsole = (msg: import('@playwright/test').ConsoleMessage) => {
    const t = msg.type();
    if (t !== 'error' && t !== 'warning') return;
    ctx.consoleErrors.push({ kind: t, text: msg.text().slice(0, 240) });
  };
  const onPageError = (err: Error) => {
    ctx.consoleErrors.push({ kind: 'error', text: (err.message ?? String(err)).slice(0, 240) });
  };
  const onResponse = (res: import('@playwright/test').Response) => {
    const status = res.status();
    if (status >= 400 && status < 600) {
      ctx.networkErrors.push({ status, url: res.url().slice(0, 240) });
    }
  };
  ctx.page.on('console', onConsole);
  ctx.page.on('pageerror', onPageError);
  ctx.page.on('response', onResponse);
  ctx._detachListeners = () => {
    ctx.page.off('console', onConsole);
    ctx.page.off('pageerror', onPageError);
    ctx.page.off('response', onResponse);
  };
}

export interface ToolInput {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export const TOOL_DEFS = [
  {
    name: 'begin_scenario',
    description:
      'Start a new test scenario. Call this before any actions. Categories: happy (positive path), negative (invalid input / error states), edge (boundary conditions), a11y (accessibility). The optional `feature` field tags the scenario (e.g. "login", "cart") so the framework groups related tests under tests/<feature>/ and emits one <feature>-page.ts per feature. Use the feature names from your plan when provided. Cookies and storage are cleared automatically so scenarios start from a clean state.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Scenario name in past tense, e.g. "logged in with valid credentials".' },
        category: { type: 'string', enum: ['happy', 'negative', 'edge', 'a11y'] },
        feature: {
          type: 'string',
          description: 'Short lowercase kebab-case feature tag (e.g. "login", "cart", "forgot-password"). Use the feature name from the plan when one was provided.',
        },
      },
      required: ['name', 'category'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the browser to a URL. Waits for the page to finish loading (including SPA hydration when possible).',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description: 'Click an element. Describe it by intent (e.g. "login button") plus any hints you can give.',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        role: { type: 'string', description: 'ARIA role hint, e.g. button, textbox, link.' },
        label: { type: 'string', description: 'Accessible name / label text.' },
        testid: { type: 'string', description: 'data-testid value if visible in DOM.' },
        css: { type: 'string', description: 'Last-resort CSS selector.' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'fill',
    description:
      'Type into a text input or textarea. Resolved through the same selector cascade as click. ' +
      'Prefer the dedicated tool when the control is not a text field: select_option for a <select>, set_checked for a checkbox/radio, set_input_files for a file input. ' +
      'As a safety net, fill detects the real element type and routes to the right action automatically, so a select still gets selectOption, never a broken fill.',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        value: { type: 'string' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
      },
      required: ['intent', 'value'],
    },
  },
  {
    name: 'select_option',
    description:
      'Choose an option in a <select> dropdown. Use this for any <select> element — you cannot fill() a select. ' +
      'Pick exactly one of: optionValue (matches the option\'s underlying value), optionLabel (matches the visible text), or optionIndex (zero-based). ' +
      'Resolve the select through the same hints as click/fill (intent + role/label/testid/css).',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        optionValue: { type: 'string', description: 'Select the option whose value attribute equals this.' },
        optionLabel: { type: 'string', description: 'Select the option whose visible text equals this.' },
        optionIndex: { type: 'number', description: 'Select the option at this zero-based index.' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'set_checked',
    description:
      'Check or uncheck a checkbox or radio button. Use this for input[type=checkbox] and input[type=radio] — fill() does not work on them. ' +
      'checked=true ticks it, checked=false unticks it (radios can only be ticked). Resolved through the same hints as click.',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        checked: { type: 'boolean', description: 'true to check, false to uncheck. Defaults to true.' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'set_input_files',
    description:
      'Upload file(s) to an input[type=file]. Use this for file inputs — fill() does not work on them. ' +
      'Pass files as an array of paths (or a single path string). Resolved through the same hints as click.',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'One or more file paths to upload.' },
        path: { type: 'string', description: 'A single file path (alternative to files).' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'press',
    description: 'Press a keyboard key on a target (e.g. Enter to submit a form).',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        key: { type: 'string' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
      },
      required: ['intent', 'key'],
    },
  },
  {
    name: 'wait',
    description: 'Fixed sleep. Prefer assertions (which auto-wait). Capped at 3000ms.',
    input_schema: {
      type: 'object',
      properties: { ms: { type: 'number' } },
      required: ['ms'],
    },
  },
  {
    name: 'get_dom',
    description:
      'Return a pruned summary of interactive elements (headings, inputs, buttons, links). Each interactive element reports accessible name, role, testid, disabled / required / readonly / value when applicable. Use this to decide the next action.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'assert',
    description:
      'Record an assertion for the current scenario. Use this for the verifiable outcome of the actions you took. ' +
      'Text passed to toHaveURL is treated as a literal substring. ' +
      'For assertions that depend on animation or async state, set timeout to 20000 so Playwright polls until the condition is met. ' +
      'MANDATORY: when an element exposes a semantic ARIA state attribute (aria-valuenow, aria-checked, aria-selected, aria-expanded, aria-pressed), assert that attribute with toHaveAttribute, NOT the displayed text. ' +
      'A progress bar at completion is toHaveAttribute("aria-valuenow", "100"), never toHaveText("100%"). Text is a fallback only when no semantic attribute exists. ' +
      'To prove something is ABSENT (an error cleared, an item deleted, a permission-denied element missing), use toBeHidden, or toHaveCount with count 0. These do NOT require the element to exist — pass the css/testid/role/label/text hint for what should be gone. ' +
      'To assert the CURRENT value of a form field (an input you filled, a textarea, a select), use toHaveValue with the expected value, NOT toHaveAttribute("value", ...). Typed text lives on the value PROPERTY, so toHaveAttribute reads empty; toHaveValue reads the property.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['toBeVisible', 'toBeHidden', 'toHaveText', 'toContainText', 'toHaveURL', 'toHaveCount', 'toHaveAttribute', 'toHaveValue'],
        },
        intent: { type: 'string' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
        text: { type: 'string' },
        pattern: { type: 'string', description: 'URL substring (literal, no regex required).' },
        count: { type: 'number', description: 'Expected match count for toHaveCount. Use 0 to assert the selector matches nothing (absence).' },
        attribute: { type: 'string', description: 'Attribute name for toHaveAttribute (e.g. aria-valuenow, role, aria-label).' },
        value: { type: 'string', description: 'Expected value: the attribute value for toHaveAttribute, or the form-field value for toHaveValue.' },
        timeout: { type: 'number', description: 'Assertion timeout in ms. Use 15000 for any assertion that depends on animation or async state.' },
      },
      required: ['type'],
    },
  },
  {
    name: 'capture',
    description:
      'Read a REAL runtime value off an element and store it in a named variable for a later assert_compare. ' +
      'This is how you test "a value changes" features (a regenerating id, a rotating token, an incrementing counter) WITHOUT inventing a literal: capture the value now, perform an action, then assert_compare how it changed. ' +
      'source="attribute" reads an attribute (pass attribute, e.g. "id" or "aria-valuenow"); source="text" reads the trimmed text; source="count" reads how many elements match. ' +
      'The captured value is whatever the page actually holds at run time. Pair every capture with an assert_compare on the same `name`.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short variable name to store the value under (e.g. "oldId", "startCount"). Reuse it in assert_compare.' },
        source: { type: 'string', enum: ['attribute', 'text', 'count'], description: 'What to read: an attribute value, the element text, or the match count.' },
        attribute: { type: 'string', description: 'Attribute name when source="attribute" (e.g. id, aria-valuenow, data-token).' },
        intent: { type: 'string' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['name', 'source'],
    },
  },
  {
    name: 'assert_compare',
    description:
      'Assert how a value changed relative to one you captured earlier in this scenario. The captured value is the REAL value read from the page, never a literal you invent. ' +
      'relation="changed" (the value is now different — e.g. a regenerated id), "unchanged"/"equal" (it held), "greater"/"less" (numeric move — e.g. a count went up), or "absent" (the OLD value no longer matches any element). ' +
      'For every relation except "absent", pass the SAME element hints you captured from so it re-reads the same place. For "absent" the captured value itself becomes the selector (e.g. the old id), so no element hint is needed. ' +
      'Use this after capture + an action to prove the feature actually did something. A test that cannot tell the value changed is worthless.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The capture variable name to compare against.' },
        relation: { type: 'string', enum: ['changed', 'unchanged', 'equal', 'greater', 'less', 'absent'] },
        attribute: { type: 'string', description: 'Attribute name when the capture read an attribute. Omit for absent (the captured value is matched as-is).' },
        intent: { type: 'string' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['name', 'relation'],
    },
  },
  {
    name: 'wait_for_text',
    description:
      'Poll an element until its trimmed text content equals the expected string. Use for animated or time-varying elements — progress bars, countdown timers, loading spinners, toast messages — where the value changes over time and you cannot know exactly when it will arrive. ' +
      'More reliable than stacking wait() calls followed by assert(toHaveText): those fail when the timing is off by even 100ms. ' +
      'Recorded as a toHaveText assertion with a generous timeout in the emitted spec. ' +
      'Default timeout is 20 000ms; increase for very slow animations.',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        text: { type: 'string', description: 'Expected exact text (trimmed whitespace).' },
        timeoutMs: { type: 'number', description: 'Max wait in ms. Default 20000, max 30000.' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
      },
      required: ['intent', 'text'],
    },
  },
  {
    name: 'assert_freeze',
    description:
      'Verify that an element is no longer changing after an action (e.g. clicking Stop on a progress bar or pausing a timer). ' +
      'Reads the current value, waits a bounded interval, then re-reads and asserts the two readings are equal. ' +
      'This is the only assertion that actually proves the animation stopped — assert(toBeVisible) and a simple assert(toHaveText) on a fixed value would both pass even if the element kept moving. ' +
      'MANDATORY for value widgets: pass attribute="aria-valuenow". In attribute mode the two reads compare the attribute (not the text) AND the frozen value is asserted strictly between aria-valuemin and aria-valuemax — proving the bar stopped mid-progress, not at 0 or 100. ' +
      'Do not depend on catching a specific number mid-animation; this reads whatever value the element settled on. ' +
      'Use after clicking Stop or Pause on any animated element.',
    input_schema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        attribute: { type: 'string', description: 'Semantic attribute to compare across the two reads (e.g. "aria-valuenow"). MANDATORY for value widgets. Omit only for elements with no semantic state attribute, where the text is compared instead.' },
        waitMs: { type: 'number', description: 'Wait between the two reads, in ms. Attribute mode is bounded under 1000ms (default 500). Text mode default 1500, max 10000.' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'stability_wait',
    description:
      'A short bounded wait (≤1000ms) placed BETWEEN two reads in a stability-comparison assertion. ' +
      'Use it when you need to verify an animated element has stopped: read the value, call stability_wait, read again, then assert both readings match. ' +
      'The gate ALLOWS this wait because it is between two reads, not before a one-shot assertion. ' +
      'Do NOT use it to let an animation settle before asserting a single value — use wait_for_text or assert_freeze instead.',
    input_schema: {
      type: 'object',
      properties: {
        ms: { type: 'number', description: 'Wait duration in ms. Capped at 1000ms.' },
      },
      required: ['ms'],
    },
  },
  {
    name: 'end_scenario',
    description: 'Finish the current scenario. The scenario must have at least one assert or assert_freeze call.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'finish',
    description:
      'End the entire exploration. Call this once you have covered happy / negative / edge / a11y scenarios for the target.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
] as const;

function pushStep(ctx: ToolContext, step: TraceStep): void {
  if (!ctx.current) throw new Error('No scenario in progress — call begin_scenario first.');
  ctx.current.steps.push(step);
}

async function resolveAndRecord(
  ctx: ToolContext,
  input: ResolveInput,
): Promise<{ record: SelectorRecord; loc: import('@playwright/test').Locator }> {
  let resolved = await resolve(ctx.page, input);
  // If the first pass didn't find anything, the element might still be
  // rendering (the most common case: an error message that just appeared
  // after a failed submit, a modal mid-animation, a lazy-loaded section).
  // Poll the cascade for up to ~1.2s in 200ms intervals so transient
  // elements get caught quickly without ballooning wall-clock time on
  // legitimate negatives. Total added latency in the happy path = 0 (we
  // only wait when the first pass fails).
  if (!resolved) {
    for (let i = 0; i < 6 && !resolved; i++) {
      await new Promise((r) => setTimeout(r, 200));
      resolved = await resolve(ctx.page, input);
    }
  }
  // The selector FAILED TO RESOLVE — the element cannot be found with the hints
  // the model gave. That is always a locator problem, never a real bug, so it is
  // safe to automatically re-resolve against the live page and recover. This is
  // the ONLY place selector recovery happens: an assertion whose value/state is
  // wrong throws from expect() in executeAssertion, never from here, and is
  // never recovered.
  if (!resolved) {
    return await recoverOrFinding(ctx, input);
  }
  return finalizeRecord(ctx, input, resolved);
}

/** Build the SelectorRecord + return the live locator from a successful resolve. */
async function finalizeRecord(
  ctx: ToolContext,
  input: ResolveInput,
  resolved: import('./selectors.js').ResolvedLocator,
): Promise<{ record: SelectorRecord; loc: import('@playwright/test').Locator }> {
  ctx.cascadeStats[resolved.level] = (ctx.cascadeStats[resolved.level] ?? 0) + 1;
  const frameChain = resolved.frameChain && resolved.frameChain.length ? resolved.frameChain : undefined;
  return {
    record: {
      level: resolved.level,
      arg: resolved.arg,
      intent: input.intent,
      ambiguous: resolved.ambiguous || undefined,
      filterText: resolved.filterText,
      frameChain,
      elementKey: await elementKeyFor(resolved.locator, frameChain),
    },
    loc: resolved.locator,
  };
}

/**
 * A selector that failed the normal resolve. Try to RECOVER it: re-resolve
 * against the live page by the semantic intent alone, dropping the specific
 * hints the model gave (a wrong or stale role/label/testid/css can suppress the
 * ladder's semantic match — dropping it lets the element be found a different,
 * stable way). If that succeeds, log a distinct recovery event and continue. If
 * it does not, count the failure; once a selector has failed to recover
 * RECOVERY_CAP times, record it as a finding (never a silent pass) and block
 * further actions until the next scenario, exactly like a capped assertion.
 */
async function recoverOrFinding(
  ctx: ToolContext,
  input: ResolveInput,
): Promise<{ record: SelectorRecord; loc: import('@playwright/test').Locator }> {
  const recovered = await recoverResolve(ctx.page, input);
  if (recovered) {
    const result = await finalizeRecord(ctx, input, recovered);
    const from = describeSelector(input);
    const to = describeResolved(result.record);
    // Only log when the element was genuinely found a DIFFERENT way than asked.
    if (from !== to) {
      ctx.heals.push({ scenario: ctx.current?.name, intent: input.intent, from, to });
    }
    // A recovery repaired the selector, so its failure streak resets.
    ctx._recoveryAttempts.delete(selectorSignature(input));
    return result;
  }

  const sig = selectorSignature(input);
  const attempts = (ctx._recoveryAttempts.get(sig) ?? 0) + 1;
  ctx._recoveryAttempts.set(sig, attempts);
  if (attempts < RECOVERY_CAP) {
    // Recovery budget left. Surface the failure so the model can try different
    // hints; the next failure of the SAME selector increments toward the cap.
    throw new Error(
      `Could not resolve element: ${input.intent} (hints: ${JSON.stringify(input)}). ` +
      `Automatic re-resolution did not find it either. Check the element exists and try different hints.`,
    );
  }

  // Cap reached: the element genuinely cannot be found, even after recovery.
  // Record it as a finding, drop the half-built scenario, and block further
  // actions so the model moves on instead of thrashing the same dead selector.
  const url = safeUrl(ctx.page);
  const scenarioName = ctx.current?.name ?? '(unnamed scenario)';
  const from = describeSelector(input);
  ctx.findings.push({
    scenario: scenarioName,
    category: ctx.current?.category,
    expected: `locate element: ${input.intent}`,
    url,
    messages: [`Selector could not be resolved or recovered after ${RECOVERY_CAP} attempts (${from}).`],
  });
  ctx.current = null;
  ctx.captures.clear();
  ctx._blockUntilNewScenario = true;
  throw new LocatorFindingError(
    `Element "${input.intent}" could not be found or recovered after ${RECOVERY_CAP} attempts (${from}). ` +
    `This is now the recorded result for this scenario. Do NOT retry that selector. Call begin_scenario ` +
    `for a DIFFERENT planned scenario, or finish() if none remain.`,
  );
}

/** Stable signature of the selector the model asked for, for recovery-attempt counting. */
function selectorSignature(input: ResolveInput): string {
  return [
    input.role ?? '', input.label ?? '', input.testid ?? '',
    input.css ?? '', input.text ?? '', input.intent ?? '',
  ].join('|');
}

/** Human-readable description of the selector the model asked for (the "from" of a recovery). */
function describeSelector(input: ResolveInput): string {
  if (input.css && input.css.trim()) return `css=${input.css.trim()}`;
  if (input.testid && input.testid.trim()) return `testid=${input.testid.trim()}`;
  if (input.role && input.role.trim()) {
    const name = input.label ?? input.intent;
    return name ? `role=${input.role.trim()}[name=${name}]` : `role=${input.role.trim()}`;
  }
  if (input.label && input.label.trim()) return `label=${input.label.trim()}`;
  if (input.text && input.text.trim()) return `text=${input.text.trim()}`;
  return `intent=${input.intent}`;
}

/** Human-readable description of what a record re-resolved to (the "to" of a recovery). */
function describeResolved(record: SelectorRecord): string {
  const arg = typeof record.arg === 'string' ? record.arg : JSON.stringify(record.arg);
  const base = `${record.level}=${arg}`;
  return record.frameChain && record.frameChain.length ? `${base} @${record.frameChain.join(' >> ')}` : base;
}

/**
 * Stable identity of the resolved DOM element: its frame chain plus a structural
 * path (tag + id/name + sibling index) from the frame root down to the element,
 * read off the live element. This is the per-fill key a toHaveValue assertion
 * binds by. It is derived from the element itself, NOT from the cascade tier or
 * the intent string, so the SAME physical field yields the SAME key however it
 * was located, and two DIFFERENT fields always yield different keys (their DOM
 * paths or frames differ). The resolver hands us a single-element locator
 * (ambiguous matches are already `.first()`-wrapped), so evaluate is safe.
 * Returns undefined if the element cannot be read; the caller then leaves
 * elementKey unset and the assertion keeps the model's value rather than guess.
 */
async function elementKeyFor(
  loc: import('@playwright/test').Locator,
  frameChain: string[] | undefined,
): Promise<string | undefined> {
  let path: string | null;
  try {
    path = await loc.evaluate((el) => {
      const parts: string[] = [];
      let node: Element | null = el as Element;
      while (node && node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        const parent: Element | null = node.parentElement;
        let idx = 0;
        if (parent) {
          // index among same-tag siblings: stable and independent of unrelated
          // siblings appearing or leaving elsewhere in the parent.
          const kids = parent.children;
          for (let i = 0; i < kids.length; i++) {
            const k = kids[i];
            if (k === node) break;
            if (k && k.tagName === node.tagName) idx++;
          }
        }
        const id = (node as HTMLElement).id ? '#' + (node as HTMLElement).id : '';
        const nameAttr = node.getAttribute('name');
        const nm = nameAttr ? '@' + nameAttr : '';
        parts.unshift(`${tag}${id}${nm}[${idx}]`);
        if (tag === 'html') break;
        node = parent;
      }
      return parts.join('>');
    });
  } catch {
    return undefined;
  }
  if (!path) return undefined;
  const frame = frameChain && frameChain.length ? frameChain.join(' >> ') : '';
  return `${frame}|${path}`;
}

/**
 * Read the real form-control type off a resolved element so the right action is
 * chosen: a <select> needs selectOption, a checkbox/radio needs check/uncheck,
 * a file input needs setInputFiles, everything else fills. The shim installed by
 * installEvalShim makes this evaluate body safe under tsx.
 */
async function controlKind(
  loc: import('@playwright/test').Locator,
): Promise<'select' | 'checkbox' | 'radio' | 'file' | 'textarea' | 'text' | 'other'> {
  try {
    return await loc.evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') return 'select';
      if (tag === 'textarea') return 'textarea';
      if (tag === 'input') {
        const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'file') return 'file';
        return 'text';
      }
      return 'other';
    });
  } catch {
    // If the element vanished or the page navigated mid-detect, fall back to a
    // plain fill rather than guessing — the caller's try/catch handles failures.
    return 'other';
  }
}

/** Current page URL, or '' if the page is closed/navigating. Used for detection. */
function safeUrl(page: Page): string {
  try { return page.url(); } catch { return ''; }
}

/** Coerce a fill value into a check/uncheck intent for a checkbox. */
function isTruthyCheck(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === '') return true; // bare "check this box" with no value means check it
  return !['false', '0', 'no', 'off', 'unchecked', 'uncheck'].includes(v);
}

/** Apply a selectOption in the mode the step recorded. */
async function selectByMode(
  loc: import('@playwright/test').Locator,
  by: 'value' | 'label' | 'index' | 'auto',
  option: string,
): Promise<void> {
  if (by === 'value') await loc.selectOption({ value: option });
  else if (by === 'label') await loc.selectOption({ label: option });
  else if (by === 'index') await loc.selectOption({ index: Number(option) });
  else await loc.selectOption(option); // 'auto' — Playwright matches value or label
}

/**
 * Build a SelectorRecord straight from the caller's hints, WITHOUT resolving
 * it to a present element. This is the path absence assertions need: you
 * cannot resolve an element you are trying to prove is gone. The locator
 * ladder is unchanged — this just picks the most specific hint and records it
 * verbatim. Most absence checks pass a `css` id (a hardcoded static selector
 * that should now match nothing). Throws only when no usable hint is given.
 */
function recordFromHints(input: {
  intent?: string;
  role?: string;
  label?: string;
  testid?: string;
  css?: string;
  text?: string;
}): SelectorRecord {
  const intent = input.intent ?? 'element';
  // Most specific first: explicit css/xpath, then testid, then role(+name),
  // then label, then visible text. Mirrors the cascade's notion of specificity
  // without running it against the live DOM.
  if (input.css && input.css.trim()) {
    const css = input.css.trim();
    // A ">>>" piercing selector targets a frame element — split the iframe
    // chain off so the record scopes into the frame instead of failing.
    const pierced = parsePiercingSelector(css);
    if (pierced) {
      const inner = pierced.innerCss;
      const isXpathInner = inner.startsWith('//') || inner.startsWith('./') || inner.startsWith('(');
      return {
        level: isXpathInner ? 'xpath' : 'css',
        arg: isXpathInner ? inner.replace(/^xpath=/, '') : inner,
        intent,
        frameChain: pierced.frameChain,
      };
    }
    const isXpath = css.startsWith('//') || css.startsWith('./') || css.startsWith('(');
    return { level: isXpath ? 'xpath' : 'css', arg: isXpath ? css.replace(/^xpath=/, '') : css, intent };
  }
  if (input.testid && input.testid.trim()) {
    return { level: 'testid', arg: input.testid.trim(), intent };
  }
  if (input.role && input.role.trim()) {
    const name = input.label && input.label.trim() ? input.label.trim() : undefined;
    return { level: 'role', arg: name ? { role: input.role.trim(), name } : { role: input.role.trim() }, intent };
  }
  if (input.label && input.label.trim()) {
    return { level: 'label', arg: input.label.trim(), intent };
  }
  if (input.text && input.text.trim()) {
    return { level: 'text', arg: input.text.trim(), intent };
  }
  throw new Error(
    `Absence assertion needs a locator hint (css, testid, role, label, or text). Got: ${JSON.stringify(input)}`,
  );
}

/** Make a string safe to use as a JS identifier in the emitted spec. */
function sanitizeIdent(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_$]/g, '_')
    .replace(/^([0-9])/, '_$1')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return cleaned || 'captured';
}

/**
 * Return an identifier that does not collide with any capture varName or
 * assert_compare readVar already used in the current scenario, so the emitted
 * spec never redeclares a const.
 */
function claimIdent(ctx: ToolContext, base: string): string {
  const used = new Set<string>();
  for (const e of ctx.captures.values()) used.add(e.varName);
  if (ctx.current) {
    for (const s of ctx.current.steps) {
      if (s.kind === 'capture') used.add(s.varName);
      else if (s.kind === 'assert_compare') { used.add(s.varName); used.add(s.readVar); }
    }
  }
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

function cssEscapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Locator that matches any element still carrying a captured value — used by
 * the 'absent' relation to prove the old value is gone. For an attribute
 * capture this is a value selector (e.g. [id="<captured>"]); for a text
 * capture it is an exact-text locator.
 */
function absenceLocator(page: Page, entry: CaptureEntry) {
  if (entry.source === 'attribute' && entry.attribute) {
    return page.locator(`[${entry.attribute}="${cssEscapeValue(entry.value)}"]`);
  }
  return page.getByText(entry.value, { exact: true });
}

async function readBySource(page: Page, entry: CaptureEntry): Promise<string> {
  if (entry.source === 'count') {
    return String(await baseLocator(page, entry.target).count());
  }
  const loc = baseLocator(page, entry.target).first();
  if (entry.source === 'attribute') return (await loc.getAttribute(entry.attribute!))?.trim() ?? '';
  return (await loc.textContent())?.trim() ?? '';
}

function relationHolds(relation: CompareRelation, captured: string, current: string): boolean {
  switch (relation) {
    case 'changed': return current !== captured;
    case 'unchanged':
    case 'equal': return current === captured;
    case 'greater':
      return Number.isFinite(Number(current)) && Number.isFinite(Number(captured)) && Number(current) > Number(captured);
    case 'less':
      return Number.isFinite(Number(current)) && Number.isFinite(Number(captured)) && Number(current) < Number(captured);
    case 'absent':
      return false; // handled separately via absenceLocator
  }
}

/**
 * Re-read the captured element and check the relation holds, polling briefly so
 * an async update has time to land. Gives the Explorer immediate feedback if a
 * compare can never hold.
 */
async function pollRelation(
  page: Page,
  entry: CaptureEntry,
  relation: CompareRelation,
  budgetMs: number,
): Promise<{ held: boolean; current: string }> {
  const deadline = Date.now() + budgetMs;
  let current = '';
  for (;;) {
    current = await readBySource(page, entry);
    if (relationHolds(relation, entry.value, current)) return { held: true, current };
    if (Date.now() >= deadline) return { held: false, current };
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function isolateState(page: Page): Promise<void> {
  try { await page.context().clearCookies(); } catch { /* noop */ }
  try {
    await page.evaluate(() => {
      try { localStorage.clear(); } catch { /* cross-origin */ }
      try { sessionStorage.clear(); } catch { /* cross-origin */ }
    });
  } catch { /* about:blank or no origin yet */ }
}

export async function runTool(ctx: ToolContext, call: ToolInput): Promise<ToolResult> {
  ctx.steps++;
  // finish() is the clean exit and must ALWAYS be allowed through. If the step
  // budget also blocks finish, the model is told "call finish() now" but every
  // finish call is rejected, so it spins on full-context (expensive) no-op turns
  // until the cost ceiling aborts the whole run with zero output, losing any
  // findings recorded along the way. Let finish run regardless of the budget.
  //
  // Close-out grace. A scenario that has already done its expensive work (filled
  // a long form, submitted, navigated) and only needs to ASSERT the outcome and
  // end_scenario should not be thrown away for want of one or two cheap closing
  // steps. A 12-field registration form spends 12 steps on fills alone, so two
  // full-form scenarios can legitimately run a 3-scenario plan to the budget line
  // right as the last scenario reaches its assertion. Give the CURRENT scenario's
  // closing calls a small grace past the budget so that spent work is salvaged.
  // This does NOT widen the budget for new work: begin_scenario and every action
  // tool stay blocked, so the model cannot start a scenario or re-fill a form. It
  // can only finish closing the one already in progress, and only for a few
  // steps, so the grace can never fit another scenario.
  const isClosingCall =
    call.name === 'assert' ||
    call.name === 'assert_compare' ||
    call.name === 'capture' ||
    call.name === 'end_scenario';
  const withinCloseoutGrace =
    ctx.current != null && isClosingCall && ctx.steps <= ctx.maxSteps + CLOSEOUT_GRACE;
  if (ctx.steps > ctx.maxSteps && call.name !== 'finish' && !withinCloseoutGrace) {
    return { ok: false, error: `Step budget exceeded (${ctx.maxSteps}). Call finish() now.` };
  }
  // Retry-cap block. The previous scenario hit OUTCOME_RETRY_CAP and was recorded
  // as a finding. Reject everything except starting the next scenario or
  // finishing, so the model cannot re-fill the form and thrash on the same wrong
  // success signal. Cheap rejection: no page action runs.
  if (ctx._blockUntilNewScenario && call.name !== 'begin_scenario' && call.name !== 'finish') {
    return {
      ok: false,
      error:
        'The previous scenario was recorded as a finding (its expected outcome never occurred). ' +
        'Do not retry that action or re-fill the form. Call begin_scenario for the next planned ' +
        'scenario, or finish() if there are no more.',
    };
  }
  try {
    switch (call.name) {
      case 'begin_scenario': {
        const name = String(call.input.name ?? '').trim();
        const category = String(call.input.category ?? 'happy') as Scenario['category'];
        const rawFeature = call.input.feature == null ? '' : String(call.input.feature).trim();
        const feature = rawFeature
          ? rawFeature.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
          : undefined;
        if (!name) return { ok: false, error: 'Scenario name required.' };
        if (ctx.current) return { ok: false, error: 'A scenario is already in progress.' };
        await isolateState(ctx.page);
        ctx.consoleErrors = [];
        ctx.networkErrors = [];
        ctx.captures.clear();
        // Do NOT clear _assertFailures here. The count of how many times a given
        // outcome assertion has failed must survive a scenario restart, otherwise
        // a happy path that keeps not redirecting resets to zero on every restart
        // and the retry cap never trips. Counts are cleared only when that exact
        // assertion finally passes (see assertWithRetryCap).
        ctx._blockUntilNewScenario = false;
        ctx.current = feature ? { name, category, feature, steps: [] } : { name, category, steps: [] };
        return { ok: true, data: { name, category, feature } };
      }
      case 'navigate': {
        const url = String(call.input.url ?? '');
        if (!/^https?:\/\//.test(url)) return { ok: false, error: 'navigate requires an http(s) URL.' };
        await ctx.page.goto(url, { waitUntil: 'load' });
        ctx.lastActionAt = Date.now();
        if (ctx.current) pushStep(ctx, { kind: 'navigate', url });
        return { ok: true, data: { url: ctx.page.url() } };
      }
      case 'click': {
        const { record, loc } = await resolveAndRecord(ctx, call.input as never);
        await loc.click();
        ctx.lastActionAt = Date.now();
        pushStep(ctx, { kind: 'click', target: record });
        return { ok: true, data: { clicked: record.intent, ambiguous: record.ambiguous ?? false } };
      }
      case 'fill': {
        const value = String(call.input.value ?? '');
        const { record, loc } = await resolveAndRecord(ctx, call.input as never);
        // Detect the real control type before acting. fill() throws "Element is
        // not an <input>" on a <select>, and silently no-ops nothing useful on a
        // checkbox. Route each control to the action Playwright supports, and
        // record the matching step so the emitted spec is correct too.
        const kind = await controlKind(loc);
        if (kind === 'select') {
          await loc.selectOption(value);
          ctx.lastActionAt = Date.now();
          pushStep(ctx, { kind: 'select_option', target: record, by: 'auto', option: value });
          return { ok: true, data: { selected: record.intent, option: value, autoDispatched: 'select_option' } };
        }
        if (kind === 'checkbox' || kind === 'radio') {
          // A radio can only be checked. A checkbox follows the value's intent.
          const want = kind === 'radio' ? true : isTruthyCheck(value);
          if (want) await loc.check(); else await loc.uncheck();
          ctx.lastActionAt = Date.now();
          pushStep(ctx, { kind: 'set_checked', target: record, checked: want });
          return { ok: true, data: { checked: want, on: record.intent, autoDispatched: 'set_checked' } };
        }
        if (kind === 'file') {
          const files = value.split(/\s*,\s*/).map((f) => f.trim()).filter(Boolean);
          await loc.setInputFiles(files);
          ctx.lastActionAt = Date.now();
          pushStep(ctx, { kind: 'set_input_files', target: record, files });
          return { ok: true, data: { files, on: record.intent, autoDispatched: 'set_input_files' } };
        }
        // If this field feeds a uniqueness constraint (a registration email, a
        // unique username), fill a generated value so the creation flow really
        // succeeds AND survives re-running. A fixed email would pass exploration
        // then fail replay on a duplicate. The same generator runs in replay and
        // in the emitted spec, so the value is fresh on every run.
        const ci = call.input as { intent?: unknown; testid?: unknown; label?: unknown; role?: unknown; css?: unknown; placeholder?: unknown };
        const fieldHint = [ci.intent, ci.testid, ci.label, ci.role, ci.css, ci.placeholder, record.intent]
          .filter((x) => typeof x === 'string').join(' ');
        const flowHint = [ctx.current?.feature, ctx.current?.name, safeUrl(ctx.page)]
          .filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ');
        const generate = detectUniqueField({ category: ctx.current?.category, flowHint, fieldHint });
        const filledValue = generate ? generateUnique(generate) : value;
        await loc.fill(filledValue);
        ctx.lastActionAt = Date.now();
        pushStep(ctx, generate
          ? { kind: 'fill', target: record, value: filledValue, generate }
          : { kind: 'fill', target: record, value: filledValue });
        return { ok: true, data: { filled: record.intent, generated: generate ?? undefined } };
      }
      case 'select_option': {
        const { record, loc } = await resolveAndRecord(ctx, call.input as never);
        const hasValue = typeof call.input.optionValue === 'string' && call.input.optionValue.trim() !== '';
        const hasLabel = typeof call.input.optionLabel === 'string' && call.input.optionLabel.trim() !== '';
        const hasIndex = typeof call.input.optionIndex === 'number' && Number.isFinite(call.input.optionIndex);
        let by: 'value' | 'label' | 'index';
        let option: string;
        if (hasValue) { by = 'value'; option = String(call.input.optionValue).trim(); }
        else if (hasLabel) { by = 'label'; option = String(call.input.optionLabel).trim(); }
        else if (hasIndex) { by = 'index'; option = String(call.input.optionIndex); }
        else return { ok: false, error: 'select_option needs one of optionValue, optionLabel, or optionIndex.' };
        await selectByMode(loc, by, option);
        ctx.lastActionAt = Date.now();
        pushStep(ctx, { kind: 'select_option', target: record, by, option });
        return { ok: true, data: { selected: record.intent, by, option } };
      }
      case 'set_checked': {
        const { record, loc } = await resolveAndRecord(ctx, call.input as never);
        const checked = call.input.checked === undefined ? true : call.input.checked === true;
        if (checked) await loc.check(); else await loc.uncheck();
        ctx.lastActionAt = Date.now();
        pushStep(ctx, { kind: 'set_checked', target: record, checked });
        return { ok: true, data: { checked, on: record.intent } };
      }
      case 'set_input_files': {
        const raw = Array.isArray(call.input.files)
          ? (call.input.files as unknown[]).map((f) => String(f))
          : typeof call.input.path === 'string'
            ? [call.input.path]
            : [];
        const files = raw.map((f) => f.trim()).filter(Boolean);
        if (files.length === 0) return { ok: false, error: 'set_input_files needs files (array) or path (string).' };
        const { record, loc } = await resolveAndRecord(ctx, call.input as never);
        await loc.setInputFiles(files);
        ctx.lastActionAt = Date.now();
        pushStep(ctx, { kind: 'set_input_files', target: record, files });
        return { ok: true, data: { files, on: record.intent } };
      }
      case 'press': {
        const key = String(call.input.key ?? '');
        const { record, loc } = await resolveAndRecord(ctx, call.input as never);
        await loc.press(key);
        ctx.lastActionAt = Date.now();
        pushStep(ctx, { kind: 'press', target: record, key });
        return { ok: true, data: { pressed: key, on: record.intent } };
      }
      case 'stability_wait': {
        const swMs = Math.min(Math.max(0, Number(call.input.ms ?? 500)), 1000);
        await ctx.page.waitForTimeout(swMs);
        if (ctx.current) pushStep(ctx, { kind: 'stability_wait', ms: swMs });
        return { ok: true, data: { waited: swMs } };
      }
      case 'wait': {
        // A recorded hard sleep inside a scenario is ALWAYS rejected by the gate
        // (RULE 1) at end_scenario, which forces a full restart and re-fill of the
        // whole form. That restart is one of the biggest cost sinks in a run. Fail
        // the call up front so the model never builds a scenario around sleeps and
        // never pays for the restart. Steer it to the polling primitives that the
        // gate actually accepts. Outside a scenario (orientation/settling) a short
        // wait is harmless and is allowed.
        if (ctx.current) {
          return {
            ok: false,
            error: 'wait() records a hard sleep, which the gate rejects at end_scenario and forces a full restart. Do not sleep inside a scenario. To wait for the page to change, call wait_for_text with the text you expect, or call assert with an explicit timeout (Playwright auto-retries until it passes or times out). To just re-read the page now, call get_dom directly.',
          };
        }
        const ms = Math.min(Math.max(0, Number(call.input.ms ?? 0)), 3000);
        await ctx.page.waitForTimeout(ms);
        return { ok: true, data: { waited: ms } };
      }
      case 'get_dom': {
        const summary = await summarizeDom(ctx.page);
        return { ok: true, data: summary };
      }
      case 'capture': {
        const name = String(call.input.name ?? '').trim();
        if (!name) return { ok: false, error: 'capture needs a name.' };
        if (!ctx.current) return { ok: false, error: 'No scenario in progress — call begin_scenario first.' };
        const source = String(call.input.source ?? '') as CaptureSource;
        if (source !== 'attribute' && source !== 'text' && source !== 'count') {
          return { ok: false, error: 'capture source must be attribute, text, or count.' };
        }
        const attribute = typeof call.input.attribute === 'string' && call.input.attribute.trim()
          ? String(call.input.attribute).trim()
          : undefined;
        if (source === 'attribute' && !attribute) {
          return { ok: false, error: 'capture with source="attribute" needs an attribute name (e.g. "id").' };
        }
        let record: SelectorRecord;
        let value: string;
        if (source === 'count') {
          // Count reads the multi-match locator, so build it from hints without
          // forcing a single resolve — a count of 0, 1, or N are all valid.
          record = recordFromHints({ ...(call.input as object), intent: String(call.input.intent ?? 'elements') });
          value = String(await baseLocator(ctx.page, record).count());
        } else {
          const resolved = await resolveAndRecord(ctx, {
            intent: String(call.input.intent ?? 'element'),
            role: call.input.role as string | undefined,
            label: call.input.label as string | undefined,
            testid: call.input.testid as string | undefined,
            css: call.input.css as string | undefined,
            text: call.input.text as string | undefined,
          });
          record = resolved.record;
          value = source === 'attribute'
            ? (await resolved.loc.getAttribute(attribute!))?.trim() ?? ''
            : (await resolved.loc.textContent())?.trim() ?? '';
        }
        const varName = claimIdent(ctx, 'cap_' + sanitizeIdent(name));
        ctx.captures.set(name, { varName, source, target: record, attribute, value });
        pushStep(ctx, { kind: 'capture', varName, source, target: record, attribute, intent: record.intent });
        return { ok: true, data: { name, source, value } };
      }
      case 'assert_compare': {
        const name = String(call.input.name ?? '').trim();
        const entry = ctx.captures.get(name);
        if (!entry) {
          return { ok: false, error: `No capture named "${name}" in this scenario. Call capture with that name first.` };
        }
        const relation = String(call.input.relation ?? '') as CompareRelation;
        if (!['changed', 'unchanged', 'equal', 'greater', 'less', 'absent'].includes(relation)) {
          return { ok: false, error: 'assert_compare relation must be changed, unchanged, equal, greater, less, or absent.' };
        }
        const readVar = claimIdent(ctx, entry.varName + '_now');

        if (relation === 'absent') {
          // The captured value itself is the selector now: prove no element
          // still carries it. This is the regenerating-id case — the old id
          // must be gone after the action.
          const loc = absenceLocator(ctx.page, entry);
          try {
            await expect(loc).toHaveCount(0, { timeout: 5000 });
          } catch {
            return { ok: false, error: `assert_compare(absent): the captured value "${entry.value}" still matches an element — it did not change.` };
          }
        } else {
          // Re-read the same element the same way, polling briefly so an async
          // update has time to land, then verify the relation live.
          const ok = await pollRelation(ctx.page, entry, relation, 5000);
          if (!ok.held) {
            return { ok: false, error: `assert_compare(${relation}): captured "${entry.value}", now "${ok.current}" — relation does not hold.` };
          }
        }
        const bounds = undefined; // bounds are only set by the refactored assert_freeze path
        pushStep(ctx, {
          kind: 'assert_compare',
          varName: entry.varName,
          relation,
          source: entry.source,
          target: entry.target,
          attribute: entry.attribute,
          intent: entry.target.intent,
          readVar,
          bounds,
        });
        return { ok: true, data: { name, relation } };
      }
      case 'assert': {
        return await assertWithRetryCap(ctx, call.input as never);
      }
      case 'wait_for_text': {
        const wftText = String(call.input.text ?? '');
        // Live polling budget — how long the Explorer waits for the page to
        // reach the target state. Capped at the adaptive ceiling so a slow but
        // real operation can be observed in full. This budget is NOT recorded;
        // the recorded timeout is derived from the OBSERVED settle time below.
        const wftBudget = Math.min(Math.max(1000, Number(call.input.timeoutMs ?? 15000)), ADAPTIVE_CEILING_MS);
        // Strip `text` from the selector hints — it is the expected value to poll for,
        // not a getByText() hint. Passing it would cause the cascade to look for an
        // element that already has that text, failing when the animation hasn't arrived yet.
        const { text: _wftExpected, timeoutMs: _wftMs, ...wftSelectorHints } = call.input as Record<string, unknown>;
        const { record: wftRecord, loc: wftLoc } = await resolveAndRecord(ctx, wftSelectorHints as never);
        const wftStart = Date.now();
        let wftMatched = false;
        while (Date.now() - wftStart < wftBudget) {
          const txt = (await wftLoc.textContent())?.trim() ?? '';
          if (txt === wftText) { wftMatched = true; break; }
          await new Promise(r => setTimeout(r, 150));
        }
        if (!wftMatched) {
          const finalTxt = (await wftLoc.textContent())?.trim() ?? '';
          throw new Error(
            `wait_for_text: "${wftRecord.intent}" never showed "${wftText}" within ${wftBudget}ms (last value: "${finalTxt}")`
          );
        }
        // Adaptive timeout: budget the duration the page actually took to reach
        // the target state plus a 50 percent margin. Comes from the page, not a
        // constant. See adaptive-timeout.ts.
        const wftObserved = observedSettleMs(ctx, wftStart);
        const wftTimeout = adaptiveTimeout(wftObserved);
        // Prefer a semantic ARIA state attribute over the displayed text when
        // the element exposes one. The attribute is what assistive tech reads
        // and it does not depend on display formatting (a bar can show "100%"
        // while exposing aria-valuenow="100"). Text is the fallback only. The
        // value is read live off the element, never a constant. See
        // aria-assertion.ts.
        const wftAttrs: Record<string, string | null> = {};
        for (const name of SEMANTIC_STATE_ATTRS) {
          wftAttrs[name] = await wftLoc.getAttribute(name);
        }
        const wftChoice = chooseStateAssertion(wftAttrs, wftText);
        if (wftChoice.kind === 'attribute' && wftChoice.attribute && wftChoice.value != null) {
          pushStep(ctx, {
            kind: 'assert',
            name: `${wftRecord.intent} reaches ${wftChoice.attribute}="${wftChoice.value}"`,
            assertion: {
              type: 'toHaveAttribute',
              target: wftRecord,
              attribute: wftChoice.attribute,
              value: wftChoice.value,
              timeout: wftTimeout,
            },
          });
          return {
            ok: true,
            data: { attribute: wftChoice.attribute, value: wftChoice.value, observedMs: wftObserved, timeout: wftTimeout },
          };
        }
        pushStep(ctx, {
          kind: 'assert',
          name: `${wftRecord.intent} eventually shows "${wftText}"`,
          assertion: { type: 'toHaveText', target: wftRecord, text: wftText, timeout: wftTimeout },
        });
        return { ok: true, data: { text: wftText, observedMs: wftObserved, timeout: wftTimeout } };
      }
      case 'assert_freeze': {
        const afAttr =
          typeof call.input.attribute === 'string' && call.input.attribute.trim()
            ? String(call.input.attribute).trim()
            : undefined;
        const { record: afRecord, loc: afLoc } = await resolveAndRecord(ctx, call.input as never);
        // assert_freeze is now a thin front-end over capture-and-compare: it
        // captures the value, waits a bounded interval, then asserts the value
        // is UNCHANGED. The live read/wait/re-read below gives the Explorer
        // immediate feedback; the recorded steps are the same general primitive
        // every other compare uses — one mechanism, not two.
        const fzVar = claimIdent(ctx, 'cap_' + sanitizeIdent(afRecord.intent || 'frozen'));
        const fzReadVar = claimIdent(ctx, fzVar + '_again');

        if (afAttr) {
          // Attribute (semantic state) mode. The wait is a bounded interval
          // under 1000ms between two reads — comparing two samples, not letting
          // an animation settle. Read the attribute, wait, re-read, assert equal.
          const afWaitMs = Math.min(Math.max(200, Number(call.input.waitMs ?? 500)), 1000);
          const read1 = (await afLoc.getAttribute(afAttr))?.trim() ?? '';
          await ctx.page.waitForTimeout(afWaitMs);
          const read2 = (await afLoc.getAttribute(afAttr))?.trim() ?? '';
          if (read2 !== read1) {
            throw new Error(
              `assert_freeze: "${afRecord.intent}" ${afAttr} changed from "${read1}" to "${read2}" — element is not frozen`
            );
          }
          // For aria-valuenow, also assert the frozen value is strictly between
          // aria-valuemin and aria-valuemax — proves it stopped mid-progress,
          // not at the floor or the ceiling.
          let bounds: { min: string; max: string } | undefined;
          if (afAttr === VALUE_NOW_ATTR) {
            const minRaw = (await afLoc.getAttribute(VALUE_MIN_ATTR))?.trim() ?? '';
            const maxRaw = (await afLoc.getAttribute(VALUE_MAX_ATTR))?.trim() ?? '';
            const n = Number(read2);
            const min = Number(minRaw);
            const max = Number(maxRaw);
            if (!Number.isFinite(n) || !Number.isFinite(min) || !Number.isFinite(max) || !(n > min && n < max)) {
              throw new Error(
                `assert_freeze: "${afRecord.intent}" ${afAttr}="${read2}" is not strictly between ${VALUE_MIN_ATTR}="${minRaw}" and ${VALUE_MAX_ATTR}="${maxRaw}"`
              );
            }
            bounds = { min: VALUE_MIN_ATTR, max: VALUE_MAX_ATTR };
          }
          ctx.captures.set(fzVar, { varName: fzVar, source: 'attribute', target: afRecord, attribute: afAttr, value: read1 });
          pushStep(ctx, { kind: 'capture', varName: fzVar, source: 'attribute', target: afRecord, attribute: afAttr, intent: afRecord.intent });
          pushStep(ctx, { kind: 'stability_wait', ms: afWaitMs });
          pushStep(ctx, {
            kind: 'assert_compare',
            varName: fzVar,
            relation: 'unchanged',
            source: 'attribute',
            target: afRecord,
            attribute: afAttr,
            intent: afRecord.intent,
            readVar: fzReadVar,
            bounds,
          });
          return { ok: true, data: { frozen: read2, attribute: afAttr } };
        }

        // Text mode (no semantic attribute on the element). Longer stabilization
        // wait between the two reads of textContent.
        const afWaitMs = Math.min(Math.max(500, Number(call.input.waitMs ?? 1500)), 10000);
        const capturedText = (await afLoc.textContent())?.trim() ?? '';
        await ctx.page.waitForTimeout(afWaitMs);
        const afterText = (await afLoc.textContent())?.trim() ?? '';
        if (afterText !== capturedText) {
          throw new Error(
            `assert_freeze: "${afRecord.intent}" changed from "${capturedText}" to "${afterText}" — element is not frozen`
          );
        }
        ctx.captures.set(fzVar, { varName: fzVar, source: 'text', target: afRecord, value: capturedText });
        pushStep(ctx, { kind: 'capture', varName: fzVar, source: 'text', target: afRecord, intent: afRecord.intent });
        pushStep(ctx, { kind: 'stability_wait', ms: afWaitMs });
        pushStep(ctx, {
          kind: 'assert_compare',
          varName: fzVar,
          relation: 'unchanged',
          source: 'text',
          target: afRecord,
          intent: afRecord.intent,
          readVar: fzReadVar,
        });
        return { ok: true, data: { frozen: capturedText } };
      }
      case 'end_scenario': {
        if (!ctx.current) return { ok: false, error: 'No scenario to end.' };
        if (!ctx.current.steps.some((s) => s.kind === 'assert' || s.kind === 'assert_compare')) {
          return { ok: false, error: 'Scenario has no assertions. Add at least one assert, assert_compare, or assert_freeze before end_scenario.' };
        }

        const gateResult = runGate(ctx.current);

        if (gateResult.violations.length > 0) {
          const scenarioName = ctx.current.name;
          const attempts = (ctx._gateAttempts.get(scenarioName) ?? 0) + 1;
          ctx._gateAttempts.set(scenarioName, attempts);
          ctx.current = null; // abandon — Explorer can call begin_scenario again
          const firstV = gateResult.violations[0]!;
          const ruleLabel = firstV.rule === 1 ? 'RULE 1 (no hard sleeps)' : firstV.rule === 3 ? 'RULE 3 (no CSS on animated elements)' : 'RULE 4 (intermediate value on animated element)';
          const details = gateResult.violations.map((v) => v.detail).join('; ');
          if (attempts >= 2) {
            const reason = firstV.rule === 1
              ? 'could not generate without hard sleep'
              : firstV.rule === 3
                ? 'unstable locator on dynamic element'
                : 'intermediate value assertion on animated element';
            ctx.brokenByGate.push({ scenario: scenarioName, reason, attempts });
            return {
              ok: false,
              error: `Gate BROKEN after ${attempts} attempts (${ruleLabel}): ${details}. This scenario is permanently dropped — move on to the next scenario.`,
            };
          }
          return {
            ok: false,
            error: `Gate REJECTED attempt ${attempts}/2 (${ruleLabel}): ${details}. Fix the violation and restart with begin_scenario.`,
          };
        }

        // Gate passed — record injections (mutations already applied in-place)
        for (const inj of gateResult.injections) {
          ctx._gateInjectionLog.push({
            scenario: ctx.current.name,
            stepIndex: inj.stepIndex,
            assertionType: inj.assertionType,
            detail: inj.detail,
          });
        }

        if (ctx.consoleErrors.length) ctx.current.consoleErrors = [...ctx.consoleErrors];
        if (ctx.networkErrors.length) ctx.current.networkErrors = [...ctx.networkErrors];
        ctx.scenarios.push(ctx.current);
        ctx.current = null;
        return {
          ok: true,
          data: {
            scenariosSoFar: ctx.scenarios.length,
            gateInjections: gateResult.injections.length,
            consoleErrors: ctx.consoleErrors.length,
            networkErrors: ctx.networkErrors.length,
          },
        };
      }
      case 'finish': {
        // Lift any retry-cap block so finish always closes the run cleanly.
        ctx._blockUntilNewScenario = false;
        // A scenario in progress when finish() is called is an ABANDONED
        // scenario: the agent gave up mid-flow (network failure, gave up
        // after too many retries, etc.). end_scenario already refuses to
        // close an assertion-less scenario; finish must apply the same rule
        // or we'd emit empty specs that pass replay vacuously.
        let dropped = 0;
        if (ctx.current) {
          const hasAssert = ctx.current.steps.some((s) => s.kind === 'assert' || s.kind === 'assert_compare');
          if (hasAssert) {
            const gateResult = runGate(ctx.current);
            if (gateResult.violations.length > 0) {
              // No retry at finish time — mark immediately BROKEN
              const scenarioName = ctx.current.name;
              const attempts = (ctx._gateAttempts.get(scenarioName) ?? 0) + 1;
              const firstV = gateResult.violations[0]!;
              const reason = firstV.rule === 1
                ? 'could not generate without hard sleep'
                : firstV.rule === 3
                  ? 'unstable locator on dynamic element'
                  : 'intermediate value assertion on animated element';
              ctx.brokenByGate.push({ scenario: scenarioName, reason, attempts });
              dropped = 1;
            } else {
              for (const inj of gateResult.injections) {
                ctx._gateInjectionLog.push({
                  scenario: ctx.current.name,
                  stepIndex: inj.stepIndex,
                  assertionType: inj.assertionType,
                  detail: inj.detail,
                });
              }
              if (ctx.consoleErrors.length) ctx.current.consoleErrors = [...ctx.consoleErrors];
              if (ctx.networkErrors.length) ctx.current.networkErrors = [...ctx.networkErrors];
              ctx.scenarios.push(ctx.current);
            }
          } else {
            dropped = 1;
          }
        }
        ctx.current = null;
        return { ok: true, data: { done: true, scenarios: ctx.scenarios.length, droppedIncomplete: dropped } };
      }
      default:
        return { ok: false, error: `Unknown tool: ${call.name}` };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Observed settle duration for an async assertion: from the triggering action
 * to the moment the target state was confirmed. Anchored to the last
 * state-changing action (ctx.lastActionAt), falling back to the local probe
 * start when that is somehow later. The action always precedes the probe, so
 * this never returns LESS than `now - t0` — it only widens the window to cover
 * an animation that was already running when the assertion was issued.
 */
function observedSettleMs(ctx: ToolContext, probeStart: number): number {
  return Date.now() - Math.min(probeStart, ctx.lastActionAt);
}

/**
 * The value a field was filled with earlier in the same scenario, so a later
 * toHaveValue assertion asserts the EXACT string that was typed rather than a
 * value the model re-supplied (which the ui.vision run got wrong: an unclosed,
 * longer string than what was filled). The recorded fill step is the single
 * source of truth. Matches the most recent fill on the same field, by the
 * resolved locator first, then by canonical intent. Returns null when the field
 * was never filled in this scenario (then the assertion keeps the model value,
 * which is the legitimate "assert a pre-existing value" case).
 */
export function fillValueForTarget(steps: TraceStep[], target: SelectorRecord): string | null {
  // Bind by ONE thing: the element's own stable key (elementKey), read off the
  // live DOM element at resolve time. No intent-string matching, no cascade-tier
  // matching — those are what kept failing, letting a later field's fill leak
  // into an earlier field's assertion. Because the key is the element's identity,
  // the assertion for a field can only ever match a fill on that SAME element:
  // three assertions on three fields have three different keys, so they read
  // three different fills. They collapse to one value ONLY if three fills wrote
  // the same value into the same element. The most recent matching fill wins, so
  // a refilled field asserts its latest value. No key on either side means no
  // bind (a hint-only record, or an element that could not be read) — the
  // assertion keeps the model's value, the legitimate "assert a pre-existing
  // default" path, and still cannot borrow another field's value.
  if (!target.elementKey) return null;
  let bound: string | null = null;
  for (const s of steps) {
    if (s.kind !== 'fill') continue;
    if (s.target.elementKey && s.target.elementKey === target.elementKey) bound = s.value;
  }
  return bound;
}

async function executeAssertion(
  ctx: ToolContext,
  input: {
    type: Assertion['type'];
    intent?: string;
    role?: string;
    label?: string;
    testid?: string;
    css?: string;
    text?: string;
    pattern?: string;
    count?: number;
    attribute?: string;
    value?: string;
    timeout?: number;
  },
): Promise<ToolResult> {
  // Sync assertions (toHaveURL / toHaveCount) keep the caller's timeout, if any.
  const assertTimeout = input.timeout ? { timeout: input.timeout } : undefined;
  // Async assertions measure how long the page takes to settle and record an
  // adaptive timeout from that observation, never a constant. The live probe
  // uses the ceiling so even a slow but real settle is fully observable.
  const probe = { timeout: ADAPTIVE_CEILING_MS };
  switch (input.type) {
    case 'toBeVisible': {
      const { record, loc } = await resolveAndRecord(ctx, { ...input, intent: input.intent ?? 'element' });
      const t0 = Date.now();
      await expect(loc).toBeVisible(probe);
      const observed = adaptiveTimeout(observedSettleMs(ctx, t0));
      pushStep(ctx, {
        kind: 'assert',
        name: `${record.intent} is visible`,
        assertion: { type: 'toBeVisible', target: record, timeout: observed },
      });
      return { ok: true };
    }
    case 'toHaveText':
    case 'toContainText': {
      if (input.text == null) return { ok: false, error: `${input.type} needs text.` };
      const { record, loc } = await resolveAndRecord(ctx, { ...input, intent: input.intent ?? 'element' });
      const t0 = Date.now();
      if (input.type === 'toHaveText') await expect(loc).toHaveText(input.text, probe);
      else await expect(loc).toContainText(input.text, probe);
      const observed = adaptiveTimeout(observedSettleMs(ctx, t0));
      pushStep(ctx, {
        kind: 'assert',
        name: `${record.intent} ${input.type === 'toHaveText' ? 'has text' : 'contains'} "${input.text}"`,
        assertion: { type: input.type, target: record, text: input.text, timeout: observed },
      });
      return { ok: true };
    }
    case 'toHaveURL': {
      if (input.pattern == null) return { ok: false, error: 'toHaveURL needs pattern.' };
      // The model passes a literal substring. Escape before compiling so a
      // URL like "/auth.app/dashboard" does not turn the dots into "any char".
      const escaped = escapeRegex(input.pattern);
      await expect(ctx.page).toHaveURL(new RegExp(escaped), assertTimeout);
      if (ctx.current) {
        pushStep(ctx, {
          kind: 'assert',
          name: `URL contains "${input.pattern}"`,
          assertion: { type: 'toHaveURL', pattern: escaped },
        });
      }
      return { ok: true };
    }
    case 'toHaveCount': {
      if (input.count == null) return { ok: false, error: 'toHaveCount needs count.' };
      // Absence form (count 0): build the locator from hints WITHOUT resolving,
      // because the whole point is that nothing matches. Wait for it to settle
      // and record an adaptive timeout so a just-removed element is honored.
      if (input.count === 0) {
        const record = recordFromHints(input);
        const countLoc = baseLocator(ctx.page, record);
        const t0 = Date.now();
        await expect(countLoc).toHaveCount(0, probe);
        const observed = adaptiveTimeout(observedSettleMs(ctx, t0));
        pushStep(ctx, {
          kind: 'assert',
          name: `${record.intent} matches zero elements`,
          assertion: { type: 'toHaveCount', target: record, count: 0, timeout: observed },
        });
        return { ok: true };
      }
      const { record } = await resolveAndRecord(ctx, { ...input, intent: input.intent ?? 'element' });
      // toHaveCount needs the multi-match locator; .first() would collapse the
      // count to 1 and any count > 1 assertion would be impossible.
      const countLoc = baseLocator(ctx.page, record);
      await expect(countLoc).toHaveCount(input.count, assertTimeout);
      pushStep(ctx, {
        kind: 'assert',
        name: `${record.intent} count is ${input.count}`,
        // Strip the ambiguity marker so the transcribed spec also omits .first()
        // for this specific assertion. baseLocator already does the right thing
        // in replay.ts when ambiguous=false.
        assertion: { type: 'toHaveCount', target: { ...record, ambiguous: undefined }, count: input.count },
      });
      return { ok: true };
    }
    case 'toBeHidden': {
      // Absence form: do NOT resolve — the element may not exist at all. Build
      // the locator straight from hints. toBeHidden passes when the element is
      // hidden OR matches zero elements, which is exactly "this is not shown".
      const record = recordFromHints(input);
      const loc = baseLocator(ctx.page, record).first();
      const t0 = Date.now();
      await expect(loc).toBeHidden(probe);
      const observed = adaptiveTimeout(observedSettleMs(ctx, t0));
      pushStep(ctx, {
        kind: 'assert',
        name: `${record.intent} is hidden`,
        assertion: { type: 'toBeHidden', target: record, timeout: observed },
      });
      return { ok: true };
    }
    case 'toHaveAttribute': {
      if (input.attribute == null) return { ok: false, error: 'toHaveAttribute needs attribute.' };
      if (input.value == null) return { ok: false, error: 'toHaveAttribute needs value.' };
      const { record, loc } = await resolveAndRecord(ctx, { ...input, intent: input.intent ?? 'element' });
      const t0 = Date.now();
      await expect(loc).toHaveAttribute(input.attribute, input.value, probe);
      const observed = adaptiveTimeout(observedSettleMs(ctx, t0));
      pushStep(ctx, {
        kind: 'assert',
        name: `${record.intent} has ${input.attribute}="${input.value}"`,
        assertion: { type: 'toHaveAttribute', target: record, attribute: input.attribute, value: input.value, timeout: observed },
      });
      return { ok: true };
    }
    case 'toHaveValue': {
      // The current value of a form field lives on the value PROPERTY, not the
      // value attribute. toHaveValue reads the property, so it sees typed text
      // and a selected option. Use this, never toHaveAttribute("value", ...).
      const { record, loc } = await resolveAndRecord(ctx, { ...input, intent: input.intent ?? 'element' });
      // A fill-and-verify assertion can only be correct if it asserts the EXACT
      // string that was filled. The recorded fill step is the single source of
      // truth: a value the model re-types may be longer, truncated, or — for a
      // generated field — unknowable. Read the recorded fill value for this
      // field; fall back to the model's value only when the field was never
      // filled in this scenario (asserting a pre-existing default).
      const filled = ctx.current ? fillValueForTarget(ctx.current.steps, record) : null;
      const expected = filled ?? input.value;
      if (expected == null) return { ok: false, error: 'toHaveValue needs value.' };
      const t0 = Date.now();
      await expect(loc).toHaveValue(expected, probe);
      const observed = adaptiveTimeout(observedSettleMs(ctx, t0));
      pushStep(ctx, {
        kind: 'assert',
        name: `${record.intent} has value "${expected}"`,
        assertion: { type: 'toHaveValue', target: record, value: expected, timeout: observed },
      });
      return { ok: true };
    }
  }
}

/** Shape of an assert tool call, shared by the cap helpers and executeAssertion. */
type AssertionInput = Parameters<typeof executeAssertion>[1];

/**
 * Identifies "the same assertion" for retry-cap counting. Two assert calls with
 * the same type + expected value + target hint are the same check, so a failing
 * happy-path "land on /auth/login" counts up across re-submits even when the
 * model tweaks unrelated form fields in between.
 */
function assertionSignature(input: AssertionInput): string {
  return [
    input.type,
    input.pattern ?? '',
    input.text ?? '',
    input.attribute ?? '',
    input.value ?? '',
    input.count == null ? '' : String(input.count),
    input.testid ?? input.role ?? input.label ?? input.css ?? input.intent ?? '',
  ].join('|');
}

/** Plain-English description of what an assertion expected, for the finding. */
function describeAssertion(input: AssertionInput): string {
  const who = input.intent ?? 'the element';
  switch (input.type) {
    case 'toHaveURL': return `the URL to contain "${input.pattern}"`;
    case 'toHaveText': return `${who} to have text "${input.text}"`;
    case 'toContainText': return `${who} to contain "${input.text}"`;
    case 'toHaveAttribute': return `${who} to have ${input.attribute}="${input.value}"`;
    case 'toHaveValue': return `${who} to have value "${input.value}"`;
    case 'toBeVisible': return `${who} to be visible`;
    case 'toBeHidden': return `${who} to be hidden`;
    case 'toHaveCount': return `${who} to match ${input.count} element(s)`;
    default: return `assertion ${input.type}`;
  }
}

/**
 * Reads what the page actually did, for a finding: the current URL plus any
 * visible alert / validation / toast / status text. This is the honest record
 * of "the expected outcome did not occur, here is what happened instead".
 */
async function captureActualState(page: Page): Promise<{ url: string; messages: string[] }> {
  const url = page.url();
  const messages = await page
    .evaluate(() => {
      // Every helper is a function declaration, never a const arrow, so tsx's
      // __name wrapper is not injected into the serialized body. See summarizeDom.
      const selectors = [
        '[role="alert"]', '[role="status"]', '[aria-live]',
        '.alert', '.error', '.invalid-feedback', '.field-error',
        '.toast', '.notification', '.help-block', '.text-danger',
      ];
      function isShown(el: Element): boolean {
        const e = el as HTMLElement;
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(e);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
      }
      const out: string[] = [];
      for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i] as HTMLElement;
          if (!isShown(el)) continue;
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (text && out.indexOf(text) === -1) out.push(text.slice(0, 160));
          if (out.length >= 8) return out;
        }
      }
      return out;
    })
    .catch(() => [] as string[]);
  return { url, messages };
}

/**
 * Runs an assertion, but caps retries on a repeatedly-failing one. The first
 * OUTCOME_RETRY_CAP-1 failures return ok:false and let the model retry (a slow
 * settle deserves one more try). On the cap-th failure of the SAME assertion we
 * stop: capture what the page actually did, record a finding, drop the
 * half-built scenario, and block further actions until the next begin_scenario.
 * A scenario whose success signal is wrong fails loudly with the real page
 * state instead of thrashing the form until the budget runs out.
 */
async function assertWithRetryCap(ctx: ToolContext, input: AssertionInput): Promise<ToolResult> {
  const sig = assertionSignature(input);
  try {
    const result = await executeAssertion(ctx, input);
    // A pass (or a validation reject that never ran the assertion) clears the
    // counter so an unrelated later failure of the same check starts fresh.
    if (result.ok) ctx._assertFailures.delete(sig);
    return result;
  } catch (err) {
    // An assertion whose TARGET could not be resolved (and could not be recovered)
    // already recorded a locator finding and blocked further actions inside
    // resolveAndRecord. That is a locator problem, not an assertion regression,
    // so pass it straight through — do NOT count it as an assertion failure or
    // record a second finding.
    if (err instanceof LocatorFindingError) {
      return { ok: false, error: err.message };
    }
    const failures = (ctx._assertFailures.get(sig) ?? 0) + 1;
    ctx._assertFailures.set(sig, failures);
    if (failures < OUTCOME_RETRY_CAP) {
      // Honest retry budget left. Surface the failure and let the model try again.
      return { ok: false, error: (err as Error).message };
    }
    // Cap reached. Record the finding and stop the thrash.
    const expected = describeAssertion(input);
    const actual = await captureActualState(ctx.page);
    const scenarioName = ctx.current?.name ?? '(unnamed scenario)';
    ctx.findings.push({
      scenario: scenarioName,
      category: ctx.current?.category,
      expected,
      url: actual.url,
      messages: actual.messages,
    });
    // This scenario produced a finding, not a passing test. Drop the half-built
    // trace (its outcome never held) and block further actions until the model
    // starts the next scenario.
    ctx.current = null;
    ctx.captures.clear();
    ctx._blockUntilNewScenario = true;
    const msgLine = actual.messages.length
      ? ` Visible page messages: ${actual.messages.join(' | ')}.`
      : ' No visible error, validation, or status message was found on the page.';
    return {
      ok: false,
      error:
        `Outcome did not occur after ${OUTCOME_RETRY_CAP} attempts. Expected ${expected}, ` +
        `but the page is at ${actual.url}.${msgLine} This is now the recorded result for this ` +
        `scenario. Do NOT retry or re-fill the form. Move on to a DIFFERENT planned scenario ` +
        `(the negative and edge cases) with begin_scenario, so they are not starved. Only come ` +
        `back to this flow if every other scenario is done. If none remain, call finish().`,
      data: { finding: true, expected, actual },
    };
  }
}

/**
 * Pruned, agent-friendly view of the page. Includes the form-state fields
 * the agent needs to decide what to do next.
 */
async function summarizeDom(page: Page): Promise<unknown> {
  // NOTE: every helper inside page.evaluate() is a `function` declaration, not
  // a const-assigned arrow. tsx/esbuild injects a `__name(fn, "x")` wrapper
  // around arrows-assigned-to-consts which references a parent-module helper
  // that does not exist when the function is serialized into the browser
  // context. Function declarations are safe.
  return await page.evaluate(() => {
    const MAX_INTERACTIVE = 80;
    const MAX_HEADINGS = 16;
    const MAX_LINKS = 40;

    function isVisible(el: Element): boolean {
      const e = el as HTMLElement;
      const cv = (e as unknown as { checkVisibility?: (opts: object) => boolean }).checkVisibility;
      if (typeof cv === 'function') {
        try { return cv.call(e, { checkOpacity: true, checkVisibilityCSS: true }); } catch { /* fallthrough */ }
      }
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    }

    function trunc(s: string | null | undefined, n: number): string | undefined {
      if (s == null) return undefined;
      const str = s.length > n ? s.slice(0, n) : s;
      return str || undefined;
    }

    function pick(el: Element): Record<string, unknown> {
      const r = el as HTMLElement;
      const input = r as HTMLInputElement;
      const isInput = /^(input|textarea|select)$/i.test(r.tagName);
      const isFormControl = isInput || r.tagName === 'BUTTON';
      const label =
        r.getAttribute('aria-label') ||
        r.getAttribute('placeholder') ||
        r.getAttribute('name') ||
        (r.textContent ?? '').trim().slice(0, 80);
      const nativeDisabled =
        isFormControl ? (r as unknown as { disabled?: boolean }).disabled === true : false;
      return {
        tag: r.tagName.toLowerCase(),
        role: r.getAttribute('role') || undefined,
        label: label || undefined,
        // Cover both `data-testid` (official Playwright convention) and the
        // very common `data-test` (Saucedemo, many React apps). Without this
        // fallback the agent has no testid hint to pass when only `data-test`
        // is on the element, and the cascade can't reach the testid step.
        testid: r.getAttribute('data-testid') || r.getAttribute('data-test') || undefined,
        placeholder: r.getAttribute('placeholder') || undefined,
        type: isInput ? input.type || undefined : undefined,
        visible: isVisible(r),
        disabled: (nativeDisabled || r.getAttribute('aria-disabled') === 'true') || undefined,
        required: isInput ? (input.required || r.getAttribute('aria-required') === 'true' || undefined) : undefined,
        readonly: isInput ? (input.readOnly || undefined) : undefined,
        value: isInput ? trunc(input.value, 80) : undefined,
        ariaInvalid: r.getAttribute('aria-invalid') === 'true' || undefined,
        validation: isInput ? trunc(input.validationMessage, 120) : undefined,
        // For a <select>, list the choosable options so the agent can pass a
        // real value/label to select_option instead of guessing or trying fill.
        options: r.tagName === 'SELECT'
          ? Array.from((r as unknown as HTMLSelectElement).options).slice(0, 40).map((o) => ({
              value: o.value,
              label: (o.textContent ?? '').trim().slice(0, 60),
            }))
          : undefined,
      };
    }

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4')).slice(0, MAX_HEADINGS).map(pick);
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).slice(0, MAX_INTERACTIVE).map(pick);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, MAX_INTERACTIVE).map(pick);
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, MAX_LINKS).map(pick);
    return {
      title: document.title,
      url: location.href,
      headings,
      inputs,
      buttons,
      links,
    };
  });
}
