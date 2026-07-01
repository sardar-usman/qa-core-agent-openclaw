/**
 * Locks the reporting reconciliation (reconcile.ts) — pure function, zero
 * browser, zero LLM.
 *
 * The contract the user asked for:
 *   - planned === generated + dropped
 *   - every dropped or broken scenario is named with a stage and a reason
 *   - "stable" excludes any scenario kept passing by a relaxed rule (recovered)
 *   - the broken count includes scenarios the Stabilizer gave up on
 */
import { reconcile, renderReconciliation } from '../src/agent/reconcile.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const baseCost: RunReport['cost'] = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0,
};

/** Minimal emitted scenario — only the name matters for reconciliation. */
function scn(name: string): RunReport['scenarios'][number] {
  return { name, category: 'happy', steps: [] };
}

/* ─── 1. Clean run: everything planned shipped ───────────────────────────── */

const clean: RunReport = {
  url: 'https://example.com/', language: 'ts',
  scenarios: [scn('A'), scn('B'), scn('C')],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: baseCost, steps: 0, startedAt: '', finishedAt: '',
  plan: [
    { name: 'A', category: 'happy', rationale: '' },
    { name: 'B', category: 'happy', rationale: '' },
    { name: 'C', category: 'happy', rationale: '' },
  ],
  stability: {
    iterations: 4, passed: 3, flaked: 0, flakeRate: 0, durationMs: 0,
    verdicts: [
      { name: 'A', iterations: 4, passes: 4, stable: true, classification: 'stable', pattern: 'P-P-P-P', durationMs: 0 },
      { name: 'B', iterations: 4, passes: 4, stable: true, classification: 'stable', pattern: 'P-P-P-P', durationMs: 0 },
      { name: 'C', iterations: 4, passes: 4, stable: true, classification: 'stable', pattern: 'P-P-P-P', durationMs: 0 },
    ],
  },
};
const rc = reconcile(clean);
check('A. clean run balances: planned === generated + dropped', rc.balanced && rc.planned === 3 && rc.generated === 3 && rc.dropped.length === 0);
check('B. clean run: 3 stable, 0 recovered/flaky/broken', rc.stable === 3 && rc.recovered === 0 && rc.flaky === 0 && rc.broken === 0);

/* ─── 2. Full funnel: a drop at every stage, plus recovered + give-up ─────── */
// plan of 6:
//   gate drops 1 (G), critic drops 1 (C), replay drops 1 (R),
//   stability: S1 stable, S2 recovered (relaxed), S3 broken via Stabilizer give-up.
// emitted (generated) = S1 + S2 = 2. dropped = 4. planned 6 = 2 + 4.
const funnel: RunReport = {
  url: 'https://example.com/', language: 'ts',
  scenarios: [scn('S1'), scn('S2')],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: baseCost, steps: 0, startedAt: '', finishedAt: '',
  plan: ['G', 'C', 'R', 'S1', 'S2', 'S3'].map((n) => ({ name: n, category: 'happy', rationale: '' })),
  gate: {
    broken: [{ scenario: 'G', reason: 'RULE 1: hard sleep', attempts: 2 }],
    injections: [],
  },
  review: {
    summary: '',
    verdicts: [
      { scenario: 'C', verdict: 'reject', reasons: ['no real assertion'], required_fixes: [] },
      { scenario: 'R', verdict: 'pass', reasons: [], required_fixes: [] },
      { scenario: 'S1', verdict: 'pass', reasons: [], required_fixes: [] },
      { scenario: 'S2', verdict: 'pass', reasons: [], required_fixes: [] },
      { scenario: 'S3', verdict: 'pass', reasons: [], required_fixes: [] },
    ],
  },
  replay: {
    passed: 3, failed: 1, durationMs: 0,
    verdicts: [
      { name: 'R', passed: false, failedStep: 2, stepKind: 'assert', error: 'timeout', durationMs: 0 },
      { name: 'S1', passed: true, durationMs: 0 },
      { name: 'S2', passed: true, durationMs: 0 },
      { name: 'S3', passed: true, durationMs: 0 },
    ],
  },
  stability: {
    iterations: 4, passed: 2, flaked: 1, flaky: 0, broken: 1, recovered: 1, flakeRate: 1 / 3, durationMs: 0,
    verdicts: [
      { name: 'S1', iterations: 4, passes: 4, stable: true, classification: 'stable', pattern: 'P-P-P-P', durationMs: 0 },
      { name: 'S2', iterations: 4, passes: 4, stable: true, classification: 'stable', pattern: 'P-P-P-P', relaxed: true, durationMs: 0 },
      { name: 'S3', iterations: 4, passes: 2, stable: false, classification: 'broken', pattern: 'P-F-P-F', gaveUp: true, durationMs: 0 },
    ],
  },
};
const rf = reconcile(funnel);

