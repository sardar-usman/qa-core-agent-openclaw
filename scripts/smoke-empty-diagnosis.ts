/**
 * Locks the cause-specific empty-run diagnosis (src/agent/reconcile.ts):
 * a run with zero surviving scenarios must say WHERE the funnel emptied,
 * with counts, never the old blanket "the Planner couldn't reach the URL":
 *   (a) planner-none       — the Planner planned nothing
 *   (b) explorer-none      — planned N, the Explorer recorded none
 *   (c) critic-gated-all   — recorded N, the Critic gated all N (verdicts shown)
 *   (d) replay-dropped-all — survivors existed, replay/stability dropped every one
 * A run with scenarios diagnoses as null.
 *
 * Pure fixture reports. No network. No LLM. No browser.
 */
import { diagnoseEmptyRun } from '../src/agent/reconcile.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const base = { scenarios: [], url: 'https://x.example/', language: 'ts' } as unknown as RunReport;
const plan4 = ['s1', 's2', 's3', 's4'].map((name) => ({ name, category: 'happy', rationale: 'r' }));

/* ─── (a) planner planned none ─────────────────────────────────────────────── */
const a = diagnoseEmptyRun({ ...base });
check('A1. no plan -> planner-none', a?.cause === 'planner-none', a?.cause);
check('A2. the line says the Planner planned 0', a?.lines[0]?.includes('Planner planned 0') === true, JSON.stringify(a?.lines));

/* ─── (b) explorer recorded none ───────────────────────────────────────────── */
const b = diagnoseEmptyRun({
  ...base,
  plan: plan4,
  findings: [
    { scenario: 's1', expected: 'a success banner', url: 'https://x.example/login', messages: ['Invalid credentials'] },
    { scenario: 's2', expected: 'a redirect', url: 'https://x.example/', messages: [] },
  ],
  incomplete: [{ scenario: 's3', reason: 'step budget exhausted' }],
  gate: { broken: [{ scenario: 's4', reason: 'could not generate without hard sleep', attempts: 2 }], injections: [] },
} as unknown as RunReport);
check('B1. planned 4, recorded 0 -> explorer-none', b?.cause === 'explorer-none', b?.cause);
check('B2. the headline counts planned vs recorded', b?.lines[0]?.includes('0 of 4') === true, JSON.stringify(b?.lines));
check('B3. findings, incomplete, and gate drops are itemized',
  b?.lines.some((l) => l.includes('2 became finding(s)')) === true &&
  b?.lines.some((l) => l.includes('1 left incomplete')) === true &&
  b?.lines.some((l) => l.includes('1 broke at the gate')) === true, JSON.stringify(b?.lines));
check('B4. the diagnosis kills the "could not reach the URL" myth',
  b?.lines.some((l) => l.includes('The page was reached')) === true);

/* ─── (c) critic gated all: THE live-run case (6 of 6 gated, $4.19 lost) ───── */
const criticVerdicts = ['s1', 's2', 's3'].map((scenario) => ({
  scenario,
  verdict: 'rework' as const,
  reasons: ['assertion is vacuous: toBeVisible on the element just clicked'],
  required_fixes: ['assert the outcome, not the control'],
}));
const c = diagnoseEmptyRun({
  ...base,
  plan: plan4.slice(0, 3),
  review: { verdicts: criticVerdicts, summary: 'weak' },
} as unknown as RunReport);
check('C1. recorded 3, critic gated 3 -> critic-gated-all', c?.cause === 'critic-gated-all', c?.cause);
check('C2. the headline says the Critic gated ALL of them', c?.lines[0]?.includes('the Critic gated ALL') === true, JSON.stringify(c?.lines));
check('C3. the verdict summary is printed with reasons',
  c?.lines.filter((l) => l.includes('rework')).length === 3 &&
  c?.lines.some((l) => l.includes('vacuous')) === true);

/* ─── (d) replay/stability dropped every survivor ──────────────────────────── */
const d = diagnoseEmptyRun({
  ...base,
  plan: plan4.slice(0, 3),
  review: {
    verdicts: [
      { scenario: 's1', verdict: 'pass', reasons: [], required_fixes: [] },
      { scenario: 's2', verdict: 'pass', reasons: [], required_fixes: [] },
      { scenario: 's3', verdict: 'reject', reasons: ['redundant'], required_fixes: [] },
    ],
    summary: '',
  },
  replay: {
    skipped: false, passed: 0, failed: 2, durationMs: 100,
    verdicts: [
      { name: 's1', passed: false, failedStep: 2, stepKind: 'assert', error: 'toHaveText timed out' },
      { name: 's2', passed: false, failedStep: 0, stepKind: 'navigate', error: 'net::ERR_TIMED_OUT' },
    ],
  },
} as unknown as RunReport);
check('D1. survivors existed, replay dropped them -> replay-dropped-all', d?.cause === 'replay-dropped-all', d?.cause);
check('D2. the headline carries recorded / survived / dropped counts',
  d?.lines[0]?.includes('recorded 3') === true && d?.lines[0]?.includes('2 passed the Critic') === true, JSON.stringify(d?.lines));
check('D3. each replay drop is named with its error', d?.lines.some((l) => l.includes('ERR_TIMED_OUT')) === true);

/* ─── a run with output diagnoses as null ──────────────────────────────────── */
const ok = diagnoseEmptyRun({ ...base, scenarios: [{ name: 's1' }] } as unknown as RunReport);
check('E1. a non-empty run returns null', ok === null);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: an empty run names the stage that emptied the funnel, with counts and verdicts, instead of blaming the URL.');
