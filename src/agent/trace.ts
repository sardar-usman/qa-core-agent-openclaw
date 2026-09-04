import type { CascadeLevel, ResolvedLocator } from './selectors.js';

/**
 * A single verified step in the exploration trace. The transcriber turns
 * a sequence of these into a Playwright spec file.
 */
export type TraceStep =
  | { kind: 'navigate'; url: string }
  | {
      kind: 'click';
      target: SelectorRecord;
    }
  | {
      kind: 'fill';
      target: SelectorRecord;
      value: string;
      /**
       * When set, this field feeds a uniqueness constraint (a registration
       * email, a unique username). The emitted spec generates a fresh value on
       * every run instead of using the recorded literal, and replay/stability do
       * the same, so a creation flow survives re-running instead of failing the
       * second time on a duplicate. 'email' generates a unique email, 'token' a
       * unique alphanumeric token. See unique-data.ts. `value` still holds the
       * concrete value used during exploration (a valid example).
       */
      generate?: GenerateKind;
    }
  | {
      kind: 'press';
      target: SelectorRecord;
      key: string;
    }
  | {
      /**
       * Choose an option in a <select>. You cannot fill() a select, so this is
       * a distinct step. `by` decides how the option is matched: by its
       * underlying value, by its visible label, by zero-based index, or 'auto'
       * (a plain string Playwright matches against value OR label — used when
       * fill() auto-dispatches onto a select). Emits `selectOption(...)`.
       */
      kind: 'select_option';
      target: SelectorRecord;
      by: 'value' | 'label' | 'index' | 'auto';
      /** The value/label string, or the index rendered as a string. */
      option: string;
    }
  | {
      /**
       * Check or uncheck a checkbox or radio. fill() does not work on these.
       * `checked` true emits check(), false emits uncheck(). Radios are only
       * ever checked (you cannot uncheck a radio).
       */
      kind: 'set_checked';
      target: SelectorRecord;
      checked: boolean;
    }
  | {
      /**
       * Upload file(s) to a <input type="file">. Emits setInputFiles([...]).
       * The paths are whatever the explorer used; a file input that needs a
       * fixture the output project does not carry will fail at replay and the
       * scenario is dropped, which is the honest outcome.
       */
      kind: 'set_input_files';
      target: SelectorRecord;
      files: string[];
    }
  | {
      kind: 'assert';
      name: string;
      assertion: Assertion;
    }
  | { kind: 'checkpoint'; label: string }
  | { kind: 'wait'; ms: number }
  | {
      /**
       * Inserted by the Stabilizer when an element is not ready before a
       * click/fill/press. Emits `await locator.waitFor({ state })` — a
       * condition-based wait, never a fixed sleep.
       */
      kind: 'wait_for_state';
      target: SelectorRecord;
      state: 'visible' | 'hidden' | 'attached' | 'detached';
      timeoutMs?: number;
    }
  | {
      /**
       * A short bounded wait (≤1000ms) between two reads in a stability
       * comparison assertion. Unlike `wait`, this is explicitly tagged so
       * the gate's RULE 1 allows it. Do NOT use it to let animations settle
       * before a one-shot assertion — use wait_for_text or assert_freeze for
       * that. Emits `await page.waitForTimeout(ms)` in the spec.
       */
      kind: 'stability_wait';
      ms: number;
    }
  | {
      /**
       * Capture a real runtime value off the page into a named variable so a
       * later assert_compare can assert a relationship against it. This is the
       * read half of capture-and-compare: the value is whatever the element
       * actually exposes at run time, never a literal the model invents. Emits
       * `const <varName> = await <locator>.getAttribute(...)` (or textContent,
       * or count()).
       */
      kind: 'capture';
      /** Sanitized, collision-free JS identifier the emitted spec declares. */
      varName: string;
      /** What to read: an attribute value, the trimmed text, or the match count. */
      source: CaptureSource;
      target: SelectorRecord;
      /** Attribute name when source is 'attribute' (e.g. 'id', 'aria-valuenow'). */
      attribute?: string;
      /** Human label the model passed, kept for readable spec comments. */
      intent: string;
    }
  | {
      /**
       * Assert a relationship between a freshly re-read value and one captured
       * earlier in the same scenario. The other half of capture-and-compare.
       * For every relation except 'absent', the SAME element + source as the
       * capture is re-read and compared. For 'absent', the captured value is
       * used to build a value selector (e.g. [id="<captured>"]) which must now
       * match zero elements — proving the old value is gone.
       */
      kind: 'assert_compare';
      /** The capture's varName this assertion compares against. */
      varName: string;
      relation: CompareRelation;
      /** Re-read spec: same source/target/attribute the capture used. */
      source: CaptureSource;
      target: SelectorRecord;
      attribute?: string;
      intent: string;
      /** Fresh, collision-free identifier for the re-read value in the spec. */
      readVar: string;
      /**
       * Only on the 'unchanged' relation for a value widget (the refactored
       * assert_freeze): after proving the value held, also assert the re-read
       * value is strictly between these two range attributes on the same
       * element. Proves a progress bar stopped mid-progress, not at min or max.
       */
      bounds?: { min: string; max: string };
    };

