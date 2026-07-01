/**
 * Locks in the static validation gate (src/agent/gate.ts).
 *
 * Tests four rules — pure function, zero LLM, zero network.
 *
 *   RULE 1: Any { kind: 'wait' } step triggers a BLOCKING violation.
 *           Exception: { kind: 'stability_wait' } is always allowed.
 *   RULE 2: Async assertions that lack a sufficient timeout get 20 000 ms
 *           injected in-place (not a rejection).
 *   RULE 3: Only FRAGILE CSS-tier locators on animated elements are rejected.
 *           Stable selectors (#id, [data-*], single semantic class) are
 *           allowed even on animated elements.
 *   RULE 4: Intermediate numeric text assertions on animated elements are
 *           blocked when corroborated by an assert_freeze on the same intent.
 *
 * Also covers isStableCssSelector / isFragileCssSelector directly.
 */
import { runGate, isStableCssSelector, isFragileCssSelector } from '../src/agent/gate.js';
import type { Scenario, SelectorRecord, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── helpers ───────────────────────────────────────────────────────────── */

function makeScenario(steps: TraceStep[]): Scenario {
  // Clone so shared constant step objects don't accumulate mutations across tests
  return { name: 'test scenario', category: 'happy', steps: structuredClone(steps) };
}

// assert_freeze is now recorded as the general capture-and-compare sequence.
// The gate's RULE 3a/4 corroboration keys off the assert_compare step's target,
// so the gate tests build that step directly via this helper.
function freezeCompare(target: SelectorRecord, intent: string): TraceStep {
  return {
    kind: 'assert_compare',
    varName: 'cap',
    relation: 'unchanged',
    source: 'attribute',
    target,
    attribute: 'aria-valuenow',
    intent,
    readVar: 'capNow',
  };
}

const NAV: TraceStep = { kind: 'navigate', url: 'https://example.com/' };
const CLICK_ROLE: TraceStep = {
  kind: 'click',
  target: { level: 'role', arg: { role: 'button', name: 'Start' }, intent: 'start button' },
};
const ASSERT_ROLE: TraceStep = {
  kind: 'assert',
  name: 'value visible',
  assertion: { type: 'toHaveText', target: { level: 'role', arg: { role: 'status', name: '' }, intent: 'result text' }, text: '100%' },
};

/* ─── isStableCssSelector ────────────────────────────────────────────────── */

check('A. #id is stable',                   isStableCssSelector('#progressBar'));
check('B. #hyphenated-id is stable',        isStableCssSelector('#my-element'));
check('C. [data-testid=x] is stable',       isStableCssSelector('[data-testid="submit"]'));
check('D. [data-cy] bare attr is stable',   isStableCssSelector('[data-cy]'));
check('E. .semantic-class is stable',       isStableCssSelector('.progress-bar'));
check('F. .singleword is stable',           isStableCssSelector('.container'));
check('G. .short-digit (h2) is stable',     isStableCssSelector('.h2'));
check('H. .css-1a2b3c is NOT stable',       !isStableCssSelector('.css-1a2b3c'));
check('I. .sc-9f2k is NOT stable',          !isStableCssSelector('.sc-9f2k'));
check('J. div.foo is NOT stable',           !isStableCssSelector('div.foo'));

/* ─── isFragileCssSelector ───────────────────────────────────────────────── */

check('K. #id is NOT fragile',                         !isFragileCssSelector('#bar'));
check('L. [data-*] is NOT fragile',                    !isFragileCssSelector('[data-testid="x"]'));
check('M. .single-class is NOT fragile',               !isFragileCssSelector('.container'));
check('N. :nth-child is fragile',                      isFragileCssSelector('li:nth-child(2)'));
check('O. :first-child is fragile',                    isFragileCssSelector('li:first-child'));
check('P. css-1a2b3c is fragile (hashed class)',       isFragileCssSelector('.css-1a2b3c'));
check('Q. sc-9f2k is fragile (hashed class)',          isFragileCssSelector('.sc-9f2k'));
check('R. 3-level chain is fragile',                   isFragileCssSelector('.a .b .c'));
check('S. 3-level > chain is fragile',                 isFragileCssSelector('.a > .b > .c'));
check('T. 2-level chain is NOT fragile',               !isFragileCssSelector('.parent .child'));
check('U. 2-level > chain is NOT fragile',             !isFragileCssSelector('.parent > .child'));

/* ─── RULE 1: hard sleep ─────────────────────────────────────────────────── */

const r1Sc = makeScenario([NAV, { kind: 'wait', ms: 2000 }, ASSERT_ROLE]);
const r1 = runGate(r1Sc);

check('V. RULE 1 — wait step produces a violation', r1.violations.length === 1);
check('W. RULE 1 — violation has rule === 1', r1.violations[0]?.rule === 1);
check('X. RULE 1 — violation detail mentions page.waitForTimeout', r1.violations[0]?.detail.includes('page.waitForTimeout') ?? false);
check('Y. RULE 1 — no injections when there are violations', r1.injections.length === 0);

const r1Clean = makeScenario([NAV, CLICK_ROLE, ASSERT_ROLE]);
check('Z. RULE 1 — clean scenario has no violations', runGate(r1Clean).violations.length === 0);

const r1Multi = makeScenario([NAV, { kind: 'wait', ms: 1000 }, CLICK_ROLE, { kind: 'wait', ms: 500 }, ASSERT_ROLE]);
const r1MultiResult = runGate(r1Multi);
check('AA. RULE 1 — two wait steps produce two violations', r1MultiResult.violations.length === 2);
check('AB. RULE 1 — violations at correct step indices', r1MultiResult.violations[0]?.stepIndex === 1 && r1MultiResult.violations[1]?.stepIndex === 3);

/* ─── RULE 2: minimum timeout injection ──────────────────────────────────── */

const r2Sc = makeScenario([NAV, CLICK_ROLE, ASSERT_ROLE]);
const r2 = runGate(r2Sc);

check('AC. RULE 2 — no violations on clean scenario', r2.violations.length === 0);
check('AD. RULE 2 — one injection for the toHaveText assertion', r2.injections.length === 1);
check('AE. RULE 2 — injection at step index 2', r2.injections[0]?.stepIndex === 2);
check('AF. RULE 2 — injected assertionType is toHaveText', r2.injections[0]?.assertionType === 'toHaveText');
const assertAfterInject = r2Sc.steps[2] as { kind: string; assertion: { timeout?: number } };
check('AG. RULE 2 — missing timeout raised in-place to the 5000 floor', assertAfterInject.assertion.timeout === 5000);

// A timeout at or above the floor (e.g. the adaptive value measured from the
// page) is left untouched — the gate never overrides a real measured budget.
const r2SufficientSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'ok', assertion: { type: 'toHaveText', target: { level: 'role', arg: { role: 'status', name: '' }, intent: 's' }, text: 'done', timeout: 18000 } },
];
check('AH. RULE 2 — adaptive timeout above the floor is not re-injected', runGate(makeScenario(r2SufficientSteps)).injections.length === 0);

