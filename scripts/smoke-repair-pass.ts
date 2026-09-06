/**
 * Locks the rework repair pass gate logic (src/agent/critic.ts):
 *   - splitGate: reject drops, rework goes to repair, pass (or no verdict)
 *     continues
 *   - mergeRepairVerdicts: rework -> pass keeps the repaired scenario;
 *     rework -> rework/reject drops for real (the ONE-pass cap: a second
 *     rework gets no third chance, structurally); a rework never re-recorded
 *     drops; non-rework verdicts pass through untouched
 *   - verdict history records every rework journey
 *   - reconciliation sees the FINAL verdicts, so a repaired-to-pass scenario
 *     is not counted as a critic drop
 *
 * Fixture verdicts only. No live calls. No browser.
 */
import { splitGate, mergeRepairVerdicts, type ScenarioVerdict } from '../src/agent/critic.js';
import { reconcile } from '../src/agent/reconcile.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const v = (scenario: string, verdict: ScenarioVerdict['verdict'], reasons: string[] = []): ScenarioVerdict =>
  ({ scenario, verdict, reasons, required_fixes: [] });

const scenarios = [
  { name: 's-pass' },
  { name: 's-reject' },
  { name: 's-rework-a' },
  { name: 's-rework-b' },
  { name: 's-unjudged' },
];
const verdicts = [
  v('s-pass', 'pass'),
  v('s-reject', 'reject', ['tests nothing meaningful']),
  v('s-rework-a', 'rework', ['assertion is vacuous']),
  v('s-rework-b', 'rework', ['missing outcome assertion']),
];

/* ─── A. the three-way gate split ──────────────────────────────────────────── */
const split = splitGate(scenarios, verdicts);
check('A1. pass continues', split.kept.some((s) => s.name === 's-pass'));
check('A2. a scenario with no verdict continues (the critic did not flag it)', split.kept.some((s) => s.name === 's-unjudged'));
check('A3. reject drops for good', split.rejected.length === 1 && split.rejected[0]?.name === 's-reject');
check('A4. rework goes to the repair pass, not the floor', JSON.stringify(split.rework.map((s) => s.name)) === '["s-rework-a","s-rework-b"]');

/* ─── B. merge after the repair pass ───────────────────────────────────────── */
// Repair re-recorded both reworks; the critic passed one and reworked the other.
const second = [v('s-rework-a', 'pass'), v('s-rework-b', 'rework', ['still too weak'])];
const merged = mergeRepairVerdicts(verdicts, second);
check('B1. rework -> pass replaces the verdict (kept)',
  merged.final.find((x) => x.scenario === 's-rework-a')?.verdict === 'pass');
check('B2. rework -> rework stays a drop: the ONE-pass cap, no third chance',
  merged.final.find((x) => x.scenario === 's-rework-b')?.verdict === 'rework');
check('B3. non-rework verdicts pass through untouched',
  merged.final.find((x) => x.scenario === 's-reject')?.verdict === 'reject' &&
  merged.final.find((x) => x.scenario === 's-pass')?.verdict === 'pass');
check('B4. history records both journeys',
  JSON.stringify(merged.history) === JSON.stringify([
    { scenario: 's-rework-a', first: 'rework', second: 'pass', outcome: 'kept' },
    { scenario: 's-rework-b', first: 'rework', second: 'rework', outcome: 'dropped' },
  ]), JSON.stringify(merged.history));

/* ─── C. rework -> reject also drops; not-re-recorded drops ────────────────── */
const merged2 = mergeRepairVerdicts(verdicts, [v('s-rework-a', 'reject', ['redundant after all'])]);
check('C1. rework -> reject drops', merged2.history.find((h) => h.scenario === 's-rework-a')?.outcome === 'dropped');
check('C2. a rework the repair never re-recorded drops with no second verdict',
  merged2.history.find((h) => h.scenario === 's-rework-b')?.outcome === 'dropped' &&
  merged2.history.find((h) => h.scenario === 's-rework-b')?.second === undefined);

/* ─── D. no repair pass at all (null): every rework drops, history says so ─── */
const merged3 = mergeRepairVerdicts(verdicts, null);
check('D1. with no repair pass both reworks drop', merged3.history.length === 2 && merged3.history.every((h) => h.outcome === 'dropped'));
check('D2. final verdicts keep rework so reconciliation counts the drop',
  merged3.final.filter((x) => x.verdict === 'rework').length === 2);

/* ─── E. reconciliation sees final verdicts: repaired-to-pass is NOT a drop ── */
const report = {
  scenarios: [{ name: 's-pass' }, { name: 's-unjudged' }, { name: 's-rework-a' }],
  plan: scenarios.map((s) => ({ name: s.name, category: 'happy', rationale: 'r' })),
  review: { verdicts: merged.final, summary: '' },
} as unknown as RunReport;
const rec = reconcile(report);
check('E1. the repaired-to-pass scenario is generated, not a critic drop',
  !rec.dropped.some((d) => d.name === 's-rework-a'), JSON.stringify(rec.dropped));
check('E2. the second-time rework and the reject each count exactly one critic drop',
  rec.dropped.filter((d) => d.stage === 'critic').length === 2);
check('E3. the funnel balances: planned 5 = generated 3 + dropped 2', rec.balanced === true && rec.accountedFor === 5);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: reject drops, rework earns exactly one repair pass, second-time rework/reject drops for real, and the funnel counts final verdicts.');