/**
 * A field whose value must be generated, not a fixed literal. 'email' emits a
 * unique email, 'token' a unique alphanumeric token (for a unique username or
 * reference), 'password' a strong random password that passes a strength or
 * data-leak check on a sign-up form.
 */
export type GenerateKind = 'email' | 'token' | 'password';

/** What a capture reads off an element. */
export type CaptureSource = 'attribute' | 'text' | 'count';

/**
 * Relationship asserted between the re-read value and the captured one.
 *  - changed / unchanged: string inequality / equality
 *  - equal: same as unchanged, kept as an explicit alias for readability
 *  - greater / less: numeric comparison (e.g. a count that went up)
 *  - absent: the captured value no longer matches any element
 */
export type CompareRelation = 'changed' | 'unchanged' | 'equal' | 'greater' | 'less' | 'absent';

export interface SelectorRecord {
  level: CascadeLevel;
  arg: ResolvedLocator['arg'];
  /** Original intent recorded so the transcriber can comment the spec usefully. */
  intent: string;
  /**
   * True when the cascade resolved to multiple elements at the winning level
   * and had to take `.first()`. The transcriber emits `.first()` in this case
   * so the runtime spec does not trip Playwright's strict-mode guard.
   */
  ambiguous?: boolean;
  /**
   * Text hint that narrowed a multi-match to exactly one element via
   * .filter({ hasText }) at resolve time. Part of the locator's identity:
   * replay rebuilds the same filtered locator and the emitters append
   * .filter({ hasText: ... }) before any .first().
   */
  filterText?: string;
  /**
   * Chain of iframe selectors (outer→inner) the element lives behind. Absent
   * means the top frame. Replay scopes in with frameLocator before applying the
   * level; the emitted spec does the same, so reads/types/asserts all target
   * the frame, never the top document.
   */
  frameChain?: string[];
  /**
   * Stable identity of the ACTUAL DOM element this record resolved to, read off
   * the live element at resolve time (frame chain + structural DOM path). It is
   * NOT derived from the model's hints, the intent text, or the cascade tier, so
   * the same physical field produces the same key no matter how it was located,
   * and two different fields can never produce the same key. This is the ONLY key
   * a fill-and-verify assertion uses to find the value it should check
   * (fillValueForTarget in tools.ts): field 1's assertion can only ever read
   * field 1's fill value, so three assertions can share one value only when three
   * fills wrote that same value. Absent when the element could not be read (a
   * pure hint-built absence record, or the element vanished) — the assertion then
   * keeps the model's value instead of guessing.
   */
  elementKey?: string;
}