// Below the floor — raised up to the floor only.
const r2LowSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'ok', assertion: { type: 'toBeVisible', target: { level: 'role', arg: { role: 'button', name: 'Done' }, intent: 'done button' }, timeout: 3000 } },
];
const r2LowSc = makeScenario(r2LowSteps);
const r2Low = runGate(r2LowSc);
check('AI. RULE 2 — below-floor timeout 3000 raised to the floor', r2Low.injections.length === 1);
check('AJ. RULE 2 — in-place mutation to the 5000 floor confirmed', (r2LowSc.steps[2] as { kind: string; assertion: { timeout?: number } }).assertion.timeout === 5000);
// A timeout exactly at the floor is sufficient — not re-injected.
const r2AtFloorSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'ok', assertion: { type: 'toBeVisible', target: { level: 'role', arg: { role: 'button', name: 'Done' }, intent: 'done button' }, timeout: 5000 } },
];
check('AJ2. RULE 2 — timeout exactly at the 5000 floor is not re-injected', runGate(makeScenario(r2AtFloorSteps)).injections.length === 0);

check('AK. RULE 2 — no injection when no action steps', runGate(makeScenario([{ kind: 'assert', name: 'v', assertion: { type: 'toBeVisible', target: { level: 'role', arg: { role: 'heading', name: 'Home' }, intent: 'h' } } }])).injections.length === 0);
check('AL. RULE 2 — toHaveURL not injected', runGate(makeScenario([NAV, { kind: 'assert', name: 'u', assertion: { type: 'toHaveURL', pattern: '/home' } }])).injections.length === 0);

/* ─── RULE 3: stable selectors always allowed, even on animated elements ─── */

// #id with assert_freeze — STABLE, must NOT be flagged
const r3StableIdFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '#progressBar', intent: 'progress bar' }, 'progress bar'),
]);
const r3IdFreezeResult = runGate(r3StableIdFreeze);
check('AM. RULE 3 — #id with assert_freeze is ALLOWED (no violation)', r3IdFreezeResult.violations.length === 0);

