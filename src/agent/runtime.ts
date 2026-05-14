import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createContext, runTool, TOOL_DEFS, type ToolContext } from './tools.js';
import type { RunReport, Scenario } from './trace.js';
import { renderMemoryBlock, saveRun, type RunSummary } from './memory.js';
import { plan, type PlannedScenario } from './planner.js';
import { critique } from './critic.js';
import type { CascadeLevel } from './selectors.js';
import { writeCsv } from './csv.js';

/**
 * Agent runtime — agentic tool-use loop on Claude.
 *
 * The agent explores a URL by interacting with a real Playwright browser via
 * tool calls. Every action it takes is verified before the next step. At the
 * end, the trace is handed to the transcriber which emits a Playwright spec.
 *
 * This is fundamentally more reliable than "generate code from a DOM dump"
 * because the generated spec is a transcription of a session that ran.
 */

const SYSTEM_PROMPT = `You are QA-Core, an autonomous QA agent that generates Playwright tests by exploring a web application like an experienced tester would.

You will be given a URL. Your job:

1. Navigate to the URL.
2. Use get_dom to understand what's on the page.
3. For each meaningful flow, call begin_scenario, then drive Playwright through the steps you would take to verify it, then call assert at least once, then end_scenario.
4. Cover happy paths AND at least one negative case AND one accessibility-friendly check (e.g. that landmark elements have the right roles or that error states are announced).
5. Call finish when you have 3-6 well-formed scenarios.

Rules:
- Describe selectors by INTENT first (e.g. "username input", "submit button") and let the cascade resolve them. Provide hints (role, label, testid, css) when you can see them in the DOM.
- Never assert on something you have not seen visible. Every scenario must have at least one assert.
- Negative scenarios should record assertions on the failure state (e.g. an error message appearing), not on success URLs.
- Stay within your step budget. Be decisive. Do not loop on get_dom.

Do not write code. Use the tools.`;

export interface ExploreOptions {
  url: string;
  language: 'ts' | 'js';
  maxSteps?: number;
  maxUsd?: number;
  model?: string;
  outDir: string;
  /** Skip the Planner pre-step (default: enabled). */
  skipPlan?: boolean;
  /** Skip the Critic post-step (default: enabled). */
  skipCritic?: boolean;
  /**
   * Review mode: after Planner runs, export the scenario list to plan.csv and
   * exit. Resume the run with `fromPlan` once the CSV has been reviewed.
   */
  review?: boolean;
  /**
   * Pre-approved scenario list — skips the Planner stage and feeds these
   * directly to the Explorer. Used when resuming from a reviewed plan.csv.
   */
  fromPlan?: PlannedScenario[];
  onEvent?: (event: AgentEvent) => void;
}

/**
 * Result of a paused review-mode run.
 *
 * The runtime returns this instead of a RunReport when review mode is active.
 * Callers should treat it as a terminal state and resume from the CSV later.
 */
export interface ReviewPaused {
  paused: true;
  planPath: string;
  scenarios: PlannedScenario[];
  outDir: string;
  url: string;
  language: 'ts' | 'js';
}

export type AgentEvent =
  | { type: 'plan_started' }
  | { type: 'plan_done'; scenarios: PlannedScenario[]; usd: number }
  | { type: 'review_paused'; planPath: string; scenarios: PlannedScenario[] }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; data?: unknown; error?: string }
  | { type: 'thinking_started' }
  | { type: 'message'; text: string }
  | { type: 'usage'; usd: number; tokens: number }
  | { type: 'critic_started' }
  | { type: 'critic_done'; verdicts: Array<{ scenario: string; verdict: string; reason: string }>; usd: number }
  | { type: 'done'; scenarios: number };