export type Assertion =
  | { type: 'toBeVisible'; target: SelectorRecord; timeout?: number }
  /**
   * Absence assertion: the target is not visible (or not present at all).
   * Built directly from the caller's hints WITHOUT requiring the element to
   * resolve, so negative / error-state / deleted-item scenarios can assert
   * that something is gone. Emits `toBeHidden()`, which also passes for a
   * locator that matches zero elements.
   */
  | { type: 'toBeHidden'; target: SelectorRecord; timeout?: number }
  | { type: 'toHaveText'; target: SelectorRecord; text: string; timeout?: number }
  | { type: 'toContainText'; target: SelectorRecord; text: string; timeout?: number }
  | { type: 'toHaveURL'; pattern: string }
  /**
   * Count assertion. `count: 0` is the absence form — built directly from
   * hints without resolving, so it can assert a selector matches nothing.
   * `timeout` is optional and lets an absence wait for the element to leave.
   */
  | { type: 'toHaveCount'; target: SelectorRecord; count: number; timeout?: number }
  | { type: 'toHaveAttribute'; target: SelectorRecord; attribute: string; value: string; timeout?: number }
  /**
   * Form-field value assertion. Reads the element's value PROPERTY (what the
   * user sees in the field), not the static `value` attribute. Typed text and
   * a selected option live on the property, so this is the only correct way to
   * assert the current value of an input, textarea, or select. Emits
   * `toHaveValue(value)`.
   */
  | { type: 'toHaveValue'; target: SelectorRecord; value: string; timeout?: number };

/**
 * A named scenario (e.g. "Login with valid credentials") composed of trace steps.
 * The transcriber emits one `test(...)` block per scenario.
 */
export interface Scenario {
  name: string;
  category: 'happy' | 'negative' | 'edge' | 'a11y';
  /**
   * Feature tag the scenario belongs to (e.g. 'login', 'cart'). Drives
   * per-feature grouping in the POM emitter: pages become
   * `pages/<feature>-page.ts` and tests are placed under
   * `tests/<feature>/<feature>.spec.ts`. Absent when the Planner inferred
   * scenarios without an explicit feature list — pom.ts falls back to its
   * legacy URL-pathname grouping in that case.
   */
  feature?: string;
  steps: TraceStep[];
  /** Console messages of level 'error' / 'warning' that fired during the scenario. */
  consoleErrors?: Array<{ kind: 'error' | 'warning'; text: string }>;
  /** Responses with status >= 400 that fired during the scenario. */
  networkErrors?: Array<{ status: number; url: string }>;
}