check('C. funnel balances: planned 6 === generated 2 + dropped 4', rf.balanced && rf.planned === 6 && rf.generated === 2 && rf.dropped.length === 4 && rf.accountedFor === 6);

// stable excludes recovered
check('D. stable excludes the recovered scenario (1, not 2)', rf.stable === 1);
check('E. recovered reported separately as 1', rf.recovered === 1);

// give-up counts as broken, not flaky
check('F. broken count includes the Stabilizer give-up (broken=1)', rf.broken === 1);
check('G. flaky count is 0 — the give-up is NOT counted flaky', rf.flaky === 0);

// every drop named with stage + reason
const stages = rf.dropped.map((d) => d.stage).sort();
check('H. one drop at each of gate/critic/replay/stability', JSON.stringify(stages) === JSON.stringify(['critic', 'gate', 'replay', 'stability']));
check('I. every dropped scenario has a non-empty name and reason', rf.dropped.every((d) => d.name.length > 0 && d.reason.length > 0));

const s3Drop = rf.dropped.find((d) => d.name === 'S3');
check('J. the give-up drop is named broken and mentions the Stabilizer gave up', !!s3Drop && s3Drop.stage === 'stability' && /broken/.test(s3Drop.reason) && /gave up/i.test(s3Drop.reason));
const gDrop = rf.dropped.find((d) => d.name === 'G');
check('K. the gate drop names the gate reason', !!gDrop && gDrop.stage === 'gate' && /RULE 1/.test(gDrop.reason));
const cDrop = rf.dropped.find((d) => d.name === 'C');
check('L. the critic drop names the verdict and reason', !!cDrop && cDrop.stage === 'critic' && /reject/.test(cDrop.reason) && /no real assertion/.test(cDrop.reason));
const rDrop = rf.dropped.find((d) => d.name === 'R');
check('M. the replay drop names the failing step', !!rDrop && rDrop.stage === 'replay' && /step 3/.test(rDrop.reason));

// renderer names every drop
const rendered = renderReconciliation(rf).join('\n');
check('N. renderer states the planned = generated + dropped identity', /planned 6 = generated 2 \+ dropped 4/.test(rendered));
check('O. renderer shows the stable/recovered/flaky/broken split', /stable 1 · recovered 1 · flaky 0 · broken 1/.test(rendered));
check('P. renderer lists each dropped scenario by name', ['G', 'C', 'R', 'S3'].every((n) => rendered.includes(`"${n}"`)));
check('Q. renderer marks the run balanced (OK)', /\[OK\]/.test(rendered));

/* ─── 3. A broken-from-zero scenario is broken without a give-up flag ─────── */
const zeroBroken: RunReport = {
  ...clean,
  scenarios: [scn('A')],
  plan: [{ name: 'A', category: 'happy', rationale: '' }, { name: 'X', category: 'happy', rationale: '' }],
  stability: {
    iterations: 3, passed: 1, flaked: 1, flaky: 0, broken: 1, recovered: 0, flakeRate: 0.5, durationMs: 0,
    verdicts: [
      { name: 'A', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 0 },
      { name: 'X', iterations: 3, passes: 0, stable: false, classification: 'broken', pattern: 'F-F-F', durationMs: 0 },
    ],
  },
};
const rz = reconcile(zeroBroken);
const xDrop = rz.dropped.find((d) => d.name === 'X');
check('R. zero-pass broken is counted broken and named "every iteration failed"', rz.broken === 1 && !!xDrop && /every iteration failed/.test(xDrop.reason));
check('S. zero-pass broken balances planned 2 = generated 1 + dropped 1', rz.balanced && rz.planned === 2 && rz.generated === 1 && rz.dropped.length === 1);

/* ─── 4. Unbalanced: Explorer produced fewer than planned ────────────────── */
const short: RunReport = {
  ...clean,
  scenarios: [scn('A'), scn('B')],
  plan: ['A', 'B', 'C', 'D'].map((n) => ({ name: n, category: 'happy', rationale: '' })),
  stability: {
    iterations: 3, passed: 2, flaked: 0, flakeRate: 0, durationMs: 0,
    verdicts: [
      { name: 'A', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 0 },
      { name: 'B', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 0 },
    ],
  },
};
const rsh = reconcile(short);
check('T. shortfall is flagged MISMATCH (planned 4 > accountedFor 2)', !rsh.balanced && rsh.planned === 4 && rsh.accountedFor === 2 && rsh.added === 0);
check('U. shortfall carries an explanatory note', !!rsh.note && /vanished/.test(rsh.note));

