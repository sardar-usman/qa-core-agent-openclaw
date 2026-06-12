import { chromium, type Browser, type Locator, type Page } from 'playwright';
import fs from 'node:fs';
import type { Assertion, Scenario, SelectorRecord, TraceStep } from './trace.js';
import { installEvalShim } from './eval-shim.js';

/**
 * Reality check.
 *
 * The Explorer captures every step against the live page, so each trace step
 * is already verified once. But "verified once during exploration" is not the
 * same as "passes when replayed as a Playwright spec." Browsers are stateful;
 * timing, navigation order, and selector drift between scenarios can all
 * cause a trace that worked in-loop to fail on independent re-run.
 *
 * This module re-executes every recorded scenario in a fresh browser context
 * and drops the ones that fail. Survivors are what the Transcriber emits.
 * Result: every line in the final spec corresponds to an action that passed
 * twice — once during exploration, once on independent replay.
 *
 * Zero LLM cost. Pure Playwright execution.
 */

export interface ReplayOptions {
  scenarios: Scenario[];
  /** Storage state reused from the Explorer run, when present. */
  storageStatePath?: string;
  /** Per-step timeout. Defaults to 10s. */
  timeoutMs?: number;
  /** Streaming progress hook. */
  onEvent?: (event: ReplayEvent) => void;
}

export type ReplayEvent =
  | { type: 'replay_started'; total: number }
  | { type: 'scenario_started'; name: string; index: number; total: number }
  | { type: 'scenario_passed'; name: string; durationMs: number }
  | { type: 'scenario_failed'; name: string; failedStep: number; stepKind: string; error: string }
  | { type: 'replay_done'; passed: number; failed: number; durationMs: number };

export interface ReplayVerdict {
  name: string;
  passed: boolean;
  /** Zero-based index of the step that failed, if any. */
  failedStep?: number;
  /** Step kind that failed, for human-readable reports. */
  stepKind?: TraceStep['kind'];
  /** First line of the underlying Playwright error message. */
  error?: string;
  durationMs: number;
}

export interface ReplayResult {
  verdicts: ReplayVerdict[];
  /** Scenarios that survived replay. The Transcriber should emit these. */
  emitted: Scenario[];
  /** Scenarios that were dropped because at least one step failed. */
  dropped: Scenario[];
  /** Total replay wall-clock time across all scenarios. */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startMs = Date.now();
  const verdicts: ReplayVerdict[] = [];
  const emitted: Scenario[] = [];
  const dropped: Scenario[] = [];

  opts.onEvent?.({ type: 'replay_started', total: opts.scenarios.length });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });

    let i = 0;
    for (const scenario of opts.scenarios) {
      opts.onEvent?.({ type: 'scenario_started', name: scenario.name, index: i, total: opts.scenarios.length });

      const verdict = await replayScenarioOnce(browser, scenario, opts.storageStatePath, timeoutMs);
      verdicts.push(verdict);

      if (verdict.passed) {
        emitted.push(scenario);
        opts.onEvent?.({ type: 'scenario_passed', name: scenario.name, durationMs: verdict.durationMs });
      } else {
        dropped.push(scenario);
        opts.onEvent?.({
          type: 'scenario_failed',
          name: scenario.name,
          failedStep: verdict.failedStep ?? -1,
          stepKind: verdict.stepKind ?? 'unknown',
          error: verdict.error ?? 'unknown error',
        });
      }
      i++;
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }

  const durationMs = Date.now() - startMs;
  opts.onEvent?.({
    type: 'replay_done',
    passed: emitted.length,
    failed: dropped.length,
    durationMs,
  });

  return { verdicts, emitted, dropped, durationMs };
}

