/**
 * Locks the cost-ceiling salvage path (src/agent/runtime.ts):
 *   - the Explorer loop STOPS CLEANLY at the ceiling (endedReason
 *     'cost_ceiling'), it does not throw, and completed scenarios survive
 *   - salvageOnCostCeiling keeps every completed scenario, discards only the
 *     in-progress one, and records each planned-but-never-started scenario
 *     as incomplete so the reconciliation funnel stays balanced
 *   - the summary line states: ceiling hit, N completed, M never explored
 *   - rule coverage classifies a rule cited only by never-explored scenarios
 *     as planned-not-explored, not planned-but-dropped
 *
 * The loop is driven with a FAKE Anthropic client (a cost tracker that burns
 * the ceiling after the first turn) and a stub page. No network. No LLM.
 * No browser.
 */
import { runAgentLoop, salvageOnCostCeiling } from '../src/agent/runtime.js';
import { createContext } from '../src/agent/tools.js';
import { computeRuleCoverage } from '../src/agent/rule-coverage.js';
import type { Scenario } from '../src/agent/trace.js';
import type { RequirementsMap } from '../src/agent/requirements.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Page } from 'playwright';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── A. the loop breaks at the ceiling instead of throwing ────────────────── */
// Fake client: every response costs ~$1.60 (real Opus prices), carries one
// harmless unknown-tool call so the loop keeps going until the ceiling check
// at the top of the next turn trips. Ceiling $1 -> trips before turn 2.
let apiCalls = 0;
const fakeClient = {
  messages: {
    create: async () => {
      apiCalls++;
      return {
        usage: { input_tokens: 20_000, output_tokens: 60_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: `t${apiCalls}`, name: 'bogus_tool_never_touches_the_page', input: {} }],
        stop_reason: 'tool_use',
      };
    },
  },
} as unknown as Anthropic;

// Stub page: createContext only attaches listeners; the unknown tool never
// touches the page.
const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
const ctx = createContext(stubPage, 40);
// Two scenarios already completed when the ceiling trips (2 of 4 planned).
const done = (name: string): Scenario => ({ name, category: 'happy', steps: [] } as unknown as Scenario);
ctx.scenarios.push(done('logged in with valid credentials'), done('rejected a wrong password'));

const messages: string[] = [];
let threw = false;
let loopResult: Awaited<ReturnType<typeof runAgentLoop>> | undefined;
try {
  loopResult = await runAgentLoop({
    client: fakeClient,
    model: 'claude-opus-4-7',
    maxUsd: 1,
    price: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    maxSteps: 40,
    ctx,
    url: 'https://shop.example/',
    plan: [],
    onEvent: (e) => { if (e.type === 'message') messages.push(e.text); },
  });
} catch {
  threw = true;
}
check('A1. the loop does NOT throw at the ceiling', !threw);
check('A2. endedReason is cost_ceiling', loopResult?.endedReason === 'cost_ceiling', loopResult?.endedReason);
check('A3. the ceiling stopped further API calls (fake cost tracker trips after turn 1)', apiCalls === 1, String(apiCalls));
check('A4. the 2 completed scenarios survive on the context', ctx.scenarios.length === 2);
check('A5. the stop is announced', messages.some((m) => m.includes('Cost ceiling reached')), JSON.stringify(messages));

/* ─── B. salvage bookkeeping: 2 of 4 completed, 2 never explored ───────────── */
const planned = [
  { name: 'logged in with valid credentials', category: 'happy' as const, rationale: 'r', feature: 'login', ruleIds: ['R1'] },
  { name: 'rejected a wrong password', category: 'negative' as const, rationale: 'r', feature: 'login', ruleIds: ['R2'] },
  { name: 'rejected an empty username', category: 'negative' as const, rationale: 'r', feature: 'login', ruleIds: ['R3'] },
  { name: 'locked out after repeated failures', category: 'edge' as const, rationale: 'r', feature: 'login', ruleIds: ['R4'] },
];
const salvage = salvageOnCostCeiling({
  planned,
  begun: ctx.scenarios.map((s) => s.name),
  completed: ctx.scenarios.length,
  costUsd: 1.6,
  ceilingUsd: 1,
});
check('B1. the 2 never-started scenarios are identified', JSON.stringify(salvage.unexplored) === JSON.stringify(['rejected an empty username', 'locked out after repeated failures']), JSON.stringify(salvage.unexplored));
check('B2. each unexplored scenario becomes an incomplete entry (funnel stays balanced)',
  salvage.incomplete.length === 2 && salvage.incomplete.every((i) => i.reason.includes('never explored: cost ceiling')), JSON.stringify(salvage.incomplete));