// #id in toHaveText with long timeout — STABLE, must NOT be flagged
const r3IdLongTimeout: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'bar done', assertion: { type: 'toHaveText', target: { level: 'css', arg: '#progressBar', intent: 'bar' }, text: '100%', timeout: 15000 } },
]);
check('AN. RULE 3 — #id toHaveText with timeout 15000 is ALLOWED', runGate(r3IdLongTimeout).violations.length === 0);

// [data-testid] with assert_freeze — STABLE, must NOT be flagged
const r3DataAttrFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '[data-testid="bar"]', intent: 'bar' }, 'bar'),
]);
check('AO. RULE 3 — [data-testid] with assert_freeze is ALLOWED', runGate(r3DataAttrFreeze).violations.length === 0);

// Single semantic class with assert_freeze — STABLE, must NOT be flagged
const r3SemanticFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '.progress-bar', intent: 'bar' }, 'bar'),
]);
check('AP. RULE 3 — .semantic-class with assert_freeze is ALLOWED', runGate(r3SemanticFreeze).violations.length === 0);

// Role locator with assert_freeze — ALLOWED (role tier, not CSS)
const r3RoleFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'role', arg: { role: 'progressbar', name: '' }, intent: 'bar' }, 'bar'),
]);
check('AQ. RULE 3 — role-tier assert_freeze is always ALLOWED', runGate(r3RoleFreeze).violations.length === 0);

/* ─── RULE 3: fragile selectors ARE rejected on animated elements ─────────── */

// .css-1a2b3c (hashed) with assert_freeze — FRAGILE, must be flagged
const r3HashedFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '.css-1a2b3c', intent: 'bar' }, 'bar'),
]);
const r3HashedFreezeResult = runGate(r3HashedFreeze);
check('AR. RULE 3 — .css-1a2b3c with assert_freeze produces violation', r3HashedFreezeResult.violations.length === 1);
check('AS. RULE 3 — violation has rule === 3', r3HashedFreezeResult.violations[0]?.rule === 3);

// :nth-child with assert_freeze — FRAGILE, must be flagged
const r3PositionalFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: 'li:nth-child(2)', intent: 'item' }, 'item'),
]);
check('AT. RULE 3 — :nth-child with assert_freeze produces violation', runGate(r3PositionalFreeze).violations.length === 1);

// 3-level chain toHaveText with long timeout — FRAGILE, flagged
const r3DeepChainSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'deep', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.a .b .c', intent: 'leaf' }, text: '100%', timeout: 15000 } },
];
check('AU. RULE 3 — 3-level chain with timeout 15000 produces violation', runGate(makeScenario(r3DeepChainSteps)).violations.length === 1);

// 2-level chain toHaveText with long timeout — allowed (not deeper than 2)
const r3TwoLevelSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'two', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.parent .child', intent: 'child' }, text: 'ok', timeout: 15000 } },
];
check('AV. RULE 3 — 2-level chain with timeout 15000 is ALLOWED', runGate(makeScenario(r3TwoLevelSteps)).violations.length === 0);

// Fragile selector WITHOUT evidence of dynamism — NOT flagged (missing corroboration)
const r3FragileStaticSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'static', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.css-abc .child', intent: 'item' }, text: 'ok' } },
];
check('AW. RULE 3 — fragile selector with no dynamic evidence is NOT flagged', runGate(makeScenario(r3FragileStaticSteps)).violations.length === 0);

// Fragile selector with corroboration from another step — flagged
const r3FragileCorrobSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'txt', assertion: { type: 'toHaveText', target: { level: 'css', arg: 'li:nth-child(2)', intent: 'item' }, text: '50%' } },
  freezeCompare({ level: 'css', arg: 'li:nth-child(2)', intent: 'item' }, 'item'),
];
const r3FragileCorrobResult = runGate(makeScenario(r3FragileCorrobSteps));
// assert_freeze at index 3 is fragile (RULE 3) → violation;
// toHaveText at index 2 is corroborated (RULE 3) → violation;
// toHaveText("50%") on same intent as assert_freeze (RULE 4) → violation = 3 total
check('AX. RULE 3+4 — fragile selector + intermediate value: three violations', r3FragileCorrobResult.violations.length === 3);

/* ─── RULE 1 + RULE 3 combined: violations win, no injections ───────────── */

