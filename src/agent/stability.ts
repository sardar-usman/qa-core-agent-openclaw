import { chromium, type Browser } from 'playwright';
import type { Scenario, TraceStep } from './trace.js';
import { replayScenarioOnce } from './replay.js';

/**
 * Stability iteration.
 *
 * The replay pass proves a scenario can be re-executed once outside the
 * Explorer's context. Stability proves it can be re-executed *consistently*.
 * Each replay survivor is run N more times in fresh contexts; a scenario is
 * only emitted if it passes every iteration.
 *
 * The fraction of replay-survivors that fail at least one stability iteration
 * is reported as `flake_rate`. This is the metric that lets us claim "every
 * line in the emitted spec passed exploration, replay, AND three independent
 * re-runs" — a much stronger guarantee than "compiled successfully."
 *
 * Zero LLM cost. Pure Playwright execution.
 */

export interface StabilityOptions {
  scenarios: Scenario[];
  /** Storage state reused from the Explorer run, when present. */
  storageStatePath?: string;
  /** Number of stability iterations per scenario. Defaults to 3. */
  iterations?: number;
  /** Per-step timeout. Defaults to 10s. */
  timeoutMs?: number;
  /** Streaming progress hook. */
  onEvent?: (event: StabilityEvent) => void;
}

export type StabilityEvent =
  | { type: 'stability_started'; total: number; iterations: number }
  | { type: 'iteration_passed'; name: string; iteration: number; durationMs: number }
  | {
      type: 'iteration_failed';
      name: string;
      iteration: number;
      failedStep: number;
      stepKind: string;
      error: string;
    }
  | {
      type: 'stability_done';
      stable: number;
      flaked: number;
      iterations: number;
      flakeRate: number;
      durationMs: number;
    };

/**
 * - `stable`: every iteration passed (e.g. P-P-P)
 * - `flaky`: at least one pass AND at least one fail (e.g. P-F-P)
 * - `broken`: every iteration failed (e.g. F-F-F)
 *
 * Both `flaky` and `broken` are dropped from the emitted spec, but the
 * distinction matters for diagnosis — flaky implies a race or non-determinism
 * in the app/test, broken implies the scenario was never replayable.
 */
export type StabilityClassification = 'stable' | 'flaky' | 'broken';

export interface StabilityVerdict {
  name: string;
  iterations: number;
  /** Number of iterations the scenario passed. */
  passes: number;
  /** True only when passes === iterations. */
  stable: boolean;
  /** Stable / flaky / broken classification — see StabilityClassification. */
  classification: StabilityClassification;
  /** Compact per-iteration outcome string, e.g. "P-F-P" for diagnostics. */
  pattern: string;
  /** Earliest failing iteration, if any. Iteration numbers are 1-based. */
  firstFailure?: {
    iteration: number;
    failedStep: number;
    stepKind: TraceStep['kind'] | 'unknown';
    error: string;
  };
  durationMs: number;
}

export interface StabilityResult {
  verdicts: StabilityVerdict[];
  /** Scenarios that passed every iteration. */
  emitted: Scenario[];
  /** Scenarios that failed at least one iteration. Union of `flaky` + `broken`. */
  flaked: Scenario[];
  /** Subset of `flaked` classified as flaky (at least one pass). */
  flaky: Scenario[];
  /** Subset of `flaked` classified as broken (every iteration failed). */
  broken: Scenario[];
  iterations: number;
  /** flaked / total. 0 when there are no scenarios. */
  flakeRate: number;
  durationMs: number;
}

const DEFAULT_ITERATIONS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

export async function stability(opts: StabilityOptions): Promise<StabilityResult> {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startMs = Date.now();
  const verdicts: StabilityVerdict[] = [];
  const emitted: Scenario[] = [];
  const flaked: Scenario[] = [];
  const flaky: Scenario[] = [];
  const broken: Scenario[] = [];

  opts.onEvent?.({ type: 'stability_started', total: opts.scenarios.length, iterations });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });

    for (const scenario of opts.scenarios) {
      const scenarioStart = Date.now();
      let passes = 0;
      const outcomes: Array<'P' | 'F'> = [];
      let firstFailure: StabilityVerdict['firstFailure'];

      for (let i = 0; i < iterations; i++) {
        const result = await replayScenarioOnce(browser, scenario, opts.storageStatePath, timeoutMs);
        if (result.passed) {
          passes++;
          outcomes.push('P');
          opts.onEvent?.({
            type: 'iteration_passed',
            name: scenario.name,
            iteration: i + 1,
            durationMs: result.durationMs,
          });
        } else {
          outcomes.push('F');
          const failedStep = result.failedStep ?? -1;
          const stepKind = result.stepKind ?? 'unknown';
          const error = result.error ?? 'unknown error';
          if (!firstFailure) {
            firstFailure = { iteration: i + 1, failedStep, stepKind, error };
          }
          opts.onEvent?.({
            type: 'iteration_failed',
            name: scenario.name,
            iteration: i + 1,
            failedStep,
            stepKind,
            error,
          });
        }
      }

      const stable = passes === iterations;
      const classification: StabilityClassification =
        passes === iterations ? 'stable'
        : passes === 0 ? 'broken'
        : 'flaky';
      verdicts.push({
        name: scenario.name,
        iterations,
        passes,
        stable,
        classification,
        pattern: outcomes.join('-'),
        firstFailure,
        durationMs: Date.now() - scenarioStart,
      });
      if (classification === 'stable') {
        emitted.push(scenario);
      } else {
        flaked.push(scenario);
        if (classification === 'flaky') flaky.push(scenario);
        else broken.push(scenario);
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }

  const total = opts.scenarios.length;
  const flakeRate = total > 0 ? flaked.length / total : 0;
  const durationMs = Date.now() - startMs;

  opts.onEvent?.({
    type: 'stability_done',
    stable: emitted.length,
    flaked: flaked.length,
    iterations,
    flakeRate,
    durationMs,
  });

  return { verdicts, emitted, flaked, flaky, broken, iterations, flakeRate, durationMs };
}