check('B3. the summary states ceiling, completed count, and unexplored count',
  salvage.summary.includes('Cost ceiling hit') && salvage.summary.includes('2 scenario(s) completed') && salvage.summary.includes('2 planned scenario(s) never explored'), salvage.summary);
check('B4. nothing was discarded when no scenario was in progress', salvage.discardedInProgress === undefined);

/* ─── C. an in-progress scenario is discarded, never salvaged ──────────────── */
const withCurrent = salvageOnCostCeiling({
  planned,
  begun: [...ctx.scenarios.map((s) => s.name), 'rejected an empty username'],
  completed: 2,
  current: 'rejected an empty username',
  costUsd: 1.6,
  ceilingUsd: 1,
});
check('C1. the in-progress scenario is named as discarded', withCurrent.discardedInProgress === 'rejected an empty username');
check('C2. it is recorded incomplete as mid-scenario, not as never-explored',
  withCurrent.incomplete.some((i) => i.scenario === 'rejected an empty username' && i.reason.includes('mid-scenario')), JSON.stringify(withCurrent.incomplete));
check('C3. only the truly never-started scenario counts as unexplored', JSON.stringify(withCurrent.unexplored) === JSON.stringify(['locked out after repeated failures']));

/* ─── D. a small rename still counts as begun ──────────────────────────────── */
const renamed = salvageOnCostCeiling({
  planned,
  begun: ['Logged in with the valid credentials!', 'rejected wrong password'],
  completed: 2,
  costUsd: 1.6,
  ceilingUsd: 1,
});
check('D1. renamed begun scenarios are not misreported as unexplored', JSON.stringify(renamed.unexplored) === JSON.stringify(['rejected an empty username', 'locked out after repeated failures']), JSON.stringify(renamed.unexplored));

/* ─── E. rule coverage classifies unexplored rules honestly ────────────────── */
const map: RequirementsMap = {
  features: [{
    name: 'login',
    description: 'sign in',
    rules: [
      { id: 'R1', text: 'valid login works', type: 'behavior' },
      { id: 'R2', text: 'wrong password rejected', type: 'validation' },
      { id: 'R3', text: 'username required', type: 'validation' },
      { id: 'R4', text: 'lockout after repeated failures', type: 'behavior' },
    ],
  }],
  roles: [],
  truncated: false,
};
// R1 survived; R2's scenario was explored but dropped at replay; R3/R4 never explored.
const coverage = computeRuleCoverage({
  map,
  planned,
  scenarios: [{ name: 'logged in with valid credentials', ruleIds: ['R1'] }],
  unexplored: salvage.unexplored,
});
check('E1. the surviving rule is covered', coverage.covered.length === 1 && coverage.covered[0]?.ruleId === 'R1');
check('E2. an explored-but-dropped rule stays planned-but-dropped',
  coverage.uncovered.find((u) => u.ruleId === 'R2')?.reason === 'planned-but-dropped', JSON.stringify(coverage.uncovered));
check('E3. rules cited only by never-started scenarios classify planned-not-explored',
  coverage.uncovered.find((u) => u.ruleId === 'R3')?.reason === 'planned-not-explored' &&
  coverage.uncovered.find((u) => u.ruleId === 'R4')?.reason === 'planned-not-explored', JSON.stringify(coverage.uncovered));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the cost ceiling stops the Explorer cleanly, keeps completed scenarios, accounts for never-explored ones, and rule coverage reports them honestly.');
