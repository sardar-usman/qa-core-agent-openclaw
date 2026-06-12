import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createContext, runTool, TOOL_DEFS, type ToolContext } from './tools.js';
import type { RunReport, Scenario } from './trace.js';
import { renderMemoryBlock, saveRun, type RunSummary } from './memory.js';
import { plan, type PlannedScenario } from './planner.js';
import { critique } from './critic.js';
import { replay, type ReplayEvent } from './replay.js';
import { stability, type StabilityEvent } from './stability.js';
import { installEvalShim } from './eval-shim.js';
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

Assertion economy:
- One strong, specific assertion (an exact error string, the destination URL, a concrete element count) is worth more than several weak ones.
- If you have already asserted the definitive outcome of the scenario, DO NOT pad with redundant toBeVisible / toHaveURL checks on the same state. Padding adds noise and weakens the suite.
- Prefer toHaveText / toContainText / toHaveURL over toBeVisible whenever the outcome can be expressed as text or location.

a11y scenarios must actually exercise accessibility:
- An a11y scenario MUST do one of the following, not just check that something is visible:
  (a) Drive a flow using only the keyboard — use press("Tab") to traverse fields and press("Enter") or press("Space") to activate controls, then assert the outcome.
  (b) Assert on SEMANTIC role / accessible name — e.g. that the page exposes a "main" landmark, an "alert" role for error messages, or that a button is reachable via getByRole rather than CSS.
- For (a), the closing assertion MUST verify the keyboard action SUCCEEDED:
    GOOD: assert toHaveURL("/secure/") after a keyboard-only login (URL changed → login worked).
    GOOD: assert toContainText on a success/error flash that only appears after submit.
    GOOD: assert that the previously-visible login form is now hidden / no longer in the DOM.
    BAD:  assert toBeVisible on the Username input you just typed into (it was visible before, this proves nothing).
    BAD:  end the scenario with no assertion that depends on the keyboard outcome.
- A scenario whose only assertion is toBeVisible on a static element is NOT an a11y scenario. Re-categorize it as happy / edge before ending the scenario.