const PRICE = {
  // USD per million tokens.
  'claude-opus-4-7':   { in: 5.0,  out: 25.0, cacheRead: 0.5,  cacheWrite: 6.25 },
  'claude-sonnet-4-6': { in: 3.0,  out: 15.0, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5':  { in: 1.0,  out: 5.0,  cacheRead: 0.1,  cacheWrite: 1.25 },
} as const;

type ModelId = keyof typeof PRICE;

function priceFor(model: string): (typeof PRICE)[ModelId] {
  if (model in PRICE) return PRICE[model as ModelId];
  return PRICE['claude-opus-4-7'];
}

export async function explore(opts: ExploreOptions): Promise<RunReport | ReviewPaused> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.');

  const maxSteps = opts.maxSteps ?? Number(process.env.QA_CORE_MAX_STEPS ?? 40);
  const maxUsd = opts.maxUsd ?? Number(process.env.QA_CORE_MAX_USD ?? 2);
  const model = opts.model ?? process.env.QA_CORE_MODEL_EXPLORE ?? 'claude-opus-4-7';
  const price = priceFor(model);

  const client = new Anthropic({ apiKey });
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Step 1 — Planner (Haiku). Cheap, gives Explorer a guide.
  // Three paths through this stage:
  //   a) fromPlan supplied  → skip Planner entirely, use the approved list
  //   b) skipPlan set       → no plan at all (Explorer wanders on its own)
  //   c) default            → run Planner, then either pause (review) or continue
  let planResult: { scenarios: PlannedScenario[]; usd: number } = {
    scenarios: opts.fromPlan ?? [],
    usd: 0,
  };

  if (!opts.fromPlan && !opts.skipPlan) {
    opts.onEvent?.({ type: 'plan_started' });
    try {
      const p = await plan({ url: opts.url, apiKey });
      planResult = { scenarios: p.scenarios, usd: p.costUsd };
      opts.onEvent?.({ type: 'plan_done', scenarios: p.scenarios, usd: p.costUsd });

      // Review mode — write the CSV and pause. The caller resumes via fromPlan.
      if (opts.review) {
        fs.mkdirSync(opts.outDir, { recursive: true });
        const planPath = path.join(opts.outDir, 'plan.csv');
        fs.writeFileSync(planPath, scenariosToCsv(opts.url, p.scenarios));
        opts.onEvent?.({ type: 'review_paused', planPath, scenarios: p.scenarios });
        return {
          paused: true,
          planPath,
          scenarios: p.scenarios,
          outDir: opts.outDir,
          url: opts.url,
          language: opts.language,
        };
      }
    } catch (err) {
      // Planning failure shouldn't fail the whole run — Explorer can still proceed without a plan.
      opts.onEvent?.({ type: 'message', text: `Planner skipped: ${(err as Error).message}` });
    }
  }

  // Step 2 — Explorer (Opus). The tool-use loop.
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let scenarios: Scenario[] = [];
  let cascadeStats: Record<CascadeLevel, number> = { role: 0, label: 0, testid: 0, css: 0 };
  let steps = 0;
  let cost: RunReport['cost'] = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    usd: 0, plannerUsd: planResult.usd,
  };

  try {
    browser = await chromium.launch({ headless: true });
    const storageStatePath = path.join(process.cwd(), 'playwright', '.auth', 'user.json');
    context = await browser.newContext(
      fs.existsSync(storageStatePath) ? { storageState: storageStatePath } : undefined,
    );
    const page: Page = await context.newPage();

    const ctx = createContext(page, maxSteps);
    const explorerCost = await runAgentLoop({
      client, model, maxUsd, price,
      ctx, url: opts.url,
      plan: planResult.scenarios,
      onEvent: opts.onEvent,
    });

    // The agent must call finish; if it didn't, capture whatever it did record.
    scenarios = ctx.current
      ? (ctx.scenarios.push(ctx.current), ctx.scenarios)
      : ctx.scenarios;
    cascadeStats = ctx.cascadeStats;
    steps = ctx.steps;
    cost = { ...explorerCost, plannerUsd: planResult.usd };
  } finally {
    await context?.close();
    await browser?.close();
  }

  // Step 3 — Critic (Sonnet). Reviews what the Explorer recorded.
  let review: RunReport['review'];
  if (!opts.skipCritic && scenarios.length > 0) {
    opts.onEvent?.({ type: 'critic_started' });
    try {
      const c = await critique({ scenarios, url: opts.url, apiKey });
      review = { verdicts: c.verdicts, summary: c.summary };
      cost.criticUsd = c.costUsd;
      opts.onEvent?.({ type: 'critic_done', verdicts: c.verdicts, usd: c.costUsd });
    } catch (err) {
      opts.onEvent?.({ type: 'message', text: `Critic skipped: ${(err as Error).message}` });
    }
  }

  const report: RunReport = {
    url: opts.url,
    language: opts.language,
    scenarios,
    cascadeStats,
    cost,
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
    plan: planResult.scenarios.length > 0 ? planResult.scenarios : undefined,
    review,
  };

  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(
    path.join(opts.outDir, 'run-report.json'),
    JSON.stringify(report, null, 2),
  );

  // Persist what we learned for future runs against the same host.
  const resolvedIntents = collectResolvedIntents(scenarios);
  const summary: RunSummary = {
    url: opts.url,
    scenarios: scenarios.length,
    cost: (cost.usd ?? 0) + (cost.plannerUsd ?? 0) + (cost.criticUsd ?? 0),
    model,
    durationSec: Math.round((Date.now() - startMs) / 1000),
    cascadeStats,
    resolvedIntents,
  };
  try { saveRun(summary); } catch { /* memory is best-effort */ }

  opts.onEvent?.({ type: 'done', scenarios: scenarios.length });
  return report;
}

