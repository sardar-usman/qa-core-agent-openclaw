/**
 * Locks in Tier B — the multi-attempt Stabilizer loop.
 *
 * This round reflects the new remediation hierarchy:
 *   timeout_raise  — raise assertion timeout for animation/async races
 *   wait_for_state — insert locator.waitFor() for element-not-ready cases
 *   swap           — replace the locator for strict-mode / not-found failures
 *   broken         — semantic defect, reclassify as BROKEN
 *   none           — genuinely can't determine a fix
 *
 *   FORBIDDEN: 'wait' (page.waitForTimeout). A scenario kept alive by a
 *   hard sleep MUST NOT be reported as stable.
 *
 * Tests the pure helpers:
 *   - parseProposal: timeout clamping, state validation
 *   - describeProposal: compact history-block format
 *   - applyProposal reset semantics: structuredClone isolation between attempts
 *   - PreviousAttempt shape: minimal data the loop accumulates
 *
 * Zero network, zero LLM.
 */
import {
  parseProposal,
  applyProposal,
  describeProposal,
  type StabilizerProposal,
  type PreviousAttempt,
} from '../src/agent/stabilizer.js';
import type { Scenario, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── timeout_raise clamping ─────────────────────────────────────────── */

const tr15 = parseProposal('<kind>timeout_raise</kind><timeout>15000</timeout><reason>animation</reason>');
check('A. timeout_raise of 15000ms is accepted as-is',
  tr15.kind === 'timeout_raise' && (tr15 as { timeout: number }).timeout === 15000);

const tr60 = parseProposal('<kind>timeout_raise</kind><timeout>60000</timeout><reason>very slow</reason>');
check('B. timeout_raise of 60000ms (max) accepted as-is',
  tr60.kind === 'timeout_raise' && (tr60 as { timeout: number }).timeout === 60000);

const tr90 = parseProposal('<kind>timeout_raise</kind><timeout>90000</timeout><reason>x</reason>');
check('C. timeout_raise above 60000 clamped to 60000',
  tr90.kind === 'timeout_raise' && (tr90 as { timeout: number }).timeout === 60000);

const tr100 = parseProposal('<kind>timeout_raise</kind><timeout>100</timeout><reason>too small</reason>');
check('D. timeout_raise below 5000 clamped to 5000',
  tr100.kind === 'timeout_raise' && (tr100 as { timeout: number }).timeout === 5000);

/* ─── wait_for_state state_timeout clamping ─────────────────────────── */

const wfs30 = parseProposal('<kind>wait_for_state</kind><state>visible</state><state_timeout>30000</state_timeout><reason>x</reason>');
check('E. wait_for_state state_timeout of 30000ms accepted as-is',
  wfs30.kind === 'wait_for_state' && (wfs30 as { stateTimeout?: number }).stateTimeout === 30000);

const wfs50 = parseProposal('<kind>wait_for_state</kind><state>attached</state><state_timeout>50000</state_timeout><reason>x</reason>');
check('F. wait_for_state state_timeout above 30000 clamped to 30000',
  wfs50.kind === 'wait_for_state' && (wfs50 as { stateTimeout?: number }).stateTimeout === 30000);

const wfsNoTimeout = parseProposal('<kind>wait_for_state</kind><state>visible</state><reason>no state_timeout tag</reason>');
check('G. wait_for_state without state_timeout tag is valid (stateTimeout undefined)',
  wfsNoTimeout.kind === 'wait_for_state' && (wfsNoTimeout as { stateTimeout?: number }).stateTimeout === undefined);

/* ─── describeProposal compact format ───────────────────────────────── */

check('H. describes timeout_raise',
  describeProposal({ kind: 'timeout_raise', timeout: 20000, reason: 'x' }) === 'timeout_raise(20000ms)');

check('I. describes wait_for_state with stateTimeout',
  describeProposal({ kind: 'wait_for_state', state: 'visible', stateTimeout: 10000, reason: 'x' }) === 'wait_for_state(visible, 10000ms)');

check('J. describes wait_for_state without stateTimeout',
  describeProposal({ kind: 'wait_for_state', state: 'attached', reason: 'x' }) === 'wait_for_state(attached)');

check('K. describes swap with string arg',
  describeProposal({
    kind: 'swap',
    newTarget: { level: 'testid', arg: 'login-button', intent: '' },
    reason: 'x',
  }) === 'swap → testid(login-button)');

check('L. describes swap with role+name arg as JSON',
  describeProposal({
    kind: 'swap',
    newTarget: { level: 'role', arg: { role: 'button', name: 'Login' }, intent: '' },
    reason: 'x',
  }).startsWith('swap → role('));

check('M. describes broken with reason',
  describeProposal({ kind: 'broken', reason: 'assertion expects a stale price' })
    .includes('spec defect'));

check('N. describes none with reason',
  describeProposal({ kind: 'none', reason: 'no clear fix' }) === 'none (no clear fix)');

/* ─── applyProposal reset semantics (structuredClone isolation) ──────── */

// The loop snapshots originalSteps once, then resets scenario.steps before
// each attempt so proposals don't stack cumulatively.

function makeScenario(): Scenario {
  const steps: TraceStep[] = [
    { kind: 'navigate', url: 'https://example.com/' },
    { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Start' }, intent: 'start button' } },
    {
      kind: 'assert',
      name: 'progress complete',
      assertion: { type: 'toHaveText', target: { level: 'css', arg: '.bar', intent: 'bar' }, text: '100%' },
    },
  ];
  return { name: 'progress bar', category: 'happy', steps };
}

const sc = makeScenario();
const snapshot = structuredClone(sc.steps);

// Attempt 1: timeout_raise on the assert step (index 2). No new step added.
applyProposal(sc, 2, { kind: 'timeout_raise', timeout: 20000, reason: 'slow animation' });
check('O. attempt 1 (timeout_raise): step count unchanged (still 3)', sc.steps.length === 3);
check('P. attempt 1 patches assertion.timeout to 20000',
  (sc.steps[2] as { kind: string; assertion?: { timeout?: number } }).assertion?.timeout === 20000);
check('Q. snapshot is unaffected by attempt 1 mutation',
  (snapshot[2] as { kind: string; assertion?: { timeout?: number } }).assertion?.timeout === undefined);

// Reset to snapshot between attempts
sc.steps = structuredClone(snapshot);
check('R. resetting from snapshot restores step count to 3', sc.steps.length === 3);
check('S. reset restores step kinds (navigate, click, assert)',
  sc.steps[0]?.kind === 'navigate' && sc.steps[1]?.kind === 'click' && sc.steps[2]?.kind === 'assert');
check('T. reset clears the timeout_raise patch',
  (sc.steps[2] as { kind: string; assertion?: { timeout?: number } }).assertion?.timeout === undefined);

// Attempt 2: wait_for_state on the click step (index 1). Inserts a new step.
applyProposal(sc, 1, { kind: 'wait_for_state', state: 'visible', reason: 'button not ready' });
check('U. attempt 2 (wait_for_state): step count grows to 4', sc.steps.length === 4);
check('V. inserted step is wait_for_state at index 1', sc.steps[1]?.kind === 'wait_for_state');

// Reset again + attempt 3: swap. Starts from CLEAN 3-step scenario.
sc.steps = structuredClone(snapshot);
applyProposal(sc, 1, {
  kind: 'swap',
  newTarget: { level: 'testid', arg: 'start-btn', intent: '' },
  reason: 'x',
});
const swapped = sc.steps[1] as TraceStep & { target: { level: string; arg: unknown } };
check('W. attempt 3 (swap) sees a clean 3-step scenario', sc.steps.length === 3);
check('X. swap replaced target.level on the click step', swapped.target.level === 'testid');

/* ─── previousAttempts shape and history format ──────────────────────── */

const attempts: PreviousAttempt[] = [
  { proposal: { kind: 'timeout_raise', timeout: 15000, reason: 'first try' }, pattern: 'F-F-F' },
  { proposal: { kind: 'wait_for_state', state: 'visible', stateTimeout: 10000, reason: 'retry' }, pattern: 'F-P-F' },
];

check('Y. PreviousAttempt has proposal + pattern fields only',
  Object.keys(attempts[0]!).sort().join() === 'pattern,proposal');

const lines = attempts.map((a, i) => `${i + 1}. ${describeProposal(a.proposal)} — pattern: ${a.pattern}`);
check('Z. history lines format cleanly for timeout_raise',
  lines[0] === '1. timeout_raise(15000ms) — pattern: F-F-F');
check('AA. history lines format cleanly for wait_for_state',
  lines[1] === '2. wait_for_state(visible, 10000ms) — pattern: F-P-F');

/* ─── Defensive: all hostile/malformed inputs still degrade safely ───── */

const hostile = [
  '<kind>TIMEOUT_RAISE</kind>',                                  // wrong case (case-insensitive)
  '<kind>timeout_raise</kind>',                                  // missing timeout
  '<kind>timeout_raise</kind><timeout>not-a-number</timeout>',  // non-numeric
  '<kind>wait_for_state</kind>',                                 // missing state
  '<kind>wait_for_state</kind><state>loaded</state>',            // invalid state value
  '<kind>swap</kind>',                                           // missing level + arg
  '<kind>wait</kind><ms>1000</ms>',                              // old forbidden kind
  '<kind>destroy</kind><reason>x</reason>',                     // invalid kind
  '<kind>none</kind>',                                           // valid but minimal
  '',                                                            // empty
];
const validKinds = new Set(['timeout_raise', 'wait_for_state', 'swap', 'broken', 'none']);
let allOk = true;
for (const raw of hostile) {
  try {
    const r: StabilizerProposal = parseProposal(raw);
    if (!validKinds.has(r.kind)) allOk = false;
  } catch {
    allOk = false;
  }
}
check('AB. malformed/forbidden inputs all degrade to a valid proposal (never throws)', allOk);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: Tier B helpers — new remediation hierarchy, clamping, history wiring, reset semantics — all hold.');