/* ─── 4b. Surplus: Explorer added a scenario beyond the plan (still balances) ─ */
// The progressbar run: 3 planned, Explorer added a 4th (an a11y check). One of
// the four failed replay. accountedFor 4 = generated 3 + dropped 1, planned 3.
// A surplus is benign — every scenario is named — so it must read OK, not MISMATCH.
const surplus: RunReport = {
  ...clean,
  scenarios: [scn('A'), scn('B'), scn('D')],
  plan: ['A', 'B', 'C'].map((n) => ({ name: n, category: 'happy', rationale: '' })),
  replay: {
    passed: 3, failed: 1, durationMs: 0,
    verdicts: [
      { name: 'A', passed: true, durationMs: 0 },
      { name: 'B', passed: true, durationMs: 0 },
      { name: 'D', passed: true, durationMs: 0 },
      { name: 'C', passed: false, failedStep: 5, stepKind: 'assert', error: 'overshoot 102', durationMs: 0 },
    ],
  },
  stability: {
    iterations: 3, passed: 3, flaked: 0, flakeRate: 0, durationMs: 0,
    verdicts: [
      { name: 'A', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 0 },
      { name: 'B', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 0 },
      { name: 'D', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 0 },
    ],
  },
};
const rsp = reconcile(surplus);
check('T2. surplus balances OK (planned 3, accountedFor 4, added 1)',
  rsp.balanced && rsp.planned === 3 && rsp.accountedFor === 4 && rsp.added === 1 && rsp.generated === 3 && rsp.dropped.length === 1);
const rspRendered = renderReconciliation(rsp).join('\n');
check('U2. surplus headline shows "(+1 added)" and reads [OK]',
  /planned 3 \(\+1 added\)/.test(rspRendered) && /\[OK\]/.test(rspRendered) && !/\[MISMATCH\]/.test(rspRendered));

/* ─── 5. No plan recorded: reconcile against the pipeline total ──────────── */
const noPlan: RunReport = { ...clean, plan: undefined };
const rnp = reconcile(noPlan);
check('V. no-plan run sets planned to the accounted-for total and balances', rnp.noPlan === true && rnp.balanced && rnp.planned === rnp.accountedFor);

/* ─── 6b. Incomplete: a scenario begun but never finalized ───────────────── */
// plan of 3: A shipped stable, B dropped at replay, C left INCOMPLETE.
// planned 3 = generated 1 + dropped 1 + incomplete 1.
const withIncomplete: RunReport = {
  url: 'https://example.com/', language: 'ts',
  scenarios: [scn('A')],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: baseCost, steps: 0, startedAt: '', finishedAt: '',
  plan: ['A', 'B', 'C'].map((n) => ({ name: n, category: 'happy', rationale: '' })),
  replay: {
    passed: 1, failed: 1, durationMs: 0,
    verdicts: [
      { name: 'A', passed: true, durationMs: 0 },
      { name: 'B', passed: false, failedStep: 1, stepKind: 'assert', error: 'timeout', durationMs: 0 },
    ],
  },
  stability: {
    iterations: 3, passed: 1, flaked: 0, flakeRate: 0, durationMs: 0,
    verdicts: [
      { name: 'A', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 0 },
    ],
  },
  incomplete: [{ scenario: 'C', reason: 'step budget exhausted' }],
};
const ri = reconcile(withIncomplete);
check('X. incomplete balances planned 3 = generated 1 + dropped 1 + incomplete 1',
  ri.balanced && ri.planned === 3 && ri.generated === 1 && ri.dropped.length === 1 && ri.incomplete.length === 1 && ri.accountedFor === 3);
check('Y. the incomplete scenario is named with its reason', ri.incomplete[0]?.name === 'C' && /step budget exhausted/.test(ri.incomplete[0]?.reason ?? ''));
const ir = renderReconciliation(ri).join('\n');
check('Z. renderer states the full identity including incomplete', /planned 3 = generated 1 \+ dropped 1 \+ incomplete 1 \[OK\]/.test(ir));
check('Z2. renderer lists the incomplete scenario by name', /incomplete:/.test(ir) && /"C" — step budget exhausted/.test(ir));

// a clean run shows no incomplete term (back-compat with the old line)
const cleanRender = renderReconciliation(reconcile(clean)).join('\n');
check('Z3. a run with nothing incomplete keeps the bare generated+dropped line', /planned 3 = generated 3 \+ dropped 0 \[OK\]/.test(cleanRender) && !/incomplete/.test(cleanRender));

/* ─── 6. Stability skipped: shipped scenarios count as stable ────────────── */
const skipped: RunReport = {
  ...clean,
  scenarios: [scn('A'), scn('B')],
  plan: [{ name: 'A', category: 'happy', rationale: '' }, { name: 'B', category: 'happy', rationale: '' }],
  stability: { skipped: true, iterations: 3, passed: 0, flaked: 0, flakeRate: 0, durationMs: 0, verdicts: [] },
};
const rsk = reconcile(skipped);
check('W. stability skipped: generated counts as stable, none recovered', rsk.stable === 2 && rsk.recovered === 0 && rsk.balanced);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: reconciliation balances planned = generated + dropped, names every drop, excludes recovered from stable, counts give-ups as broken.');
