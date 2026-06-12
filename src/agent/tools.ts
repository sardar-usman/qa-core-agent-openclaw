import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { resolve, type CascadeLevel, escapeRegex } from './selectors.js';
import type { Assertion, Scenario, SelectorRecord, TraceStep } from './trace.js';
import { baseLocator } from './replay.js';

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
  /** Rolling capture for the current scenario; flushed onto it at end_scenario. */
  consoleErrors: Array<{ kind: 'error' | 'warning'; text: string }>;
  networkErrors: Array<{ status: number; url: string }>;
  /** Installed listener disposers so we can detach on page swap. */
  _detachListeners?: () => void;
}

export function createContext(page: Page, maxSteps: number): ToolContext {
  const ctx: ToolContext = {
    page,
    scenarios: [],
    current: null,
    cascadeStats: { role: 0, label: 0, testid: 0, css: 0 },
    steps: 0,
    maxSteps,
    consoleErrors: [],
    networkErrors: [],
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
      'Start a new test scenario. Call this before any actions. Categories: happy (positive path), negative (invalid input / error states), edge (boundary conditions), a11y (accessibility). Cookies and storage are cleared automatically so scenarios start from a clean state.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Scenario name in past tense, e.g. "logged in with valid credentials".' },
        category: { type: 'string', enum: ['happy', 'negative', 'edge', 'a11y'] },
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
    description: 'Type into a form field. Resolved through the same selector cascade as click.',
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
      'Record an assertion for the current scenario. Use this for the verifiable outcome of the actions you took. Text passed to toHaveURL is treated as a literal substring.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['toBeVisible', 'toHaveText', 'toContainText', 'toHaveURL', 'toHaveCount'],
        },
        intent: { type: 'string' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
        text: { type: 'string' },
        pattern: { type: 'string', description: 'URL substring (literal, no regex required).' },
        count: { type: 'number' },
      },
      required: ['type'],
    },
  },
  {
    name: 'end_scenario',
    description: 'Finish the current scenario. The scenario must have at least one assertion.',
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
  input: { intent: string; role?: string; label?: string; testid?: string; css?: string },
): Promise<{ record: SelectorRecord; loc: import('@playwright/test').Locator }> {
  const resolved = await resolve(ctx.page, input);
  if (!resolved) {
    throw new Error(`Could not resolve element: ${input.intent} (hints: ${JSON.stringify(input)})`);
  }
  ctx.cascadeStats[resolved.level] = (ctx.cascadeStats[resolved.level] ?? 0) + 1;
  return {
    record: { level: resolved.level, arg: resolved.arg, intent: input.intent, ambiguous: resolved.ambiguous || undefined },
    loc: resolved.locator,
  };
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
  if (ctx.steps > ctx.maxSteps) {
    return { ok: false, error: `Step budget exceeded (${ctx.maxSteps}). Call finish() now.` };
  }
  try {
    switch (call.name) {
      case 'begin_scenario': {
        const name = String(call.input.name ?? '').trim();
        const category = String(call.input.category ?? 'happy') as Scenario['category'];
        if (!name) return { ok: false, error: 'Scenario name required.' };
        if (ctx.current) return { ok: false, error: 'A scenario is already in progress.' };
        await isolateState(ctx.page);
        ctx.consoleErrors = [];
        ctx.networkErrors = [];
        ctx.current = { name, category, steps: [] };
        return { ok: true, data: { name, category } };
      }
      case 'navigate': {
        const url = String(call.input.url ?? '');
        if (!/^https?:\/\//.test(url)) return { ok: false, error: 'navigate requires an http(s) URL.' };
        await ctx.page.goto(url, { waitUntil: 'load' });
        if (ctx.current) pushStep(ctx, { kind: 'navigate', url });
        return { ok: true, data: { url: ctx.page.url() } };
      }
      case 'click': {
        const { record, loc } = await resolveAndRecord(ctx, call.input as never);
        await loc.click();
        pushStep(ctx, { kind: 'click', target: record });
        return { ok: true, data: { clicked: record.intent, ambiguous: record.ambiguous ?? false } };
      }
      case 'fill': {
        const value = String(call.input.value ?? '');
        const { record, loc } = await resolveAndRecord(ctx, call.input as never);
        await loc.fill(value);
        pushStep(ctx, { kind: 'fill', target: record, value });
        return { ok: true, data: { filled: record.intent } };
      }
      case 'press': {
        const key = String(call.input.key ?? '');
        const { record, loc } = await resolveAndRecord(ctx, call.input as never);
        await loc.press(key);
        pushStep(ctx, { kind: 'press', target: record, key });
        return { ok: true, data: { pressed: key, on: record.intent } };
      }
      case 'wait': {
        const ms = Math.min(Math.max(0, Number(call.input.ms ?? 0)), 3000);
        await ctx.page.waitForTimeout(ms);
        if (ctx.current) pushStep(ctx, { kind: 'wait', ms });
        return { ok: true, data: { waited: ms } };
      }
      case 'get_dom': {
        const summary = await summarizeDom(ctx.page);
        return { ok: true, data: summary };
      }
      case 'assert': {
        return await executeAssertion(ctx, call.input as never);
      }
      case 'end_scenario': {
        if (!ctx.current) return { ok: false, error: 'No scenario to end.' };
        if (!ctx.current.steps.some((s) => s.kind === 'assert')) {
          return { ok: false, error: 'Scenario has no assertions. Add at least one before end_scenario.' };
        }
        if (ctx.consoleErrors.length) ctx.current.consoleErrors = [...ctx.consoleErrors];
        if (ctx.networkErrors.length) ctx.current.networkErrors = [...ctx.networkErrors];
        ctx.scenarios.push(ctx.current);
        ctx.current = null;
        return {
          ok: true,
          data: {
            scenariosSoFar: ctx.scenarios.length,
            consoleErrors: ctx.consoleErrors.length,
            networkErrors: ctx.networkErrors.length,
          },
        };
      }
      case 'finish': {
        // A scenario in progress when finish() is called is an ABANDONED
        // scenario: the agent gave up mid-flow (network failure, gave up
        // after too many retries, etc.). end_scenario already refuses to
        // close an assertion-less scenario; finish must apply the same rule
        // or we'd emit empty specs that pass replay vacuously.
        let dropped = 0;
        if (ctx.current) {
          const hasAssert = ctx.current.steps.some((s) => s.kind === 'assert');
          if (hasAssert) {
            if (ctx.consoleErrors.length) ctx.current.consoleErrors = [...ctx.consoleErrors];
            if (ctx.networkErrors.length) ctx.current.networkErrors = [...ctx.networkErrors];
            ctx.scenarios.push(ctx.current);
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
  },
): Promise<ToolResult> {
  switch (input.type) {
    case 'toBeVisible': {
      const { record, loc } = await resolveAndRecord(ctx, { ...input, intent: input.intent ?? 'element' });
      await expect(loc).toBeVisible();
      pushStep(ctx, { kind: 'assert', name: `${record.intent} is visible`, assertion: { type: 'toBeVisible', target: record } });
      return { ok: true };
    }
    case 'toHaveText':
    case 'toContainText': {
      if (input.text == null) return { ok: false, error: `${input.type} needs text.` };
      const { record, loc } = await resolveAndRecord(ctx, { ...input, intent: input.intent ?? 'element' });
      if (input.type === 'toHaveText') await expect(loc).toHaveText(input.text);
      else await expect(loc).toContainText(input.text);
      pushStep(ctx, {
        kind: 'assert',
        name: `${record.intent} ${input.type === 'toHaveText' ? 'has text' : 'contains'} "${input.text}"`,
        assertion: { type: input.type, target: record, text: input.text },
      });
      return { ok: true };
    }
    case 'toHaveURL': {
      if (input.pattern == null) return { ok: false, error: 'toHaveURL needs pattern.' };
      // The model passes a literal substring. Escape before compiling so a
      // URL like "/auth.app/dashboard" does not turn the dots into "any char".
      const escaped = escapeRegex(input.pattern);
      await expect(ctx.page).toHaveURL(new RegExp(escaped));
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
      const { record } = await resolveAndRecord(ctx, { ...input, intent: input.intent ?? 'element' });
      // toHaveCount needs the multi-match locator; .first() would collapse the
      // count to 1 and any count > 1 assertion would be impossible.
      const countLoc = baseLocator(ctx.page, record);
      await expect(countLoc).toHaveCount(input.count);
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
        testid: r.getAttribute('data-testid') || undefined,
        type: isInput ? input.type || undefined : undefined,
        visible: isVisible(r),
        disabled: (nativeDisabled || r.getAttribute('aria-disabled') === 'true') || undefined,
        required: isInput ? (input.required || r.getAttribute('aria-required') === 'true' || undefined) : undefined,
        readonly: isInput ? (input.readOnly || undefined) : undefined,
        value: isInput ? trunc(input.value, 80) : undefined,
        ariaInvalid: r.getAttribute('aria-invalid') === 'true' || undefined,
        validation: isInput ? trunc(input.validationMessage, 120) : undefined,
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
