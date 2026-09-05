import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createContext, runTool, TOOL_DEFS, type ToolContext } from './tools.js';
import type { RunReport, Scenario } from './trace.js';
import { renderMemoryBlock, saveRun, type RunSummary } from './memory.js';
import { plan, type PlannedScenario } from './planner.js';
import { critique, gateByVerdicts } from './critic.js';
import { replay, type ReplayEvent } from './replay.js';
import { stability, type StabilityEvent } from './stability.js';
import { reconcile } from './reconcile.js';
import { attachRuleIds, computeRuleCoverage, renderRuleCoverage } from './rule-coverage.js';
import type { RequirementsMap } from './requirements.js';
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
- Match the tool to the control type. Look at the element's tag and type in get_dom before you act:
  - <select> dropdown: use select_option, never fill. Pass optionValue, optionLabel (the visible text), or optionIndex. The DOM summary lists each select's options so you can pass a real value.
  - checkbox or radio (input type=checkbox / type=radio): use set_checked, never fill.
  - file input (input type=file): use set_input_files.
  - text input or textarea: use fill.
  fill auto-corrects if you point it at the wrong control, but choose the right tool so the intent is clear.
- Never assert on something you have not seen visible. Every scenario must have at least one assert.
- Negative scenarios should record assertions on the failure state (e.g. an error message appearing), not on success URLs.
- Stay within your step budget. Be decisive. Do not loop on get_dom.

