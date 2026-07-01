import { chromium, type Browser } from 'playwright';
import type { Scenario, TraceStep } from './trace.js';
import { replayScenarioOnce } from './replay.js';
import {
  proposeStabilityFix,
  applyProposal,
  describeProposal,
  type StabilizerProposal,
  type PreviousAttempt,
} from './stabilizer.js';

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
  /**
   * Enable Stage 5b — the Stabilizer. When a scenario is classified `flaky`
   * (passed at least once, failed at least once), QA-Core asks Sonnet to
   * propose a minimal fix (wait insertion or selector swap) and re-runs the
   * iterations. Capped at 1 attempt per scenario.
   * Defaults to true. Set false to mirror old "drop everything flaky"
   * behaviour or to keep tests offline (Stabilizer calls Claude).
   */
  stabilize?: boolean;
  /** Override the model used by the Stabilizer. Defaults to claude-sonnet-4-6. */
  stabilizerModel?: string;
  /**
   * Max number of fix attempts per flaky scenario (Tier B — multi-attempt
   * loop). Defaults to 3. Each attempt: propose a fix → re-run iterations →
   * stop if stable, otherwise add to history and try again with the LLM
   * told what was already tried. Bounds cost at ~3× one-shot recovery.
   */
  maxStabilizeAttempts?: number;
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
  /** Stabilizer is about to propose a fix for a flaky scenario. */
  | { type: 'stabilize_started'; name: string; failedStep: number; stepKind: string }
  /** Stabilizer produced a proposal (kind: wait | swap | none). attempt is 1-indexed. */
  | { type: 'stabilize_proposed'; name: string; attempt: number; proposalKind: StabilizerProposal['kind']; reason: string; costUsd: number }
  /** A specific attempt's re-run finished but the scenario was still flaky. */
  | { type: 'stabilize_attempt_failed'; name: string; attempt: number; pattern: string }
  /** Recovery loop finished — scenario is now stable. */
  | { type: 'stabilize_recovered'; name: string; afterIterations: number; attempts: number; winningStrategy: string }
  /** Recovery loop finished — scenario is still flaky after all attempts. */
  | { type: 'stabilize_unfixed'; name: string; pattern: string; attempts: number; triedStrategies: string[] }
  | {
      type: 'stability_done';
      stable: number;
      flaked: number;
      recovered: number;
      iterations: number;
      flakeRate: number;
      durationMs: number;
      stabilizerCostUsd: number;
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
  /**
   * True when this scenario only became stable after the Stabilizer applied a
   * relaxed rule (wait insertion, timeout bump, selector swap). It ships, but it
   * is NOT counted in the strict "stable" headline.
   */
  relaxed?: boolean;
  /**
   * True when the Stabilizer attempted to recover this scenario and gave up.
   * Such scenarios are reclassified broken so the broken count includes them.
   */
  gaveUp?: boolean;
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
  /** Scenarios that passed every iteration (first pass OR after Stabilizer recovery). */
  emitted: Scenario[];
  /** Scenarios that failed at least one iteration. Union of `flaky` + `broken`. */
  flaked: Scenario[];
  /** Subset of `flaked` classified as flaky (at least one pass). */
  flaky: Scenario[];
  /** Subset of `flaked` classified as broken (every iteration failed). */
  broken: Scenario[];
  /** Subset of `emitted` that needed the Stabilizer to become stable. */
  recovered: Scenario[];
  iterations: number;
  /** flaked / total. 0 when there are no scenarios. */
  flakeRate: number;
  durationMs: number;
  /** USD cost of all Stabilizer LLM calls during this stage. */
  stabilizerCostUsd: number;
}

const DEFAULT_ITERATIONS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STABILIZE_ATTEMPTS = 3;

