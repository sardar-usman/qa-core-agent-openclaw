import { chromium, type Browser, type FrameLocator, type Locator, type Page } from 'playwright';
import fs from 'node:fs';
import type { Assertion, Scenario, SelectorRecord, TraceStep } from './trace.js';
import { generateUnique } from './unique-data.js';
import { installEvalShim } from './eval-shim.js';
import { frameLocatorForChain } from './selectors.js';

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

  // Capture-and-compare values read during THIS replay run. Keyed by the
  // capture's varName; assert_compare reads back from here so it compares
  // against a value that was actually on the page this run, never a literal.
  const captures = new Map<string, string>();

  try {
    let j = 0;
    for (const step of scenario.steps) {
      try {
        await runStep(page, step, timeoutMs, captures);
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

export async function runStep(
  page: Page,
  step: TraceStep,
  timeoutMs: number,
  captures: Map<string, string>,
): Promise<void> {
  switch (step.kind) {
    case 'navigate':
      await page.goto(step.url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      return;
    case 'click':
      await locatorFromRecord(page, step.target).click({ timeout: timeoutMs });
      return;
    case 'fill':
      // A field that feeds a uniqueness constraint gets a fresh value every run,
      // matching what the emitted spec does. Without this a register replay would
      // reuse the recorded email and fail the second time on a duplicate.
      await locatorFromRecord(page, step.target).fill(
        step.generate ? generateUnique(step.generate) : step.value,
        { timeout: timeoutMs },
      );
      return;
    case 'press':
      await locatorFromRecord(page, step.target).press(step.key, { timeout: timeoutMs });
      return;
    case 'select_option': {
      const loc = locatorFromRecord(page, step.target);
      if (step.by === 'value') await loc.selectOption({ value: step.option }, { timeout: timeoutMs });
      else if (step.by === 'label') await loc.selectOption({ label: step.option }, { timeout: timeoutMs });
      else if (step.by === 'index') await loc.selectOption({ index: Number(step.option) }, { timeout: timeoutMs });
      else await loc.selectOption(step.option, { timeout: timeoutMs });
      return;
    }
    case 'set_checked':
      if (step.checked) await locatorFromRecord(page, step.target).check({ timeout: timeoutMs });
      else await locatorFromRecord(page, step.target).uncheck({ timeout: timeoutMs });
      return;
    case 'set_input_files':
      await locatorFromRecord(page, step.target).setInputFiles(step.files, { timeout: timeoutMs });
      return;
    case 'wait':
    case 'stability_wait':
      await page.waitForTimeout(step.ms);
      return;
    case 'wait_for_state': {
      const loc = locatorFromRecord(page, step.target).first();
      await loc.waitFor({ state: step.state, timeout: step.timeoutMs ?? timeoutMs });
      return;
    }
    case 'checkpoint':
      return;
    case 'assert':
      await runAssertion(page, step.assertion, timeoutMs);
      return;
    case 'capture': {
      const value = await readStepValue(page, step.source, step.target, step.attribute);
      captures.set(step.varName, value);
      return;
    }
    case 'assert_compare': {
      const captured = captures.get(step.varName);
      if (captured === undefined) {
        throw new Error(`assert_compare: no captured value for "${step.varName}" — capture step missing or out of order`);
      }
      if (step.relation === 'absent') {
        const loc = absenceLocatorFor(page, step.source, step.attribute, captured, step.target.frameChain);
        await pollUntil(
          timeoutMs,
          async () => (await loc.count()) === 0,
          `assert_compare(absent): captured value "${captured}" still matches an element`,
        );
        return;
      }
      // Poll the after-action read instead of reading once. A sort, a re-render,
      // or any async state change needs time to settle, so a single immediate
      // read races the operation and flakes. Re-read until the comparison holds
      // or the timeout expires, the same web-first wait the completion
      // assertions use for aria-valuenow.
      let current = '';
      const held = await pollUntil(
        timeoutMs,
        async () => {
          current = await readStepValue(page, step.source, step.target, step.attribute);
          return compareHolds(step.relation, captured, current);
        },
        `assert_compare(${step.relation}) did not settle`,
      ).then(() => true).catch(() => false);
      if (!held) {
        throw new Error(
          `assert_compare(${step.relation}): "${step.target.intent}" captured "${captured}", now "${current}"`
        );
      }
      // 'unchanged' on a value widget also proves the frozen value sits strictly
      // between its range attributes (the refactored assert_freeze bounds check).
      if (step.relation === 'unchanged' && step.bounds) {
        const loc = locatorFromRecord(page, step.target).first();
        const minRaw = (await loc.getAttribute(step.bounds.min))?.trim() ?? '';
        const maxRaw = (await loc.getAttribute(step.bounds.max))?.trim() ?? '';
        const n = Number(current);
        const min = Number(minRaw);
        const max = Number(maxRaw);
        if (!Number.isFinite(n) || !Number.isFinite(min) || !Number.isFinite(max) || !(n > min && n < max)) {
          throw new Error(
            `assert_compare(unchanged): "${step.target.intent}" ${step.attribute}="${current}" is not strictly between ${step.bounds.min}="${minRaw}" and ${step.bounds.max}="${maxRaw}"`
          );
        }
      }
      return;
    }
  }
}

/** Read a capture/compare value off the page the way the step specifies. */
async function readStepValue(
  page: Page,
  source: 'attribute' | 'text' | 'count',
  target: SelectorRecord,
  attribute?: string,
): Promise<string> {
  if (source === 'count') {
    return String(await baseLocator(page, target).count());
  }
  const loc = locatorFromRecord(page, target).first();
  if (source === 'attribute') return (await loc.getAttribute(attribute!))?.trim() ?? '';
  return (await loc.textContent())?.trim() ?? '';
}

function absenceLocatorFor(
  page: Page,
  source: 'attribute' | 'text' | 'count',
  attribute: string | undefined,
  captured: string,
  frameChain?: string[],
) {
  const scope: Page | FrameLocator =
    frameChain && frameChain.length ? frameLocatorForChain(page, frameChain) : page;
  if (source === 'attribute' && attribute) {
    return scope.locator(`[${attribute}="${captured.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
  }
  return scope.getByText(captured, { exact: true });
}

function compareHolds(relation: string, captured: string, current: string): boolean {
  switch (relation) {
    case 'changed': return current !== captured;
    case 'unchanged':
    case 'equal': return current === captured;
    case 'greater':
      return Number.isFinite(Number(current)) && Number.isFinite(Number(captured)) && Number(current) > Number(captured);
    case 'less':
      return Number.isFinite(Number(current)) && Number.isFinite(Number(captured)) && Number(current) < Number(captured);
    default: return false;
  }
}

async function runAssertion(page: Page, a: Assertion, timeoutMs: number): Promise<void> {
  switch (a.type) {
    case 'toBeVisible': {
      const effectiveTimeout = a.timeout ?? timeoutMs;
      await locatorFromRecord(page, a.target).first().waitFor({ state: 'visible', timeout: effectiveTimeout });
      return;
    }
    case 'toHaveText': {
      const loc = locatorFromRecord(page, a.target).first();
      const effectiveTimeout = a.timeout ?? timeoutMs;
      await pollUntil(effectiveTimeout, async () => {
        const txt = (await loc.textContent())?.trim() ?? '';
        return txt === a.text;
      }, `toHaveText: expected "${a.text}"`);
      return;
    }
    case 'toContainText': {
      const loc = locatorFromRecord(page, a.target).first();
      const effectiveTimeout = a.timeout ?? timeoutMs;
      await pollUntil(effectiveTimeout, async () => {
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
    case 'toBeHidden': {
      // Passes when the locator is hidden OR matches zero elements — the
      // absence form. .first() keeps it strict-mode safe when several hidden
      // nodes match. count()===0 short-circuits the not-present case.
      const loc = locatorFromRecord(page, a.target).first();
      const base = locatorFromRecord(page, a.target);
      const effectiveTimeout = a.timeout ?? timeoutMs;
      await pollUntil(effectiveTimeout, async () => {
        if ((await base.count()) === 0) return true;
        return !(await loc.isVisible());
      }, `toBeHidden: "${a.target.intent}" is still visible`);
      return;
    }
    case 'toHaveCount': {
      const loc = locatorFromRecord(page, a.target);
      const effectiveTimeout = a.timeout ?? timeoutMs;
      await pollUntil(effectiveTimeout, async () => (await loc.count()) === a.count, `toHaveCount: expected ${a.count}`);
      return;
    }
    case 'toHaveAttribute': {
      const loc = locatorFromRecord(page, a.target).first();
      const effectiveTimeout = a.timeout ?? timeoutMs;
      await pollUntil(effectiveTimeout, async () => {
        const val = await loc.getAttribute(a.attribute);
        return val === a.value;
      }, `toHaveAttribute: expected ${a.attribute}="${a.value}"`);
      return;
    }
    case 'toHaveValue': {
      // Reads the value PROPERTY (typed text / selected option), not the static
      // attribute. inputValue() is the property read; poll so a value that
      // settles after an async action is not raced.
      const loc = locatorFromRecord(page, a.target).first();
      const effectiveTimeout = a.timeout ?? timeoutMs;
      await pollUntil(effectiveTimeout, async () => {
        const val = await loc.inputValue();
        return val === a.value;
      }, `toHaveValue: expected "${a.value}"`);
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
  // Scope into the iframe chain first, if any, so the locator reads/types/
  // asserts inside the frame and not against the top document.
  const scope: Page | FrameLocator =
    record.frameChain && record.frameChain.length ? frameLocatorForChain(page, record.frameChain) : page;
  switch (record.level) {
    case 'role': {
      const arg = record.arg as { role: string; name?: string; exact?: boolean };
      const r = arg.role as Parameters<Page['getByRole']>[0];
      if (!arg.name) return scope.getByRole(r);
      return scope.getByRole(r, arg.exact ? { name: arg.name, exact: true } : { name: arg.name });
    }
    case 'label':
      return scope.getByLabel(record.arg as string);
    case 'placeholder':
      return scope.getByPlaceholder(record.arg as string);
    case 'text':
      return scope.getByText(record.arg as string);
    case 'alt':
      return scope.getByAltText(record.arg as string);
    case 'title':
      return scope.getByTitle(record.arg as string);
    case 'testid':
      return scope.getByTestId(record.arg as string);
    case 'css':
      return scope.locator(record.arg as string);
    case 'xpath':
      return scope.locator(`xpath=${record.arg as string}`);
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
