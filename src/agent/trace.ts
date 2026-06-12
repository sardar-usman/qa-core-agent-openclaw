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
    }
  | {
      kind: 'press';
      target: SelectorRecord;
      key: string;
    }
  | {
      kind: 'assert';
      name: string;
      assertion: Assertion;
    }
  | { kind: 'checkpoint'; label: string }
  | { kind: 'wait'; ms: number };

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
}

export type Assertion =
  | { type: 'toBeVisible'; target: SelectorRecord }
  | { type: 'toHaveText'; target: SelectorRecord; text: string }
  | { type: 'toContainText'; target: SelectorRecord; text: string }
  | { type: 'toHaveURL'; pattern: string }
  | { type: 'toHaveCount'; target: SelectorRecord; count: number };

/**
 * A named scenario (e.g. "Login with valid credentials") composed of trace steps.
 * The transcriber emits one `test(...)` block per scenario.
 */
export interface Scenario {
  name: string;
  category: 'happy' | 'negative' | 'edge' | 'a11y';
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
    verdicts: Array<{ scenario: string; verdict: 'ship' | 'weak' | 'fix'; reason: string }>;
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
    verdicts: Array<{
      name: string;
      iterations: number;
      passes: number;
      stable: boolean;
      classification?: 'stable' | 'flaky' | 'broken';
      pattern?: string;
      firstFailure?: {
        iteration: number;
        failedStep: number;
        stepKind: TraceStep['kind'] | 'unknown';
        error: string;
      };
      durationMs: number;
    }>;
  };
}