export async function replayScenarioOnce(
  browser: Browser,
  scenario: Scenario,
  storageStatePath: string | undefined,
  timeoutMs: number,
): Promise<ReplayVerdict> {
  const scenarioStart = Date.now();

  const useStorage = storageStatePath && fs.existsSync(storageStatePath);
  const context = await browser.newContext(useStorage ? { storageState: storageStatePath } : undefined);
  await installEvalShim(context);
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);

  let failedStep: number | undefined;
  let stepKind: TraceStep['kind'] | undefined;
  let errorMsg: string | undefined;

  try {
    let j = 0;
    for (const step of scenario.steps) {
      try {
        await runStep(page, step, timeoutMs);
      } catch (err) {
        failedStep = j;
        stepKind = step.kind;
        errorMsg = firstLine((err as Error).message ?? String(err));
        break;
      }
      j++;
    }
  } finally {
    await context.close().catch(() => undefined);
  }

  return {
    name: scenario.name,
    passed: failedStep === undefined,
    failedStep,
    stepKind,
    error: errorMsg,
    durationMs: Date.now() - scenarioStart,
  };
}

async function runStep(page: Page, step: TraceStep, timeoutMs: number): Promise<void> {
  switch (step.kind) {
    case 'navigate':
      await page.goto(step.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      return;
    case 'click':
      await locatorFromRecord(page, step.target).click({ timeout: timeoutMs });
      return;
    case 'fill':
      await locatorFromRecord(page, step.target).fill(step.value, { timeout: timeoutMs });
      return;
    case 'press':
      await locatorFromRecord(page, step.target).press(step.key, { timeout: timeoutMs });
      return;
    case 'wait':
      await page.waitForTimeout(step.ms);
      return;
    case 'checkpoint':
      return;
    case 'assert':
      await runAssertion(page, step.assertion, timeoutMs);
      return;
  }
}

async function runAssertion(page: Page, a: Assertion, timeoutMs: number): Promise<void> {
  switch (a.type) {
    case 'toBeVisible': {
      await locatorFromRecord(page, a.target).first().waitFor({ state: 'visible', timeout: timeoutMs });
      return;
    }
    case 'toHaveText': {
      const loc = locatorFromRecord(page, a.target).first();
      await pollUntil(timeoutMs, async () => {
        const txt = (await loc.textContent())?.trim() ?? '';
        return txt === a.text;
      }, `toHaveText: expected "${a.text}"`);
      return;
    }
    case 'toContainText': {
      const loc = locatorFromRecord(page, a.target).first();
      await pollUntil(timeoutMs, async () => {
        const txt = (await loc.textContent()) ?? '';
        return txt.includes(a.text);
      }, `toContainText: expected text containing "${a.text}"`);
      return;
    }
    case 'toHaveURL': {
      const re = new RegExp(a.pattern);
      await pollUntil(timeoutMs, async () => re.test(page.url()), `toHaveURL: ${page.url()} did not match ${a.pattern}`);
      return;
    }
    case 'toHaveCount': {
      const loc = locatorFromRecord(page, a.target);
      await pollUntil(timeoutMs, async () => (await loc.count()) === a.count, `toHaveCount: expected ${a.count}`);
      return;
    }
  }
}

function locatorFromRecord(page: Page, record: SelectorRecord): Locator {
  const base = baseLocator(page, record);
  return record.ambiguous ? base.first() : base;
}

/**
 * Build a Locator from a SelectorRecord WITHOUT applying `.first()`.
 *
 * Most call sites want the cascade's `.first()`-wrapped locator (so the spec
 * survives strict-mode when ambiguous). But `toHaveCount` is the one
 * assertion that semantically needs the multi-match locator — `.first()`
 * would collapse the count to 1 and the assertion can never see more.
 * Export so tools.ts can reach this path for toHaveCount.
 */
export function baseLocator(page: Page, record: SelectorRecord): Locator {
  switch (record.level) {
    case 'role': {
      const arg = record.arg as { role: string; name: string; exact?: boolean };
      return page.getByRole(
        arg.role as Parameters<Page['getByRole']>[0],
        arg.exact ? { name: arg.name, exact: true } : { name: arg.name },
      );
    }
    case 'label':
      return page.getByLabel(record.arg as string);
    case 'testid':
      return page.getByTestId(record.arg as string);
    case 'css':
      return page.locator(record.arg as string);
  }
}

async function pollUntil(timeoutMs: number, predicate: () => Promise<boolean>, failMessage: string): Promise<void> {
  const start = Date.now();
  const intervalMs = 150;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // Swallow transient errors; the next poll iteration may succeed.
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(failMessage);
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').trim().slice(0, 240);
}