export interface RunReport {
  /** Discriminator vs ReviewPaused — always false for a finished run. */
  paused?: false;
  url: string;
  language: 'ts' | 'js';
  scenarios: Scenario[];
  cascadeStats: Record<CascadeLevel, number>;
  cost: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** Cost of the Explorer agent (the main tool-use loop) in USD. */
    usd: number;
    /** Cost of the Planner pre-step, if it ran. */
    plannerUsd?: number;
    /** Cost of the Critic post-step, if it ran. */
    criticUsd?: number;
  };
  steps: number;
  startedAt: string;
  finishedAt: string;
  /** Scenarios proposed by the Planner before the Explorer ran. */
  plan?: Array<{ name: string; category: string; rationale: string }>;
  /** Per-scenario verdicts from the Critic. */
  review?: {
    verdicts: Array<{
      scenario: string;
      verdict: 'pass' | 'rework' | 'reject';
      reasons: string[];
      required_fixes: string[];
    }>;
    summary: string;
  };
  /**
   * Reality check: each scenario was re-executed in a fresh Playwright context
   * after the Critic. Scenarios that fail replay are dropped from `scenarios`
   * before transcription, so the emitted spec only contains traces that passed
   * twice — once during exploration and once on independent replay.
   */
  replay?: {
    /** True only when the replay pass was disabled (--no-replay or programmatic). */
    skipped?: boolean;
    /** Count of scenarios that passed replay (matches scenarios.length when not skipped). */
    passed: number;
    /** Count of scenarios that failed replay and were dropped from the emitted spec. */
    failed: number;
    /** Wall-clock time spent on replay. */
    durationMs: number;
    /** Per-scenario verdicts including failure step index and error excerpt. */
    verdicts: Array<{
      name: string;
      passed: boolean;
      failedStep?: number;
      stepKind?: TraceStep['kind'];
      error?: string;
      durationMs: number;
    }>;
  };
  /**
   * Stability iteration: each replay survivor is re-executed N times in fresh
   * Playwright contexts. Scenarios that pass-then-fail are dropped as flaky.
   * `flakeRate` = flaked / total survivors entering the stage, the headline
   * metric for "how reliable is the emitted spec."
   */
  /**
   * Static validation gate — runs after Explorer, before Reality-Check.
   * RULE 1/3 violations block the scenario (may regenerate or mark BROKEN).
   * RULE 2 injections are auto-applied and logged here.
   */
  gate?: {
    broken: Array<{ scenario: string; reason: string; attempts: number }>;
    injections: Array<{ scenario: string; stepIndex: number; assertionType: string; detail: string }>;
  };
  stability?: {
    skipped?: boolean;
    iterations: number;
    /** Scenarios that passed every iteration (kept in the emitted spec). */
    passed: number;
    /** Scenarios that failed at least one iteration (dropped as flaky). */
    flaked: number;
    /** flaked / (passed + flaked). 0 when there were no scenarios to test. */
    flakeRate: number;
    durationMs: number;
    /** Subset of `flaked` classified flaky (≥1 pass, ≥1 fail). */
    flaky?: number;
    /** Subset of `flaked` classified broken (zero passes across iterations). */
    broken?: number;
    /**
     * Scenarios that became stable only AFTER the Stabilizer (Stage 5b) applied
     * a fix (wait insertion or selector swap). Counted inside `passed` — these
     * shipped in the emitted spec. Lets the dashboard surface "X stable · Y
     * recovered" so the value of Stage 5b is visible per run.
     */
    recovered?: number;
    /** USD cost of all Stabilizer LLM calls during this stage. */
    stabilizerCostUsd?: number;
    verdicts: Array<{
      name: string;
      iterations: number;
      passes: number;
      stable: boolean;
      classification?: 'stable' | 'flaky' | 'broken';
      pattern?: string;
      /** Shipped only after a Stabilizer relaxed-rule fix — excluded from strict stable. */
      relaxed?: boolean;
      /** Stabilizer attempted recovery and gave up — reclassified broken. */
      gaveUp?: boolean;
      firstFailure?: {
        iteration: number;
        failedStep: number;
        stepKind: TraceStep['kind'] | 'unknown';
        error: string;
      };
      durationMs: number;
    }>;
  };
  /**
   * Scenarios the Explorer began but never finalized — typically because the
   * step budget ran out mid-scenario. Recorded explicitly (not salvaged, not
   * silently dropped) so reconciliation can balance
   * planned === generated + dropped + incomplete.
   */
  incomplete?: Array<{ scenario: string; reason: string }>;
  /**
   * Findings: scenarios where the expected outcome never occurred. The Explorer
   * asserted a success signal (often a redirect) that the page never produced,
   * and after the retry cap it captured what the page actually did instead of
   * thrashing. Each finding names the scenario, what was expected, the URL the
   * page actually stayed on, and any visible messages. Counted in reconciliation
   * (planned === generated + dropped + incomplete + findings) so a wrong success
   * signal fails loudly rather than vanishing or shipping as a green test.
   */
  findings?: Array<{ scenario: string; category?: string; expected: string; url: string; messages: string[] }>;
  /**
   * In-run selector recoveries applied during exploration: a locator that
   * failed to resolve was automatically re-resolved against the live page by
   * the locator ladder and found by a different stable locator, so the run
   * continued instead of failing. Each entry names the scenario, what the model
   * asked for (`from`), what it re-resolved to (`to`), and the intent, so a
   * human can see exactly what was recovered. Recovery is scoped to locators
   * only, never to assertions (an assertion that fails is a possible real
   * regression and is recorded as a finding, never recovered). Absent when
   * nothing was recovered. The field keeps its `heals` name because the
   * dashboard and run-report consumers read it.
   */
  heals?: Array<{ scenario?: string; intent: string; from: string; to: string }>;
  /**
   * Reporting reconciliation: planned === generated + dropped + incomplete + findings,
   * with every dropped/incomplete scenario named and a relaxed-rule-aware
   * stable count. Computed in the runtime after the pipeline finishes. See
   * reconcile.ts.
   */
  reconciliation?: import('./reconcile.js').Reconciliation;
}
