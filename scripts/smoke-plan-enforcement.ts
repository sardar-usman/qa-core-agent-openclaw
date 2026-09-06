/**
 * Locks finish() plan enforcement and skip_scenario (src/agent/tools.ts):
 *   - finish is REJECTED while planned scenarios remain unexplored and the
 *     step budget is not exhausted; the rejection lists the unexplored names
 *     and teaches the way out (continue or skip_scenario)
 *   - skip_scenario records a planned scenario as skipped-with-reason; junk
 *     names and empty reasons are rejected
 *   - finish is ACCEPTED once every planned scenario is explored or skipped,
 *     and when the step budget is exhausted
 *   - the reconciliation identity includes skipped:
 *     planned = generated + dropped + incomplete + findings + skipped
 *
 * Stub page, no browser, no LLM (same pattern as smoke-cost-ceiling).
 */
import { createContext, runTool } from '../src/agent/tools.js';
import { reconcile, renderReconciliation } from '../src/agent/reconcile.js';
import type { RunReport, Scenario } from '../src/agent/trace.js';
import type { Page } from 'playwright';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
const done = (name: string): Scenario => ({ name, category: 'happy', steps: [] } as unknown as Scenario);

const PLANNED = [
  'logged in with valid credentials',
  'rejected a wrong password',
  'rejected an empty username',
  'locked out after repeated failures',
];

/* ─── A. finish with 2 of 4 unexplored is rejected ─────────────────────────── */
const ctx = createContext(stubPage, 40);
ctx.plannedNames = [...PLANNED];
ctx.scenarios.push(done(PLANNED[0]!), done(PLANNED[1]!));

const rejected = await runTool(ctx, { name: 'finish', input: { summary: 'done early' } });
check('A1. finish is rejected while planned scenarios remain', rejected.ok === false);
check('A2. the rejection names BOTH unexplored scenarios',
  rejected.error?.includes(PLANNED[2]!) === true && rejected.error?.includes(PLANNED[3]!) === true, rejected.error);
check('A3. the rejection teaches the way out (continue or skip_scenario)',
  /begin_scenario/.test(rejected.error ?? '') && /skip_scenario/.test(rejected.error ?? ''));

/* ─── B. skip_scenario validation ──────────────────────────────────────────── */
const badName = await runTool(ctx, { name: 'skip_scenario', input: { name: 'no such scenario at all zz', reason: 'x' } });
check('B1. a name matching no planned scenario is rejected, listing the plan',
  badName.ok === false && badName.error?.includes(PLANNED[2]!) === true, badName.error);
const noReason = await runTool(ctx, { name: 'skip_scenario', input: { name: PLANNED[2], reason: '  ' } });
check('B2. an empty reason is rejected', noReason.ok === false);

/* ─── C. 2 explored + 2 skipped with reasons -> finish accepted ────────────── */
const skip1 = await runTool(ctx, { name: 'skip_scenario', input: { name: PLANNED[2], reason: 'username field is not present on this build' } });
const skip2 = await runTool(ctx, { name: 'skip_scenario', input: { name: PLANNED[3], reason: 'lockout needs 3 real accounts we do not have' } });
check('C1. both skips are accepted', skip1.ok === true && skip2.ok === true, JSON.stringify([skip1, skip2]));
check('C2. skips are recorded with their reasons',
  ctx.skipped.length === 2 && ctx.skipped[0]?.reason.includes('not present') === true);
const dup = await runTool(ctx, { name: 'skip_scenario', input: { name: PLANNED[2], reason: 'again' } });
check('C3. skipping the same scenario twice is rejected', dup.ok === false);
const accepted = await runTool(ctx, { name: 'finish', input: { summary: 'all covered or skipped' } });
check('C4. finish is accepted after 2 explored + 2 skipped', accepted.ok === true, accepted.error);

/* ─── D. budget exhaustion also unlocks finish ─────────────────────────────── */
const ctx2 = createContext(stubPage, 5);
ctx2.plannedNames = [...PLANNED];
ctx2.scenarios.push(done(PLANNED[0]!));
ctx2.steps = 5; // at the budget line; runTool increments past it
const atBudget = await runTool(ctx2, { name: 'finish', input: { summary: 'budget gone' } });
check('D1. finish is accepted when the step budget is exhausted, unexplored or not', atBudget.ok === true, atBudget.error);

/* ─── E. a renamed explored scenario still counts as explored ──────────────── */
const ctx3 = createContext(stubPage, 40);
ctx3.plannedNames = ['rejected a wrong password'];
ctx3.scenarios.push(done('Rejected wrong password!'));
const renamed = await runTool(ctx3, { name: 'finish', input: { summary: 'done' } });
check('E1. small rephrasings do not trigger a false rejection', renamed.ok === true, renamed.error);

/* ─── F. reconciliation identity includes skipped ──────────────────────────── */
const report = {
  scenarios: [done(PLANNED[0]!), done(PLANNED[1]!)],
  plan: PLANNED.map((name) => ({ name, category: 'happy', rationale: 'r' })),
  skipped: [
    { scenario: PLANNED[2]!, reason: 'username field is not present on this build' },
    { scenario: PLANNED[3]!, reason: 'lockout needs 3 real accounts we do not have' },
  ],
} as unknown as RunReport;
const rec = reconcile(report);
check('F1. planned 4 = generated 2 + skipped 2 balances', rec.balanced === true && rec.accountedFor === 4, JSON.stringify(rec));
check('F2. the skipped term carries names and reasons', rec.skipped.length === 2 && rec.skipped[1]?.reason.includes('3 real accounts') === true);
const lines = renderReconciliation(rec).join('\n');
check('F3. the rendered identity shows the skipped term', lines.includes('+ skipped 2'), lines);
check('F4. skipped scenarios are listed with reasons', lines.includes('skipped (declined by the Explorer, with reason):'));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: finish cannot abandon the plan silently, skip_scenario records reasons, and the reconciliation identity includes skipped.');