export async function stability(opts: StabilityOptions): Promise<StabilityResult> {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stabilizeEnabled = opts.stabilize !== false;
  const maxAttempts = Math.max(1, opts.maxStabilizeAttempts ?? DEFAULT_MAX_STABILIZE_ATTEMPTS);
  const startMs = Date.now();
  const verdicts: StabilityVerdict[] = [];
  const emitted: Scenario[] = [];
  const flaked: Scenario[] = [];
  const flaky: Scenario[] = [];
  const broken: Scenario[] = [];
  const recovered: Scenario[] = [];
  let stabilizerCostUsd = 0;

  opts.onEvent?.({ type: 'stability_started', total: opts.scenarios.length, iterations });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });

    for (const scenario of opts.scenarios) {
      const scenarioStart = Date.now();
      const firstPass = await runIterations(browser, scenario, iterations, timeoutMs, opts);
      let { passes, outcomes, firstFailure } = firstPass;
      let classification = classify(passes, iterations);
      // Set when the Stabilizer recovered this scenario via a relaxed rule.
      let relaxed = false;
      // Set when the Stabilizer attempted recovery and gave up — these are
      // reclassified broken so the broken count includes them.
      let gaveUp = false;

      // Stage 5b — Stabilizer. Multi-attempt loop (Tier B). When the
      // scenario is flaky (passed at least once), try up to maxAttempts
      // LLM-guided fixes, each informed by what the previous one tried.
      // Skip `broken` (zero passes — real bug, not a flake). Skip `stable`
      // (nothing to fix). Skip when stabilize is disabled (offline mode).
      if (classification === 'flaky' && stabilizeEnabled && firstFailure) {
        opts.onEvent?.({
          type: 'stabilize_started',
          name: scenario.name,
          failedStep: firstFailure.failedStep,
          stepKind: firstFailure.stepKind,
        });

        // Snapshot the ORIGINAL steps so each attempt starts from a clean
        // slate (proposals don't stack cumulatively — attempt 2 isn't
        // wait+swap on top of attempt 1's wait).
        const originalSteps: TraceStep[] = structuredClone(scenario.steps);
        const initialFailure = firstFailure;
        const initialPattern = outcomes.join('-');
        const history: PreviousAttempt[] = [];
        let latestFailure = initialFailure;
        let latestPattern = initialPattern;
        let recoveredHere = false;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          let proposalCost = 0;
          let proposalForCatch: StabilizerProposal | null = null;
          try {
            const { proposal, costUsd } = await proposeStabilityFix({
              scenario,
              failure: {
                failedStep: latestFailure.failedStep,
                stepKind: latestFailure.stepKind,
                error: latestFailure.error,
                pattern: latestPattern,
              },
              previousAttempts: history,
              model: opts.stabilizerModel,
            });
            proposalForCatch = proposal;
            proposalCost = costUsd;
            stabilizerCostUsd += costUsd;

            opts.onEvent?.({
              type: 'stabilize_proposed',
              name: scenario.name,
              attempt,
              proposalKind: proposal.kind,
              reason: proposal.reason,
              costUsd,
            });

            // Bail if the LLM gives up or identifies a semantic defect.
            if (proposal.kind === 'none' || proposal.kind === 'broken') {
              // 'broken' overrides the classification — this is a spec defect,
              // not a timing race. Don't re-run; mark it broken and drop it.
              if (proposal.kind === 'broken') classification = 'broken';
              break;
            }

            // Reset to original + apply ONLY this attempt's proposal.
            scenario.steps = structuredClone(originalSteps);
            applyProposal(scenario, latestFailure.failedStep, proposal);
            const reRun = await runIterations(browser, scenario, iterations, timeoutMs, opts);
            const reClass = classify(reRun.passes, iterations);
            latestPattern = reRun.outcomes.join('-');

            if (reClass === 'stable') {
              passes = reRun.passes;
              outcomes = reRun.outcomes;
              firstFailure = reRun.firstFailure;
              classification = 'stable';
              opts.onEvent?.({
                type: 'stabilize_recovered',
                name: scenario.name,
                afterIterations: iterations,
                attempts: attempt,
                winningStrategy: describeProposal(proposal),
              });
              recovered.push(scenario);
              recoveredHere = true;
              relaxed = true;
              break;
            }

            // Still failing — record this attempt and try again with the
            // LLM aware of what was tried.
            history.push({ proposal, pattern: latestPattern });
            if (reRun.firstFailure) latestFailure = reRun.firstFailure;
            opts.onEvent?.({
              type: 'stabilize_attempt_failed',
              name: scenario.name,
              attempt,
              pattern: latestPattern,
            });
          } catch (err) {
            // Stabilizer crashes never break the suite — log and move on
            // to the next attempt (or terminate the loop if we're out).
            const reason = err instanceof Error ? err.message : 'unknown stabilizer error';
            opts.onEvent?.({
              type: 'stabilize_proposed',
              name: scenario.name,
              attempt,
              proposalKind: 'none',
              reason: `stabilizer threw: ${reason}`,
              costUsd: proposalCost,
            });
            // Record the crash so the next attempt's history shows we tried.
            history.push({
              proposal: proposalForCatch ?? { kind: 'none', reason: `crash: ${reason}` },
              pattern: latestPattern,
            });
            break; // crashes are usually deterministic — don't loop on them
          }
        }

        if (!recoveredHere) {
          // Restore the scenario to original — the latest attempt left
          // residual mutations that aren't useful to anyone (the scenario
          // is about to be dropped anyway, but this keeps the data clean).
          scenario.steps = structuredClone(originalSteps);
          // Reset passes/outcomes/firstFailure to the ORIGINAL first run so
          // the verdict that gets recorded matches what the user saw.
          passes = (initialPattern.match(/P/g) ?? []).length;
          outcomes = initialPattern.split('-') as Array<'P' | 'F'>;
          firstFailure = initialFailure;
          // The Stabilizer attempted and gave up. Count it as broken — it will
          // not ship and we could not make it reliable, so it does not belong in
          // the flaky bucket. `gaveUp` keeps the original P-F pattern visible for
          // diagnostics while the broken count includes this scenario.
          //
          // The 'broken' proposal case above already set classification='broken'
          // directly (a declared spec defect); leave that as-is.
          if (classification !== 'broken') {
            classification = 'broken';
            gaveUp = true;
          }
          opts.onEvent?.({
            type: 'stabilize_unfixed',
            name: scenario.name,
            pattern: initialPattern,
            attempts: history.length,
            triedStrategies: history.map((h) => describeProposal(h.proposal)),
          });
        }
      }

      verdicts.push({
        name: scenario.name,
        iterations,
        passes,
        stable: classification === 'stable',
        classification,
        pattern: outcomes.join('-'),
        relaxed: relaxed || undefined,
        gaveUp: gaveUp || undefined,
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
    recovered: recovered.length,
    iterations,
    flakeRate,
    durationMs,
    stabilizerCostUsd,
  });

  return {
    verdicts,
    emitted,
    flaked,
    flaky,
    broken,
    recovered,
    iterations,
    flakeRate,
    durationMs,
    stabilizerCostUsd,
  };
}

/* ─────────────────── helpers ─────────────────── */

interface IterationsResult {
  passes: number;
  outcomes: Array<'P' | 'F'>;
  firstFailure: StabilityVerdict['firstFailure'];
}

async function runIterations(
  browser: Browser,
  scenario: Scenario,
  iterations: number,
  timeoutMs: number,
  opts: StabilityOptions,
): Promise<IterationsResult> {
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
  return { passes, outcomes, firstFailure };
}

function classify(passes: number, iterations: number): StabilityClassification {
  if (passes === iterations) return 'stable';
  if (passes === 0) return 'broken';
  return 'flaky';
}