CRITICAL — each scenario runs in isolation:
- begin_scenario CLEARS cookies, localStorage, and sessionStorage.
- The transcribed spec gives each test a fresh browser context, matching what begin_scenario does here.
- Therefore every scenario MUST be SELF-CONTAINED: include the navigate + any login/setup steps it needs.
- Never write a scenario that assumes the previous scenario left state behind (e.g. "I am already logged in"). If two scenarios share setup, repeat the setup steps in both.

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
   * Skip the replay reality-check (default: enabled). When skipped, the
   * Transcriber emits every recorded scenario whether or not it replays.
   * Disable only for cost-sensitive runs; replay itself is free (no LLM).
   */
  skipReplay?: boolean;
  /** Override the replay step timeout. Defaults to 10s. */
  replayTimeoutMs?: number;
  /**
   * Skip the stability iteration (default: enabled). Stability re-runs every
   * replay survivor N times and drops any that fail an iteration. Free of LLM
   * cost; the trade-off is wall-clock time.
   */
  skipStability?: boolean;
  /** Number of stability iterations per scenario. Defaults to 3. */
  stabilityIterations?: number;
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
  | { type: 'replay_started'; total: number }
  | { type: 'replay_scenario_passed'; name: string; durationMs: number }
  | { type: 'replay_scenario_failed'; name: string; failedStep: number; stepKind: string; error: string }
  | { type: 'replay_done'; passed: number; failed: number; durationMs: number }
  | { type: 'stability_started'; total: number; iterations: number }
  | { type: 'stability_iteration_passed'; name: string; iteration: number; durationMs: number }
  | { type: 'stability_iteration_failed'; name: string; iteration: number; failedStep: number; stepKind: string; error: string }
  | { type: 'stability_done'; stable: number; flaked: number; iterations: number; flakeRate: number; durationMs: number }
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
    await installEvalShim(context);
    const page: Page = await context.newPage();

    const ctx = createContext(page, maxSteps);
    const explorerCost = await runAgentLoop({
      client, model, maxUsd, price,
      ctx, url: opts.url,
      plan: planResult.scenarios,
      onEvent: opts.onEvent,
    });

    // The agent must call finish; if it didn't, capture whatever it did record
    // — but apply the SAME assertion guard end_scenario and finish enforce.
    // Without this, a scenario the agent began and then abandoned (timed out,
    // turn limit, gave up on a keyboard a11y flow) lands in the spec with
    // zero steps or no asserts. Empty scenarios pass Replay / Stability /
    // Playwright runtime vacuously and silently inflate failure rates.
    if (ctx.current) {
      const hasAssert = ctx.current.steps.some((s) => s.kind === 'assert');
      if (hasAssert) ctx.scenarios.push(ctx.current);
    }
    scenarios = ctx.scenarios;
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

  // Step 4 — Reality check (replay). Re-execute every scenario in a fresh
  // Playwright context and drop the ones that fail. Survivors are what the
  // Transcriber emits. Zero LLM cost; this is just Playwright.
  let replayInfo: RunReport['replay'];
  let emittedScenarios = scenarios;
  if (!opts.skipReplay && scenarios.length > 0) {
    try {
      const storageStatePath = path.join(process.cwd(), 'playwright', '.auth', 'user.json');
      const r = await replay({
        scenarios,
        storageStatePath,
        timeoutMs: opts.replayTimeoutMs,
        onEvent: (ev: ReplayEvent) => {
          switch (ev.type) {
            case 'replay_started':
              opts.onEvent?.({ type: 'replay_started', total: ev.total });
              return;
            case 'scenario_passed':
              opts.onEvent?.({ type: 'replay_scenario_passed', name: ev.name, durationMs: ev.durationMs });
              return;
            case 'scenario_failed':
              opts.onEvent?.({
                type: 'replay_scenario_failed',
                name: ev.name,
                failedStep: ev.failedStep,
                stepKind: ev.stepKind,
                error: ev.error,
              });
              return;
            case 'replay_done':
              opts.onEvent?.({
                type: 'replay_done',
                passed: ev.passed,
                failed: ev.failed,
                durationMs: ev.durationMs,
              });
              return;
            default:
              return;
          }
        },
      });
      emittedScenarios = r.emitted;
      replayInfo = {
        passed: r.emitted.length,
        failed: r.dropped.length,
        durationMs: r.durationMs,
        verdicts: r.verdicts,
      };
    } catch (err) {
      opts.onEvent?.({ type: 'message', text: `Replay skipped: ${(err as Error).message}` });
      replayInfo = { skipped: true, passed: 0, failed: 0, durationMs: 0, verdicts: [] };
    }
  } else if (opts.skipReplay) {
    replayInfo = { skipped: true, passed: 0, failed: 0, durationMs: 0, verdicts: [] };
  }

  // Step 5 — Stability iteration. Re-execute each replay survivor N times and
  // drop the ones that pass-then-fail. Only scenarios that pass every
  // iteration make it into the final emitted spec.
  let stabilityInfo: RunReport['stability'];
  if (!opts.skipStability && emittedScenarios.length > 0) {
    try {
      const storageStatePath = path.join(process.cwd(), 'playwright', '.auth', 'user.json');
      const s = await stability({
        scenarios: emittedScenarios,
        storageStatePath,
        iterations: opts.stabilityIterations,
        timeoutMs: opts.replayTimeoutMs,
        onEvent: (ev: StabilityEvent) => {
          switch (ev.type) {
            case 'stability_started':
              opts.onEvent?.({ type: 'stability_started', total: ev.total, iterations: ev.iterations });
              return;
            case 'iteration_passed':
              opts.onEvent?.({
                type: 'stability_iteration_passed',
                name: ev.name,
                iteration: ev.iteration,
                durationMs: ev.durationMs,
              });
              return;
            case 'iteration_failed':
              opts.onEvent?.({
                type: 'stability_iteration_failed',
                name: ev.name,
                iteration: ev.iteration,
                failedStep: ev.failedStep,
                stepKind: ev.stepKind,
                error: ev.error,
              });
              return;
            case 'stability_done':
              opts.onEvent?.({
                type: 'stability_done',
                stable: ev.stable,
                flaked: ev.flaked,
                iterations: ev.iterations,
                flakeRate: ev.flakeRate,
                durationMs: ev.durationMs,
              });
              return;
            default:
              return;
          }
        },
      });
      emittedScenarios = s.emitted;
      stabilityInfo = {
        iterations: s.iterations,
        passed: s.emitted.length,
        flaked: s.flaked.length,
        flaky: s.flaky.length,
        broken: s.broken.length,
        flakeRate: s.flakeRate,
        durationMs: s.durationMs,
        verdicts: s.verdicts,
      };
    } catch (err) {
      opts.onEvent?.({ type: 'message', text: `Stability skipped: ${(err as Error).message}` });
      stabilityInfo = {
        skipped: true,
        iterations: opts.stabilityIterations ?? 3,
        passed: 0,
        flaked: 0,
        flakeRate: 0,
        durationMs: 0,
        verdicts: [],
      };
    }
  } else if (opts.skipStability) {
    stabilityInfo = {
      skipped: true,
      iterations: opts.stabilityIterations ?? 3,
      passed: 0,
      flaked: 0,
      flakeRate: 0,
      durationMs: 0,
      verdicts: [],
    };
  }

  const report: RunReport = {
    url: opts.url,
    language: opts.language,
    scenarios: emittedScenarios,
    cascadeStats,
    cost,
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
    plan: planResult.scenarios.length > 0 ? planResult.scenarios : undefined,
    review,
    replay: replayInfo,
    stability: stabilityInfo,
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
  try { saveRun(summary); } catch (err) {
    // Memory is best-effort, but silent failure is worse than a one-line warning.
    process.stderr.write(`[qa-core] memory save failed: ${(err as Error).message}\n`);
  }

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
