import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { resolve, type CascadeLevel } from './selectors.js';
import type { Assertion, Scenario, SelectorRecord, TraceStep } from './trace.js';

/**
 * Tool surface exposed to Claude via tool-use. Each function returns a
 * structured JSON result the model can reason over; failures surface as
 * `{ ok: false, error }` so the agent can recover instead of crashing.
 */

export interface ToolContext {
  page: Page;
  /** Mutated by tool calls. The transcriber consumes this at the end. */
  scenarios: Scenario[];
  current: Scenario | null;
  cascadeStats: Record<CascadeLevel, number>;
  steps: number;
  maxSteps: number;
}

export function createContext(page: Page, maxSteps: number): ToolContext {
  return {
    page,
    scenarios: [],
    current: null,
    cascadeStats: { role: 0, label: 0, testid: 0, css: 0 },
    steps: 0,
    maxSteps,
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

/**
 * JSON-schema tool definitions sent to Claude. Keep these tight — every
 * extra field eats tokens and clouds the model's choice.
 */
export const TOOL_DEFS = [
  {
    name: 'begin_scenario',
    description:
      'Start a new test scenario. Call this before any actions. Categories: happy (positive path), negative (invalid input / error states), edge (boundary conditions), a11y (accessibility).',
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
    description: 'Navigate the browser to a URL. Must be called at least once before any other action.',
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
    description: 'Wait for a fixed number of milliseconds. Use sparingly; prefer assertions that auto-wait.',
    input_schema: {
      type: 'object',
      properties: { ms: { type: 'number' } },
      required: ['ms'],
    },
  },
  {
    name: 'get_dom',
    description:
      'Return a pruned summary of the visible interactive elements on the page (forms, buttons, inputs, links, headings). Use this to decide what to do next.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'assert',
    description:
      'Record an assertion as part of the current scenario. Use this for the verifiable outcome of the actions you took.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['toBeVisible', 'toHaveText', 'toContainText', 'toHaveURL', 'toHaveCount'],
        },
        intent: { type: 'string', description: 'For element assertions: the target element intent.' },
        role: { type: 'string' },
        label: { type: 'string' },
        testid: { type: 'string' },
        css: { type: 'string' },
        text: { type: 'string', description: 'For text assertions.' },
        pattern: { type: 'string', description: 'For URL assertions (substring or regex source).' },
        count: { type: 'number', description: 'For count assertions.' },
      },
      required: ['type'],
    },
  },
  {
    name: 'end_scenario',
    description: 'Finish the current scenario. Always call this after the scenario completes.',
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
  input: {
    intent: string;
    role?: string;
    label?: string;
    testid?: string;
    css?: string;
  },
): Promise<{ record: SelectorRecord; loc: import('@playwright/test').Locator }> {
  const resolved = await resolve(ctx.page, input);
  if (!resolved) {
    throw new Error(`Could not resolve element: ${input.intent} (hints: ${JSON.stringify(input)})`);
  }
  ctx.cascadeStats[resolved.level] = (ctx.cascadeStats[resolved.level] ?? 0) + 1;
  return {
    record: { level: resolved.level, arg: resolved.arg, intent: input.intent },
    loc: resolved.locator,
  };
}

/**
 * Dispatch a tool call. The runtime wraps every invocation in try/catch
 * and returns `{ ok: false, error }` for the model to recover from.
 */
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
        ctx.current = { name, category, steps: [] };
        return { ok: true, data: { name, category } };
      }
      case 'navigate': {
        const url = String(call.input.url ?? '');
        if (!/^https?:\/\//.test(url)) return { ok: false, error: 'navigate requires an http(s) URL.' };
        await ctx.page.goto(url, { waitUntil: 'domcontentloaded' });
        if (ctx.current) pushStep(ctx, { kind: 'navigate', url });
        return { ok: true, data: { url: ctx.page.url() } };
      }
      case 'click': {
        const { record, loc } = await resolveAndRecord(ctx, call.input as never);
        await loc.click();
        pushStep(ctx, { kind: 'click', target: record });
        return { ok: true, data: { clicked: record.intent } };
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
        const ms = Math.min(Math.max(0, Number(call.input.ms ?? 0)), 5000);
        await ctx.page.waitForTimeout(ms);
        if (ctx.current) pushStep(ctx, { kind: 'wait', ms });
        return { ok: true, data: { waited: ms } };
      }
      case 'get_dom': {
        const summary = await summarizeDom(ctx.page);
        return { ok: true, data: summary };
      }
      case 'assert': {
        const result = await executeAssertion(ctx, call.input as never);
        return result;
      }
      case 'end_scenario': {
        if (!ctx.current) return { ok: false, error: 'No scenario to end.' };
        if (!ctx.current.steps.some((s) => s.kind === 'assert')) {
          return { ok: false, error: 'Scenario has no assertions. Add at least one before end_scenario.' };
        }
        ctx.scenarios.push(ctx.current);
        ctx.current = null;
        return { ok: true, data: { scenariosSoFar: ctx.scenarios.length } };
      }
      case 'finish': {
        if (ctx.current) ctx.scenarios.push(ctx.current);
        ctx.current = null;
        return { ok: true, data: { done: true, scenarios: ctx.scenarios.length } };
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
      await expect(loc).toBeVisible({ timeout: 5000 });
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
      await expect(ctx.page).toHaveURL(new RegExp(input.pattern));
      if (ctx.current) {
        pushStep(ctx, {
          kind: 'assert',
          name: `URL matches /${input.pattern}/`,
          assertion: { type: 'toHaveURL', pattern: input.pattern },
        });
      }
      return { ok: true };
    }
    case 'toHaveCount': {
      if (input.count == null) return { ok: false, error: 'toHaveCount needs count.' };
      const { record, loc } = await resolveAndRecord(ctx, { ...input, intent: input.intent ?? 'element' });
      await expect(loc).toHaveCount(input.count);
      pushStep(ctx, {
        kind: 'assert',
        name: `${record.intent} count is ${input.count}`,
        assertion: { type: 'toHaveCount', target: record, count: input.count },
      });
      return { ok: true };
    }
  }
}

/**
 * Return a pruned, agent-friendly view of the page: title, URL, headings,
 * interactive controls with their accessible names.
 *
 * We deliberately cap output so the agent doesn't burn tokens on huge pages.
 */
async function summarizeDom(page: Page): Promise<unknown> {
  return await page.evaluate(() => {
    const MAX = 60;
    const pick = (el: Element) => {
      const r = (el as HTMLElement);
      const label =
        r.getAttribute('aria-label') ||
        r.getAttribute('placeholder') ||
        r.getAttribute('name') ||
        (r.textContent ?? '').trim().slice(0, 80);
      return {
        tag: r.tagName.toLowerCase(),
        role: r.getAttribute('role') || undefined,
        label: label || undefined,
        testid: r.getAttribute('data-testid') || undefined,
        type: (r as HTMLInputElement).type || undefined,
        visible: !!(r as HTMLElement).offsetParent,
      };
    };
    const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 10).map(pick);
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).slice(0, MAX).map(pick);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, MAX).map(pick);
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 30).map(pick);
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
