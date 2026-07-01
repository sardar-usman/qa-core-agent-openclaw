/**
 * Locks in the Stabilizer (Stage 5b) — the LLM-guided flake recovery layer.
 *
 * We don't exercise the live LLM call here (costs money, non-deterministic).
 * We test the two pure functions the recovery loop depends on:
 *
 *   parseProposal()   — turns the model's tagged response into a typed
 *                       proposal. Falls back to {kind: 'none'} on bad input.
 *
 *   applyProposal()   — mutates a Scenario in place to apply the fix:
 *                       timeout_raise patches the assertion timeout;
 *                       wait_for_state inserts a locator.waitFor() step;
 *                       swap replaces the target locator;
 *                       broken/none are no-ops.
 *
 * Remediation hierarchy tested: timeout_raise → wait_for_state → swap →
 * broken → none. page.waitForTimeout / 'wait' is no longer a valid proposal.
 *
 * Zero network, zero LLM.
 */
import {
  parseProposal,
  applyProposal,
  type StabilizerProposal,
} from '../src/agent/stabilizer.js';
import type { Scenario, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── parseProposal: timeout_raise ──────────────────────────────────── */

const tr = parseProposal('<kind>timeout_raise</kind><timeout>15000</timeout><reason>progress bar animation</reason>');
check('A. parses timeout_raise proposal', tr.kind === 'timeout_raise');
if (tr.kind === 'timeout_raise') {
  check('B. timeout_raise timeout parsed correctly', tr.timeout === 15000);
  check('C. timeout_raise reason carried through', tr.reason === 'progress bar animation');
}

const trWs = parseProposal('\n<kind>  timeout_raise  </kind>\n<timeout>\n  20000\n</timeout>\n<reason>slow counter</reason>');
check('D. timeout_raise parses with surrounding whitespace',
  trWs.kind === 'timeout_raise' && (trWs as { timeout: number }).timeout === 20000);

const trHigh = parseProposal('<kind>timeout_raise</kind><timeout>90000</timeout><reason>x</reason>');
check('E. timeout above 60000 clamped to 60000',
  trHigh.kind === 'timeout_raise' && (trHigh as { timeout: number }).timeout === 60000);

const trLow = parseProposal('<kind>timeout_raise</kind><timeout>100</timeout><reason>x</reason>');
check('F. timeout below 5000 clamped to 5000',
  trLow.kind === 'timeout_raise' && (trLow as { timeout: number }).timeout === 5000);

const trBad = parseProposal('<kind>timeout_raise</kind><timeout>soon</timeout><reason>x</reason>');
check('G. timeout_raise with non-numeric degrades to none', trBad.kind === 'none');

/* ─── parseProposal: wait_for_state ─────────────────────────────────── */

const wfs = parseProposal('<kind>wait_for_state</kind><state>visible</state><state_timeout>10000</state_timeout><reason>button not yet in DOM</reason>');
check('H. parses wait_for_state proposal', wfs.kind === 'wait_for_state');
if (wfs.kind === 'wait_for_state') {
  check('I. wait_for_state state parsed', wfs.state === 'visible');
  check('J. wait_for_state stateTimeout parsed', wfs.stateTimeout === 10000);
  check('K. wait_for_state reason carried', wfs.reason === 'button not yet in DOM');
}

const wfsAttached = parseProposal('<kind>wait_for_state</kind><state>attached</state><reason>spinner left DOM</reason>');
check('L. wait_for_state accepts "attached" state',
  wfsAttached.kind === 'wait_for_state' && (wfsAttached as { state: string }).state === 'attached');

const wfsBadState = parseProposal('<kind>wait_for_state</kind><state>loaded</state><reason>x</reason>');
check('M. wait_for_state with invalid state degrades to none', wfsBadState.kind === 'none');

/* ─── parseProposal: broken ──────────────────────────────────────────── */

const br = parseProposal('<kind>broken</kind><reason>assertion expects a hardcoded price from one run</reason>');
check('N. parses broken proposal', br.kind === 'broken');
check('O. broken reason carried through', br.kind === 'broken' && br.reason === 'assertion expects a hardcoded price from one run');

/* ─── parseProposal: swap ────────────────────────────────────────────── */

const sRole = parseProposal(
  `<kind>swap</kind>` +
  `<level>role</level>` +
  `<arg>{"role":"button","name":"Login","exact":true}</arg>` +
  `<reason>strict mode violation</reason>`,
);
check('P. parses swap proposal at role level', sRole.kind === 'swap');
if (sRole.kind === 'swap') {
  check('Q. swap level is role', sRole.newTarget.level === 'role');
  const arg = sRole.newTarget.arg as { role: string; name: string; exact: boolean };
  check('R. swap arg has role+name+exact', arg.role === 'button' && arg.name === 'Login' && arg.exact === true);
}

const sTestid = parseProposal(
  `<kind>swap</kind><level>testid</level><arg>login-button</arg><reason>found a data-test</reason>`,
);
check('S. parses swap at testid level (plain string arg)',
  sTestid.kind === 'swap' && sTestid.newTarget.level === 'testid' && sTestid.newTarget.arg === 'login-button');

const sPlaceholder = parseProposal(
  `<kind>swap</kind><level>placeholder</level><arg>"Password"</arg><reason>ambiguous</reason>`,
);
check('T. parses swap at placeholder, strips JSON quotes',
  sPlaceholder.kind === 'swap' && sPlaceholder.newTarget.arg === 'Password');

const sBadLevel = parseProposal(`<kind>swap</kind><level>magic</level><arg>foo</arg><reason>x</reason>`);
check('U. swap with unknown level degrades to none',
  sBadLevel.kind === 'none' && sBadLevel.reason.includes('unknown cascade level'));

const sBadRoleArg = parseProposal(`<kind>swap</kind><level>role</level><arg>not-an-object</arg><reason>x</reason>`);
check('V. swap at role with non-object arg degrades to none', sBadRoleArg.kind === 'none');

/* ─── parseProposal: none + edge cases ──────────────────────────────── */

const nExplicit = parseProposal('<kind>none</kind><reason>genuine assertion mismatch, real bug</reason>');
check('W. parses explicit none',
  nExplicit.kind === 'none' && nExplicit.reason === 'genuine assertion mismatch, real bug');

const nEmpty = parseProposal('');
check('X. empty response degrades to none', nEmpty.kind === 'none');

// Tags still extractable from inside markdown fences
const md = parseProposal(`Here is my fix:\n\`\`\`\n<kind>timeout_raise</kind><timeout>20000</timeout><reason>r</reason>\n\`\`\``);
check('Y. tolerates response wrapped in markdown fences',
  md.kind === 'timeout_raise' && (md as { timeout: number }).timeout === 20000);

/* ─── applyProposal: timeout_raise ──────────────────────────────────── */

function makeScenario(): Scenario {
  const steps: TraceStep[] = [
    { kind: 'navigate', url: 'https://example.com/' },
    { kind: 'fill', target: { level: 'role', arg: { role: 'textbox', name: 'Username' }, intent: 'username field' }, value: 'alice' },
    { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Submit' }, intent: 'submit button' } },
    {
      kind: 'assert',
      name: 'progress complete',
      assertion: { type: 'toHaveText', target: { level: 'css', arg: '.bar', intent: 'progress bar' }, text: '100%' },
    },
  ];
  return { name: 'submits form', category: 'happy', steps };
}

// timeout_raise patches the assertion's timeout field without adding a step
const sc1 = makeScenario();
applyProposal(sc1, 3, { kind: 'timeout_raise', timeout: 20000, reason: 'animation' });
check('Z. timeout_raise does not change step count', sc1.steps.length === 4);
const assertStep = sc1.steps[3] as { kind: 'assert'; assertion: { type: string; timeout?: number } };
check('AA. timeout_raise patches assertion.timeout', assertStep.assertion.timeout === 20000);
check('AB. timeout_raise on non-assert step is a no-op (step count stays 4 when target is fill)',
  (() => {
    const sc = makeScenario();
    applyProposal(sc, 1, { kind: 'timeout_raise', timeout: 20000, reason: 'x' }); // index 1 is a fill
    return sc.steps.length === 4;
  })());

/* ─── applyProposal: wait_for_state ─────────────────────────────────── */

// wait_for_state inserts a new step BEFORE the failing click
const sc2 = makeScenario();
applyProposal(sc2, 2, { kind: 'wait_for_state', state: 'visible', reason: 'button not ready' });
check('AC. wait_for_state inserts before failing step (length grows by 1)', sc2.steps.length === 5);
check('AD. inserted step kind is wait_for_state', sc2.steps[2]?.kind === 'wait_for_state');
const insertedWfs = sc2.steps[2] as TraceStep & { kind: 'wait_for_state'; state: string; target: { intent: string } };
check('AE. inserted wait_for_state has correct state', insertedWfs.state === 'visible');
check('AF. inserted wait_for_state inherits the failing step target', insertedWfs.target.intent === 'submit button');
check('AG. original click step is now at index 3', sc2.steps[3]?.kind === 'click');

// wait_for_state at index 0 when the step has a target — inserts at front
const sc3: Scenario = {
  name: 'mini',
  category: 'happy',
  steps: [
    { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Go' }, intent: 'go button' } },
    { kind: 'assert', name: 'ok', assertion: { type: 'toHaveURL', pattern: '/done' } },
  ],
};
applyProposal(sc3, 0, { kind: 'wait_for_state', state: 'attached', reason: 'r' });
check('AH. wait_for_state at index 0 (click step) inserts at the front', sc3.steps[0]?.kind === 'wait_for_state');
check('AI. original click step is now at index 1', sc3.steps[1]?.kind === 'click');

/* ─── applyProposal: swap ────────────────────────────────────────────── */

const sc4 = makeScenario();
applyProposal(sc4, 2, {
  kind: 'swap',
  newTarget: { level: 'testid', arg: 'login-btn', intent: '' },
  reason: 'better selector',
});
const swappedStep = sc4.steps[2] as TraceStep & { target: { level: string; arg: unknown; intent: string } };
check('AJ. swap replaces target.level', swappedStep.target.level === 'testid');
check('AK. swap replaces target.arg', swappedStep.target.arg === 'login-btn');
check('AL. swap PRESERVES the original target.intent', swappedStep.target.intent === 'submit button');
check('AM. swap does NOT change step count', sc4.steps.length === 4);

/* ─── applyProposal: broken / none ──────────────────────────────────── */

const sc5 = makeScenario();
const before5 = JSON.stringify(sc5);
applyProposal(sc5, 2, { kind: 'broken', reason: 'semantic defect' });
check('AN. broken proposal leaves scenario unchanged', JSON.stringify(sc5) === before5);

const sc6 = makeScenario();
const before6 = JSON.stringify(sc6);
applyProposal(sc6, 2, { kind: 'none', reason: 'irrelevant' });
check('AO. none proposal leaves scenario unchanged', JSON.stringify(sc6) === before6);

// Out-of-range index must not throw or corrupt
const sc7 = makeScenario();
const beforeBad = JSON.stringify(sc7);
applyProposal(sc7, 99, { kind: 'swap', newTarget: { level: 'testid', arg: 'x', intent: '' }, reason: 'r' });
check('AP. swap at out-of-range index is a no-op', JSON.stringify(sc7) === beforeBad);

/* ─── hostile/malformed — never throw ───────────────────────────────── */

const hostile = [
  '<kind>TIMEOUT_RAISE</kind>',                                  // wrong case (case-insensitive)
  '<kind>timeout_raise</kind>',                                  // missing timeout tag
  '<kind>timeout_raise</kind><timeout>not-a-number</timeout>',  // non-numeric
  '<kind>wait_for_state</kind>',                                 // missing state
  '<kind>wait_for_state</kind><state>loaded</state>',            // invalid state
  '<kind>swap</kind>',                                           // missing level + arg
  '<kind>swap</kind><level>role</level><arg>{bad}</arg>',        // unparseable JSON
  '<kind>destroy</kind><reason>x</reason>',                     // invalid kind
  '<kind></kind>',                                               // empty kind
  '',                                                            // empty
];
const validKinds = new Set(['timeout_raise', 'wait_for_state', 'swap', 'broken', 'none']);
let allHostileOk = true;
for (const raw of hostile) {
  try {
    const r: StabilizerProposal = parseProposal(raw);
    if (!validKinds.has(r.kind)) allHostileOk = false;
  } catch {
    allHostileOk = false;
  }
}
check('AQ. all hostile inputs produce a valid StabilizerProposal (never throws)', allHostileOk);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: Stabilizer parses proposals safely and mutates scenarios in place.');