/** Convert planned scenarios to a reviewable CSV. */
function scenariosToCsv(url: string, scenarios: PlannedScenario[]): string {
  const header = `# QA-Core review plan for ${url}\n# Set Approve=no on any row you do not want to test, then resume with:\n#   npm run explore -- --from-plan <this-file>\n\n`;
  return header + writeCsv(
    scenarios.map((s, i) => ({
      '#': String(i + 1),
      Category: s.category,
      Scenario: s.name,
      Rationale: s.rationale,
      Approve: 'yes',
    })),
    ['#', 'Category', 'Scenario', 'Rationale', 'Approve'],
  );
}

/** Walk every scenario's trace and collect the intent + cascade level each selector resolved at. */
function collectResolvedIntents(scenarios: Scenario[]): Array<{ intent: string; level: CascadeLevel }> {
  const out: Array<{ intent: string; level: CascadeLevel }> = [];
  for (const s of scenarios) {
    for (const step of s.steps) {
      if (step.kind === 'click' || step.kind === 'fill' || step.kind === 'press') {
        out.push({ intent: step.target.intent, level: step.target.level });
      } else if (step.kind === 'assert') {
        const a = step.assertion;
        if (a.type !== 'toHaveURL') out.push({ intent: a.target.intent, level: a.target.level });
      }
    }
  }
  return out;
}

async function runAgentLoop(args: {
  client: Anthropic;
  model: string;
  maxUsd: number;
  price: (typeof PRICE)[ModelId];
  ctx: ToolContext;
  url: string;
  plan: PlannedScenario[];
  onEvent?: ExploreOptions['onEvent'];
}): Promise<RunReport['cost']> {
  const { client, model, maxUsd, price, ctx, url, onEvent } = args;

  const cost = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 };

  // Build a system prompt with three cached blocks:
  //   1. Frozen behavior rules (SYSTEM_PROMPT) — never changes, max cache value
  //   2. Site memory — changes per host, still cacheable per host
  //   3. Plan — changes per run, but stable through the loop
  const memoryBlock = renderMemoryBlock(url);
  const planText = args.plan.length > 0
    ? 'Planned scenarios (cover all of these unless a scenario is impossible from this page):\n' +
      args.plan.map((p, i) => `  ${i + 1}. [${p.category}] ${p.name} — ${p.rationale}`).join('\n')
    : null;

  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam,
  ];
  if (memoryBlock) {
    systemBlocks.push({ type: 'text', text: memoryBlock, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam);
  }
  if (planText) {
    systemBlocks.push({ type: 'text', text: planText } as Anthropic.TextBlockParam);
  }

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `Explore the following URL and produce a Playwright test plan: ${url}` },
  ];

  for (let turn = 0; turn < 30; turn++) {
    if (cost.usd > maxUsd) {
      throw new Error(`Cost ceiling exceeded ($${cost.usd.toFixed(3)} > $${maxUsd}). Aborting.`);
    }

    onEvent?.({ type: 'thinking_started' });

    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      system: systemBlocks,
      tools: TOOL_DEFS as unknown as Anthropic.Tool[],
      messages,
    });

    const u = response.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    cost.inputTokens += u.input_tokens;
    cost.outputTokens += u.output_tokens;
    cost.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    cost.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    cost.usd =
      (cost.inputTokens * price.in +
        cost.outputTokens * price.out +
        cost.cacheReadTokens * price.cacheRead +
        cost.cacheCreationTokens * price.cacheWrite) / 1_000_000;
    onEvent?.({ type: 'usage', usd: cost.usd, tokens: cost.inputTokens + cost.outputTokens });

    // Surface any narration the model emits.
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        onEvent?.({ type: 'message', text: block.text });
      }
    }

    if (response.stop_reason !== 'tool_use') {
      // Agent stopped without calling finish — accept what's there.
      break;
    }

    // Execute every tool_use block from this turn, then feed results back.
    const assistantContent: Anthropic.ContentBlock[] = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let finished = false;
    for (const block of assistantContent) {
      if (block.type !== 'tool_use') continue;
      onEvent?.({ type: 'tool_call', name: block.name, input: block.input });
      const result = await runTool(ctx, {
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
      onEvent?.({ type: 'tool_result', name: block.name, ok: result.ok, data: result.data, error: result.error });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        is_error: !result.ok,
        content: JSON.stringify(result.ok ? (result.data ?? { ok: true }) : { error: result.error }),
      });
      if (block.name === 'finish' && result.ok) finished = true;
    }

    messages.push({ role: 'user', content: toolResults });
    if (finished) break;
  }

  return cost;
}