Feature tagging — IMPORTANT:
- When you call begin_scenario, pass a \`feature\` field tagging which feature this scenario belongs to (e.g. "login", "cart", "search", "checkout").
- The framework groups page objects and tests by feature. All "login" scenarios share pages/login-page.ts and live under tests/login/. All "cart" scenarios share pages/cart-page.ts and tests/cart/. Etc.
- If a Plan with feature names was provided in this system prompt, use those exact names verbatim. Don't invent variants or aliases ("login" not "logging-in", "auth" not "authentication").
- If no plan was provided and you are inferring features yourself, pick the simplest noun for the page: "login" for an auth form, "cart" for a shopping cart, "search" for a search interface, etc. Use kebab-case for multi-word features ("forgot-password", "user-profile").

Animated and time-varying elements — CRITICAL:
- Semantic state attributes win over text. When an element exposes an ARIA value/state attribute (aria-valuenow, aria-checked, aria-selected, aria-expanded, aria-pressed), assert THAT attribute, never the displayed text. A progress bar at completion is asserted as aria-valuenow="100", NOT toHaveText("100%"). The attribute is what assistive tech reads and it does not depend on display formatting. wait_for_text already records the attribute automatically when the element exposes one, so keep using it for completion — it will emit the aria-valuenow assertion for you.
- For elements whose value changes over time (progress bars, countdown timers, loading spinners, toast messages), use wait_for_text to wait for the terminal state instead of stacking wait() calls. wait_for_text polls until the target is reached or times out — it is immune to timing variance. Fixed waits fail whenever the page is even 100ms slower than expected.
- After clicking Stop or Pause on a value widget, use assert_freeze with attribute="aria-valuenow". It reads the value, waits a bounded interval under 1000ms, re-reads, and asserts the two readings are equal AND strictly between aria-valuemin and aria-valuemax. That proves the animation stopped mid-progress without depending on catching any specific number. For an animated element with no ARIA value attribute, call assert_freeze without attribute to compare its text across two reads.
- Never assert an exact intermediate value of a continuously changing element (for example "30%" or aria-valuenow="30"). You cannot reliably catch a specific number mid-animation. Use wait_for_text for the terminal state, or assert_freeze for the stopped state.

ASSERTION RULES — apply before every end_scenario:

1. Match assertion to scenario category. Never copy the happy-path final-state assertion onto a negative, edge, or a11y scenario unless that exact state is genuinely the expected outcome for that case. Before writing an edge or negative assertion, state the expected behavior for that specific case, then assert it. Example: for "start clicked while already running", the expected behavior is that the animation is not reset — assert that, not a copied "100%" check that may never be true.

2. Use web-first auto-retry assertions: toHaveText, toHaveAttribute, toBeVisible, toHaveValue. For any assertion that depends on animation or async state, set an explicit timeout of 15000 on the assert call. Do not read a value with get_dom and then assert that same value statically — use wait_for_text or assert with a timeout and let Playwright poll. The one exception is the capture-and-compare flow in rule 8: there you capture the REAL value with the capture tool and assert_compare how it changed, never a static literal you typed.

3. a11y assertions must check accessibility properties, not just visible text. Use toHaveAttribute to assert role="progressbar", aria-valuenow, aria-valuemin, aria-valuemax. Use getByRole to assert a control is keyboard-reachable. A keyboard flow test must assert that the keyboard action SUCCEEDED (URL changed, success message appeared, form hidden) — not just that a static element is visible.

4. Assertion specificity: prefer exact attribute values or exact text over substring matches. Never assert a bare "%" substring. If the element exposes a semantic ARIA state attribute, you MUST assert that attribute, not the text. For a progress bar reaching completion that means aria-valuenow="100" (wait_for_text records this automatically), never toHaveText("100%"). Text is a fallback only when the element has no semantic attribute.

5. Locator priority: getByRole first, then getByLabel, then getByText, then getByTestId, then CSS only as a last resort. Provide the highest-tier hint available in the DOM. Record which tier resolved (role, label, placeholder, testid, css).

6. Every scenario must have at least one meaningful assertion before end_scenario. If assert_freeze or wait_for_text returns an error, stop and surface the error — do not silently retry with a weaker assertion. Retrying with toBeVisible after a freeze failure hides the bug and inflates cost.

7. Falsifiability. The main assertion of every scenario must be able to FAIL if the feature breaks. Banned as the primary assertion: visibility of an element that was already visible before the action, a bare "URL did not change" check, and "the element is still present". Each of those passes even when the feature is broken, so they prove nothing on their own. Use them only as a secondary sanity check. Before end_scenario, ask "what bug would turn this red?" — if the answer is nothing specific, the assertion is too weak.

8. Value-change features. When the point of the page is that a value changes (a regenerating id, a rotating token, an incrementing counter, a shuffled order), use the capture-and-compare tools — never type the value yourself. The flow is exactly three steps:
   a. capture — read the REAL value off the page into a named variable. Pass a name and the source: source="attribute" with attribute="id" for a regenerating id, source="text" for visible text, source="count" for a list length. Give the same locator hints (role/label/css) you would for any element.
   b. perform the action — reload, click, resubmit, whatever triggers the change.
   c. assert_compare — pass the SAME name and the relation: "changed" for an id/token that must regenerate, "greater" or "less" for a count that must move, "absent" when the old value must no longer match any element, "equal"/"unchanged" when it must hold.
   Concrete dynamic-id example: capture {name:"oldId", source:"attribute", attribute:"id", role:"button", label:"..."} → click the button → assert_compare {name:"oldId", relation:"changed"}. The comparison runs against the real captured id, so it fails exactly when the id stops regenerating. NEVER invent a placeholder like "button-fixed-id" or "previously-captured-id-12345" — capture reads the truth from the page. A value that is supposed to stay STABLE uses assert_freeze, which is the same primitive with relation="unchanged".

9. Unverified success signals. A happy-path assertion is only as good as the signal it checks. If the plan says "lands on /auth/login" or "redirects to /dashboard" but you submit and the page stays put, the redirect was assumed, not real. Do NOT re-fill the whole form and resubmit again and again hoping it works the next time. After one honest retry, stop. Look at what the page ACTUALLY did: read the URL with get_dom, look for a visible success or error message, a toast, an inline validation error. Then assert the real signal you can see (the confirmation message, the cleared form, the error that explains the rejection). If the expected outcome genuinely did not occur, that is a real finding, not something to retry: the system records what the page did. Once a scenario is recorded as a finding, do NOT re-attempt that same flow with different data. Move on to the OTHER planned scenarios (the negative and edge cases) first, so a single expensive happy path does not starve them. Come back to re-attempt the flow only if every other scenario is already done and budget remains. Never burn the budget thrashing one scenario on a success signal that may be wrong. Do NOT call wait() to let the page settle after a submit; wait() is rejected inside a scenario. Use wait_for_text for the state you expect, or assert with a timeout and let Playwright poll. To just re-read the page, call get_dom.

Assertion economy:
- One strong, specific assertion (an exact error string, the destination URL, a concrete element count) is worth more than several weak ones.
- If you have already asserted the definitive outcome of the scenario, DO NOT pad with redundant toBeVisible / toHaveURL checks on the same state. Padding adds noise and weakens the suite.
- Prefer toHaveText / toHaveAttribute / toHaveURL over toBeVisible whenever the outcome can be expressed as text, an attribute value, or a URL.

a11y scenarios must actually exercise accessibility:
- An a11y scenario MUST do one of the following, not just check that something is visible:
  (a) Drive a flow using only the keyboard — use press("Tab") to traverse fields and press("Enter") or press("Space") to activate controls, then assert the outcome.
  (b) Assert on ARIA attributes — use assert(toHaveAttribute) to check role, aria-valuenow, aria-valuemin, aria-valuemax, aria-label on controls. For a progress bar: assert role="progressbar", aria-valuemin="0", aria-valuemax="100", and that aria-valuenow updates to "100" after completion.
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
   * Enable Stage 5b — the Stabilizer. Defaults to true. When true, flaky
   * scenarios get one LLM-guided fix attempt (wait insertion or selector
   * swap) before being dropped. Set false for offline / fully deterministic
   * stability (no Sonnet call on flake).
   */
  stabilize?: boolean;
  /** Override the model used by the Stabilizer. Defaults to claude-sonnet-4-6. */
  stabilizerModel?: string;
  /**
   * Max number of Stabilizer fix attempts per flaky scenario. Defaults to 3.
   * Each attempt: LLM proposes a fix → patched scenario re-runs the
   * stability iterations → stop if stable, otherwise feed the failure
   * pattern back to the LLM for a different proposal.
   */
  maxStabilizeAttempts?: number;
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
  /**
   * Feature list (e.g. ['login', 'cart']). When present, the Planner is
   * steered to propose scenarios ONLY for these features. Empty/undefined
   * → Planner infers 2-3 highest-signal flows from the homepage snapshot.
   * Ignored when `fromPlan` is supplied (the plan already defines scope).
   */
  features?: string[];
  /**
   * Optional requirements map built from an SRS (--srs). Flows to the Planner
   * for rule-first planning, and the run ends with a rule-coverage report
   * (report.ruleCoverage + rule-coverage.json in the output directory).
   */
  requirements?: RequirementsMap;
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
  | { type: 'critic_done'; verdicts: Array<{ scenario: string; verdict: string; reasons: string[]; required_fixes: string[] }>; usd: number }
  | { type: 'replay_started'; total: number }
  | { type: 'replay_scenario_passed'; name: string; durationMs: number }
  | { type: 'replay_scenario_failed'; name: string; failedStep: number; stepKind: string; error: string }
  | { type: 'replay_done'; passed: number; failed: number; durationMs: number }
  | { type: 'stability_started'; total: number; iterations: number }
  | { type: 'stability_iteration_passed'; name: string; iteration: number; durationMs: number }
  | { type: 'stability_iteration_failed'; name: string; iteration: number; failedStep: number; stepKind: string; error: string }
  | { type: 'stability_done'; stable: number; flaked: number; recovered?: number; iterations: number; flakeRate: number; durationMs: number; stabilizerCostUsd?: number }
  | { type: 'gate_injection'; scenario: string; step: number; assertionType: string; detail: string }
  | { type: 'gate_broken'; scenario: string; reason: string; attempts: number }
  // Reports an IN-RUN SELECTOR RECOVERY (a locator that failed to resolve was
  // re-resolved a different stable way during exploration). The type stays
  // 'heal' and the payload shape stays fixed because the dashboard consumes it.
  | { type: 'heal'; from: string; to: string; intent: string; scenario?: string }
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

/** Orientation calls (navigate + get_dom) before any scenario starts. */
const ORIENTATION_STEPS = 6;
/**
 * Base per-scenario allowance for a light page. A scenario costs ~7 tool calls
 * of real work (begin, navigate, 2-4 actions, 1-2 asserts, end), plus room for
 * one gate-forced retry. This stays the floor per scenario so a low-field page
 * keeps its historical budget and does not balloon.
 */
const STEPS_PER_SCENARIO_BASE = 14;
/**
 * Non-fill work in a form scenario: begin, navigate, submit click, a get_dom,
 * one or two asserts, end. The fill count is added on top, so a scenario on an
 * f-field form is budgeted PER_SCENARIO_OVERHEAD + f. The form term only raises
 * the budget once 8 + f exceeds the base 14, i.e. past ~6 fillable fields, so
 * light pages are untouched and long forms scale by one step per extra field.
 */
const PER_SCENARIO_OVERHEAD = 8;
/** Cap the fill term so a pathological mega-form cannot run the budget away. */
const FILL_FIELD_CAP = 24;
/** Floor so the budget never regresses below the historical default of 40. */
const STEP_BUDGET_FLOOR = 40;

/**
 * Per-run Explorer step budget. Scales with BOTH the plan size and the form
 * complexity of the page: a scenario that fills a 12-field form genuinely needs
 * ~12 steps just for the fills, which the old scenario-count-only budget could
 * not cover (three such scenarios is ~36 fills against a 48-step budget). Each
 * scenario is budgeted `max(base, overhead + fillableFields)`, so a 1-action
 * page keeps the base 14 per scenario while a long form gets one step per field.
 * The $QA_CORE_MAX_USD ceiling is still the ultimate runaway guard.
 */
export function stepBudgetFor(planCount: number, fillableFields = 0): number {
  const n = Math.max(1, planCount);
  const f = Math.min(Math.max(0, fillableFields), FILL_FIELD_CAP);
  const perScenario = Math.max(STEPS_PER_SCENARIO_BASE, PER_SCENARIO_OVERHEAD + f);
  return Math.max(STEP_BUDGET_FLOOR, ORIENTATION_STEPS + perScenario * n);
}

export async function explore(opts: ExploreOptions): Promise<RunReport | ReviewPaused> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.');

  // Step budget. Precedence: explicit opts.maxSteps > QA_CORE_MAX_STEPS env >
  // adaptive-to-plan. The adaptive value is computed below once the plan size
  // is known — a fixed 40 was too tight for a 3-scenario plan once one gate
  // retry (a full begin..end cycle, ~7 calls) is spent. See stepBudgetFor.
  const maxStepsOverride =
    opts.maxSteps ?? (process.env.QA_CORE_MAX_STEPS ? Number(process.env.QA_CORE_MAX_STEPS) : undefined);
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
  let planResult: { scenarios: PlannedScenario[]; usd: number; fillableFields: number } = {
    scenarios: opts.fromPlan ?? [],
    usd: 0,
    // A resumed/skip-plan run has no fresh snapshot, so the form-aware term is 0
    // and the budget falls back to the scenario-count base. That is correct: with
    // no page scan we have no field count to scale by.
    fillableFields: 0,
  };

  if (!opts.fromPlan && !opts.skipPlan) {
    opts.onEvent?.({ type: 'plan_started' });
    // A planner failure in the default path is fatal. We do NOT swallow it and
    // fall back to a blind Explorer run — improvising without a plan is exactly
    // the expensive wandering this pipeline exists to prevent (a blind register
    // run burned the whole budget). Let plan()'s error propagate and stop the
    // run with its reason intact.
    const p = await plan({ url: opts.url, apiKey, features: opts.features, requirements: opts.requirements });

    // A genuinely empty plan must also stop the run. Handing a blank plan to the
    // Explorer makes it design scenarios on the fly at full Opus cost. Fail loud
    // with the URL and the most likely reason instead of proceeding.
    if (p.scenarios.length === 0) {
      throw new Error(
        `Planner produced 0 scenarios for ${opts.url}. The page may not have rendered ` +
          `its content, or it has nothing testable. Stopping the run rather than letting ` +
          `the Explorer improvise without a plan.`,
      );
    }

    planResult = { scenarios: p.scenarios, usd: p.costUsd, fillableFields: p.fillableFields };
    opts.onEvent?.({ type: 'plan_done', scenarios: p.scenarios, usd: p.costUsd });
    for (const d of p.dropped) {
      opts.onEvent?.({
        type: 'message',
        text: `Dropped near-duplicate scenario: "${d.scenario.name}" (same value + relation as "${d.duplicateOf.name}")`,
      });
    }
    for (const r of p.rejected) {
      opts.onEvent?.({
        type: 'message',
        text: `Rejected circular scenario: "${r.scenario.name}" — ${r.reason}`,
      });
    }

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
  }

  // Step 2 — Explorer (Opus). The tool-use loop.
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let scenarios: Scenario[] = [];
  let cascadeStats: Record<CascadeLevel, number> = { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 };
  let steps = 0;
  let cost: RunReport['cost'] = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    usd: 0, plannerUsd: planResult.usd,
  };
  let brokenByGate: Array<{ scenario: string; reason: string; attempts: number }> = [];
  let gateInjectionLog: Array<{ scenario: string; stepIndex: number; assertionType: string; detail: string }> = [];
  // Scenarios begun but never finalized — recorded explicitly so reconciliation
  // can account for them (planned = generated + dropped + incomplete) instead of
  // letting them vanish.
  let incomplete: Array<{ scenario: string; reason: string }> = [];
  // Scenarios where the expected outcome never occurred (retry cap tripped).
  // Real findings, not budget casualties. Surfaced loudly below.
  let findings: Array<{ scenario: string; category?: string; expected: string; url: string; messages: string[] }> = [];
  // In-run selector recoveries applied during exploration (a failed locator
  // re-resolved a different, stable way). Carried into the report for human
  // visibility. The field keeps its `heals` name for the dashboard.
  let heals: Array<{ scenario?: string; intent: string; from: string; to: string }> = [];

  try {
    browser = await chromium.launch({ headless: true });
    const storageStatePath = path.join(process.cwd(), 'playwright', '.auth', 'user.json');
    context = await browser.newContext(
      fs.existsSync(storageStatePath) ? { storageState: storageStatePath } : undefined,
    );
    await installEvalShim(context);
    const page: Page = await context.newPage();

    // Resolve the effective budget now that the plan size is known. An override
    // (opts or env) always wins; otherwise scale to the plan AND the form
    // complexity so a long-form page does not run dry mid-fill.
    const maxSteps = maxStepsOverride ?? stepBudgetFor(planResult.scenarios.length, planResult.fillableFields);
    if (maxStepsOverride === undefined) {
      opts.onEvent?.({
        type: 'message',
        text: `Step budget: ${maxSteps} (${planResult.scenarios.length} scenario(s), ${planResult.fillableFields} fillable field(s) on the page)`,
      });
    }

    const ctx = createContext(page, maxSteps);
    const explorerLoop = await runAgentLoop({
      client, model, maxUsd, price, maxSteps,
      ctx, url: opts.url,
      plan: planResult.scenarios,
      onEvent: opts.onEvent,
    });
    const explorerCost = explorerLoop.cost;

    // The agent must call finish; if it didn't, decide what to do with the
    // scenario left in progress. Two distinct cases:
    //
    //   (a) Budget exhausted — the step/turn budget ran out mid-scenario. The
    //       scenario is unfinished and was never validated. Record it as
    //       INCOMPLETE with an explicit reason so reconciliation counts it.
    //       Do NOT salvage it: its assertions may be partial and Replay /
    //       Stability never saw it.
    //
    //   (b) Model stopped on its own — it may have done the real work and just
    //       forgotten to call end_scenario / finish. Salvage it if it is
    //       well-formed (has an assertion and passes the gate), otherwise mark
    //       it incomplete rather than dropping it silently. Without this, an
    //       abandoned empty scenario would pass Replay / Stability / Playwright
    //       vacuously and inflate failure rates.
    if (ctx.current) {
      const budgetHit = explorerLoop.endedReason === 'budget' || ctx.steps >= maxSteps;
      if (budgetHit) {
        ctx.incomplete.push({ scenario: ctx.current.name, reason: 'step budget exhausted' });
        opts.onEvent?.({
          type: 'message',
          text: `Scenario "${ctx.current.name}" left INCOMPLETE: step budget exhausted (${ctx.steps}/${maxSteps} steps).`,
        });
      } else {
        const hasAssert = ctx.current.steps.some((s) => s.kind === 'assert');
        if (hasAssert) {
          // Gate also runs here so abandoned scenarios don't skip validation
          const { runGate } = await import('./gate.js');
          const gr = runGate(ctx.current);
          if (gr.violations.length === 0) {
            for (const inj of gr.injections) {
              ctx._gateInjectionLog.push({
                scenario: ctx.current.name,
                stepIndex: inj.stepIndex,
                assertionType: inj.assertionType,
                detail: inj.detail,
              });
            }
            ctx.scenarios.push(ctx.current);
          } else {
            const firstV = gr.violations[0]!;
            const reason = firstV.rule === 1 ? 'could not generate without hard sleep' : firstV.rule === 3 ? 'unstable locator on dynamic element' : 'intermediate value assertion on animated element';
            ctx.brokenByGate.push({ scenario: ctx.current.name, reason, attempts: 1 });
          }
        } else {
          ctx.incomplete.push({ scenario: ctx.current.name, reason: 'explorer stopped before finalizing (no assertion recorded)' });
        }
      }
    }
    scenarios = ctx.scenarios;
    cascadeStats = ctx.cascadeStats;
    steps = ctx.steps;
    cost = { ...explorerCost, plannerUsd: planResult.usd };
    brokenByGate = ctx.brokenByGate;
    gateInjectionLog = ctx._gateInjectionLog;
    incomplete = ctx.incomplete;
    findings = ctx.findings;
    heals = ctx.heals;
  } finally {
    await context?.close();
    await browser?.close();
  }

  // Emit gate events so the CLI and gateway can surface them
  for (const inj of gateInjectionLog) {
    opts.onEvent?.({ type: 'gate_injection', scenario: inj.scenario, step: inj.stepIndex, assertionType: inj.assertionType, detail: inj.detail });
  }
  for (const broken of brokenByGate) {
    opts.onEvent?.({ type: 'gate_broken', scenario: broken.scenario, reason: broken.reason, attempts: broken.attempts });
  }
  // Surface findings loudly: the expected success signal never appeared, so the
  // scenario is a real finding, not a green test and not a silent drop.
  for (const f of findings) {
    const where = f.messages.length ? ` Page said: ${f.messages.join(' | ')}.` : ' No visible message on the page.';
    opts.onEvent?.({
      type: 'message',
      text: `Finding: "${f.scenario}" — expected ${f.expected}, but the page stayed at ${f.url}.${where} Recorded as a finding, not retried.`,
    });
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
      if (c.verdicts.length === 0) {
        // The call succeeded and was paid for, but nothing parsed. That means
        // the response format drifted and the critic gate cannot act this run.
        // Say so loudly instead of printing "0 verdicts" as if it were normal.
        opts.onEvent?.({
          type: 'message',
          text: `Warning: Critic reviewed ${scenarios.length} scenario(s) but returned no parseable verdicts. The critic gate is inactive for this run. Check parseVerdicts in critic.ts against the response format.`,
        });
      }
    } catch (err) {
      opts.onEvent?.({ type: 'message', text: `Critic skipped: ${(err as Error).message}` });
    }
  }

  // Gate on critic: 'rework' and 'reject' scenarios are dropped before replay.
  // Only 'pass' scenarios proceed to Reality-Check (Step 4).
  let scenariosForReplay = scenarios;
  if (review && !opts.skipCritic) {
    const gated = gateByVerdicts(scenarios, review.verdicts);
    if (gated.dropped.length > 0) {
      scenariosForReplay = gated.kept;
      opts.onEvent?.({
        type: 'message',
        text: `Critic gated out ${gated.dropped.length} scenario(s) (rework/reject), not sent to Reality-Check: ${gated.dropped.map((n) => `"${n}"`).join(', ')}`,
      });
    }
  }

  // Step 4 — Reality check (replay). Re-execute every passing scenario in a fresh
  // Playwright context and drop the ones that fail. Survivors are what the
  // Transcriber emits. Zero LLM cost; this is just Playwright.
  let replayInfo: RunReport['replay'];
  let emittedScenarios = scenariosForReplay;
  if (!opts.skipReplay && scenariosForReplay.length > 0) {
    try {
      const storageStatePath = path.join(process.cwd(), 'playwright', '.auth', 'user.json');
      const r = await replay({
        scenarios: scenariosForReplay,
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
        stabilize: opts.stabilize,
        stabilizerModel: opts.stabilizerModel,
        maxStabilizeAttempts: opts.maxStabilizeAttempts,
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
                recovered: ev.recovered,
                iterations: ev.iterations,
                flakeRate: ev.flakeRate,
                durationMs: ev.durationMs,
                stabilizerCostUsd: ev.stabilizerCostUsd,
              });
              return;
            // Stabilizer events — forward as 'message' (no dedicated event
            // type in the runtime ExploreEvent enum; gateway + UI parse
            // these strings like other stability messages). Each event
            // includes attempt number so the user sees multi-attempt progress.
            case 'stabilize_started':
              opts.onEvent?.({ type: 'message', text: `  ↻ trying to recover flaky scenario: ${ev.name}` });
              return;
            case 'stabilize_proposed':
              opts.onEvent?.({
                type: 'message',
                text: `    attempt ${ev.attempt} — Stabilizer proposed: ${ev.proposalKind} — ${ev.reason} ($${ev.costUsd.toFixed(4)})`,
              });
              return;
            case 'stabilize_attempt_failed':
              opts.onEvent?.({
                type: 'message',
                text: `    attempt ${ev.attempt} didn't take (pattern ${ev.pattern}) — trying again with a different strategy`,
              });
              return;
            case 'stabilize_recovered':
              opts.onEvent?.({
                type: 'message',
                text: `  ✓ recovered ${ev.name} — stable after ${ev.attempts} attempt${ev.attempts === 1 ? '' : 's'} (${ev.winningStrategy})`,
              });
              return;
            case 'stabilize_unfixed':
              opts.onEvent?.({
                type: 'message',
                text: `  ✗ Stabilizer gave up on ${ev.name} after ${ev.attempts} attempt${ev.attempts === 1 ? '' : 's'} (tried: ${ev.triedStrategies.join(' → ') || 'nothing usable'})`,
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
        recovered: s.recovered.length,
        stabilizerCostUsd: s.stabilizerCostUsd,
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

  const gateData: RunReport['gate'] = (brokenByGate.length > 0 || gateInjectionLog.length > 0)
    ? { broken: brokenByGate, injections: gateInjectionLog }
    : undefined;

  // SRS runs: carry each planned scenario's rule citations onto the emitted
  // scenario that fulfilled it (matched by name), so ruleIds land in the
  // RunReport and the emitted scenarios themselves.
  if (opts.requirements) {
    attachRuleIds(emittedScenarios, planResult.scenarios);
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
    gate: gateData,
    replay: replayInfo,
    stability: stabilityInfo,
    incomplete: incomplete.length > 0 ? incomplete : undefined,
    findings: findings.length > 0 ? findings : undefined,
    heals: heals.length > 0 ? heals : undefined,
  };

  // Reporting reconciliation — planned === generated + dropped, with every
  // dropped scenario named. Attached so the CLI, gateway, and run-report.json
  // all share one auditable funnel.
  report.reconciliation = reconcile(report);

  // Rule coverage: classify every stated rule as covered, planned-but-dropped,
  // or not-planned. Attached to the report and written to its own file so the
  // "considered, not automated" list survives alongside run-report.json.
  if (opts.requirements) {
    report.ruleCoverage = computeRuleCoverage({
      map: opts.requirements,
      planned: planResult.scenarios,
      scenarios: emittedScenarios,
    });
    for (const line of renderRuleCoverage(report.ruleCoverage)) {
      opts.onEvent?.({ type: 'message', text: line });
    }
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(
    path.join(opts.outDir, 'run-report.json'),
    JSON.stringify(report, null, 2),
  );
  if (report.ruleCoverage) {
    fs.writeFileSync(
      path.join(opts.outDir, 'rule-coverage.json'),
      JSON.stringify(report.ruleCoverage, null, 2),
    );
  }

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
      if (step.kind === 'click' || step.kind === 'fill' || step.kind === 'press'
        || step.kind === 'select_option' || step.kind === 'set_checked' || step.kind === 'set_input_files') {
        out.push({ intent: step.target.intent, level: step.target.level });
      } else if (step.kind === 'assert') {
        const a = step.assertion;
        if (a.type !== 'toHaveURL') out.push({ intent: a.target.intent, level: a.target.level });
      } else if (step.kind === 'capture' || step.kind === 'assert_compare') {
        out.push({ intent: step.target.intent, level: step.target.level });
      } else if (step.kind === 'wait_for_state') {
        out.push({ intent: step.target.intent, level: step.target.level });
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
  maxSteps: number;
  ctx: ToolContext;
  url: string;
  plan: PlannedScenario[];
  onEvent?: ExploreOptions['onEvent'];
}): Promise<{ cost: RunReport['cost']; endedReason: 'finished' | 'model_stop' | 'budget' }> {
  const { client, model, maxUsd, price, maxSteps, ctx, url, onEvent } = args;

  const cost = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 };

  // Build a system prompt with three cached blocks:
  //   1. Frozen behavior rules (SYSTEM_PROMPT) — never changes, max cache value
  //   2. Site memory — changes per host, still cacheable per host
  //   3. Plan — changes per run, but stable through the loop
  const memoryBlock = renderMemoryBlock(url);
  // Render the plan including each scenario's feature tag (when present) so the
  // Explorer can pass it back via begin_scenario.feature. Feature names from
  // the plan are authoritative — the agent should use them verbatim.
  const planText = args.plan.length > 0
    ? 'Planned scenarios (cover all of these unless a scenario is impossible from this page). ' +
      'When you call begin_scenario, set `feature` to the value in the first bracket — verbatim, kebab-case.\n' +
      args.plan
        .map((p, i) => {
          const tag = p.feature ? `[${p.feature}][${p.category}]` : `[${p.category}]`;
          return `  ${i + 1}. ${tag} ${p.name} — ${p.rationale}`;
        })
        .join('\n')
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

  // The conversation-turn cap must sit ABOVE the step budget, never below it.
  // The model emits roughly one tool call per turn, so a turn cap under the
  // step budget would (and previously did) bite first and abandon the run
  // silently before the step budget could nudge the model to finish(). The
  // margin covers the final finish() turn plus any thinking-only turns.
  const maxTurns = maxSteps + 8;
  let endedReason: 'finished' | 'model_stop' | 'budget' = 'budget';
  // How many 'heal' events have already been surfaced. In-run selector
  // recoveries are recorded on ctx by resolveAndRecord (deep inside a tool
  // call); we drain new ones after each tool runs so each shows up as its own
  // visible event in the run output.
  let emittedHeals = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
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
      // Agent stopped on its own without calling finish — accept what's there.
      endedReason = 'model_stop';
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
      // Surface any selector recoveries that just happened, one distinct event each.
      while (emittedHeals < ctx.heals.length) {
        const h = ctx.heals[emittedHeals++]!;
        onEvent?.({ type: 'heal', from: h.from, to: h.to, intent: h.intent, scenario: h.scenario });
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        is_error: !result.ok,
        content: JSON.stringify(result.ok ? (result.data ?? { ok: true }) : { error: result.error }),
      });
      if (block.name === 'finish' && result.ok) finished = true;
    }

    messages.push({ role: 'user', content: toolResults });
    if (finished) { endedReason = 'finished'; break; }
  }
  // If the for-loop ran to completion without a break, endedReason stays
  // 'budget' — the turn cap (which tracks the step budget) was reached.

  return { cost, endedReason };
}