const rCombined = makeScenario([
  NAV,
  { kind: 'wait', ms: 1500 },
  { kind: 'assert', name: 'd', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.css-1a2b3c', intent: 'x' }, text: 'x', timeout: 15000 } },
]);
const rCombinedResult = runGate(rCombined);
check('AY. combined RULE 1 + RULE 3 — both violations present', rCombinedResult.violations.length === 2);
check('AZ. combined — injections empty when violations exist', rCombinedResult.injections.length === 0);

/* ─── edge cases ─────────────────────────────────────────────────────────── */

check('BA. empty scenario — no violations', runGate({ name: 'empty', category: 'happy', steps: [] }).violations.length === 0);
check('BB. navigate-only — no violations or injections', (() => { const r = runGate(makeScenario([NAV])); return r.violations.length === 0 && r.injections.length === 0; })());

// The real progressbar scenario that was blocked: #progressBar with assert_freeze
const progressBarScenario: Scenario = makeScenario([
  NAV,
  CLICK_ROLE,
  { kind: 'assert', name: 'bar reaches 100%', assertion: { type: 'toHaveText', target: { level: 'css', arg: '#progressBar', intent: 'progress bar' }, text: '100%' } },
]);
const progressBarResult = runGate(progressBarScenario);
check('BC. real progressBar scenario (#progressBar toHaveText) — no violations', progressBarResult.violations.length === 0);
check('BD. real progressBar scenario — RULE 2 raises a missing timeout to the floor', progressBarResult.injections.length === 1 && (progressBarScenario.steps[2] as { assertion: { timeout?: number } }).assertion.timeout === 5000);

/* ─── RULE 1 exception: stability_wait ───────────────────────────────────── */

// stability_wait is explicitly tagged and must NOT produce a RULE 1 violation
const r1SwSc = makeScenario([
  NAV, CLICK_ROLE,
  { kind: 'stability_wait', ms: 500 },
  ASSERT_ROLE,
]);
const r1SwResult = runGate(r1SwSc);
check('BE. RULE 1 — stability_wait is NOT a violation', r1SwResult.violations.length === 0);
check('BF. RULE 1 — stability_wait at max 1000ms still allowed', runGate(makeScenario([
  NAV, CLICK_ROLE,
  { kind: 'stability_wait', ms: 1000 },
  ASSERT_ROLE,
])).violations.length === 0);
// A mix of wait (RULE 1) and stability_wait — only wait should be flagged
const r1MixSc = makeScenario([
  NAV,
  { kind: 'wait', ms: 200 },
  { kind: 'stability_wait', ms: 300 },
  ASSERT_ROLE,
]);
const r1MixResult = runGate(r1MixSc);
check('BG. RULE 1 — wait+stability_wait mix: only wait flagged (1 violation)', r1MixResult.violations.length === 1);
check('BH. RULE 1 — flagged step is the wait, not the stability_wait', r1MixResult.violations[0]?.stepIndex === 1);

/* ─── RULE 4: intermediate value on animated element ─────────────────────── */

// assert_freeze on the same intent as toHaveText("50%") → RULE 4 violation
const r4Intent = 'progress bar';
const r4IntermediateSc = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '#bar', intent: r4Intent }, r4Intent),
  { kind: 'assert', name: 'bar at 50%', assertion: { type: 'toHaveText', target: { level: 'css', arg: '#bar', intent: r4Intent }, text: '50%' } },
]);
const r4Result = runGate(r4IntermediateSc);
check('BI. RULE 4 — toHaveText("50%") on animated element is flagged', r4Result.violations.some((v) => v.rule === 4));

// Terminal values (100%, 0%) must NOT be flagged
const r4TerminalSc = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '#bar', intent: r4Intent }, r4Intent),
  { kind: 'assert', name: 'bar at 100%', assertion: { type: 'toHaveText', target: { level: 'css', arg: '#bar', intent: r4Intent }, text: '100%' } },
]);
check('BJ. RULE 4 — toHaveText("100%") is NOT flagged (terminal value)', !runGate(r4TerminalSc).violations.some((v) => v.rule === 4));

// Without assert_freeze corroboration, "50%" text assertion is NOT flagged
const r4NoCorrobSc = makeScenario([
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'bar at 50%', assertion: { type: 'toHaveText', target: { level: 'css', arg: '#bar', intent: r4Intent }, text: '50%' } },
]);
check('BK. RULE 4 — without assert_freeze corroboration, no RULE 4 violation', !runGate(r4NoCorrobSc).violations.some((v) => v.rule === 4));

/* ─── assert_freeze counts as an assertion ────────────────────────────────── */
// After the fix, a scenario with ONLY assert_freeze steps (no plain assert)
// should have no "no assertions" error — verified by assert_freeze NOT being
// blocked by the end_scenario guard. We confirm the gate accepts it.
const afOnlySc = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '#bar', intent: 'bar' }, 'bar'),
]);
const afOnlyResult = runGate(afOnlySc);
check('BL. assert_freeze on stable #id — gate accepts (no violations)', afOnlyResult.violations.length === 0);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: Static validation gate — RULE 1 exception (stability_wait), RULE 2 floor enforcement (5000ms), RULE 4 (intermediate value), assert_freeze counting.');
