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
}
