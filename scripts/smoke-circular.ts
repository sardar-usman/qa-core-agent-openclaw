/**
 * Locks the plan-time rejection of circular unchanged-assertions
 * (rejectCircular / circularUnchangedReason in src/agent/planner.ts).
 *
 * A scenario that captures a value, reloads the page or does nothing, then
 * asserts the value is unchanged compares the value to itself: it can never
 * fail, so it catches no regression. It must be rejected at plan time.
 *
 * An "unchanged" assertion is valid only when something happened that could
 * plausibly have changed the value (a stopped progress bar, a locked field, a
 * row pinned against a re-sort) or a real state-changing action other than a
 * reload. Pure function, zero LLM, zero network.
 */
import { rejectCircular, circularUnchangedReason, vacuousAbsenceReason } from '../src/agent/planner.js';
import type { PlannedScenario } from '../src/agent/planner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const scn = (name: string, category: PlannedScenario['category'] = 'edge'): PlannedScenario => ({
  name, category, rationale: 'fails if the behavior breaks', feature: 'tables',
});

/* ─── circular: rejected ─────────────────────────────────────────────────── */
check('A. capture + reload + unchanged on a static value is circular',
  circularUnchangedReason(scn('captured the first cell value, reloaded the page, the value is unchanged')) !== null);
check('B. "equals itself" phrasing is circular',
  circularUnchangedReason(scn('captured the first row id, reloaded, the value equals itself')) !== null);
check('C. capture + no action + unchanged is circular',
  circularUnchangedReason(scn('captured the cell text and the value stayed the same')) !== null);
check('D. refresh + unchanged on a count is circular',
  circularUnchangedReason(scn('captured the row count, refreshed the page, the count is unchanged')) !== null);
check('E. "same value" after revisit is circular',
  circularUnchangedReason(scn('captured the price, revisited the page, the price holds the same value')) !== null);

/* ─── valid unchanged: accepted ──────────────────────────────────────────── */
check('F. stopped progress bar holding its value is NOT circular',
  circularUnchangedReason(scn('captured the progress bar value after it stopped, the value held unchanged')) === null);
check('G. locked field staying put is NOT circular',
  circularUnchangedReason(scn('captured the locked field value, tried to edit it, the value is unchanged')) === null);
check('H. row pinned against a re-sort is NOT circular',
  circularUnchangedReason(scn('captured the pinned row position, sorted the table, the position is unchanged')) === null);
check('I. animation settling to a held value is NOT circular',
  circularUnchangedReason(scn('captured the counter value while the animation ran, the value remained steady')) === null);

/* ─── fill-and-verify: a fill SETS the value, so it is a real action ──────── */
// The exact ui.vision frame scenario that was wrongly rejected.
check('S. filled an input then asserted the value persisted is NOT circular',
  circularUnchangedReason(scn('filled text input in first iframe and value persisted')) === null);
check('S2. fill-then-assert-value-present is NOT circular',
  circularUnchangedReason(scn('filled the name field and the field value is unchanged from what was typed')) === null);
check('T. populated a field then asserted it holds the value is NOT circular',
  circularUnchangedReason(scn('populated the search box and the value stayed the same')) === null);
check('U. selected an option then asserted the value holds is NOT circular',
  circularUnchangedReason(scn('selected a country and the selected value is unchanged')) === null);
check('V. checked a box then asserted the checked value holds is NOT circular',
  circularUnchangedReason(scn('checked the terms box and the checkbox value is unchanged')) === null);

/* ─── not a circular shape at all ────────────────────────────────────────── */
check('J. a "changed" assertion is never circular (the sort test)',
  circularUnchangedReason(scn('captured the first cell value, sorted the table, the order changed')) === null);
check('K. a scenario with no captured value noun is not flagged',
  circularUnchangedReason(scn('logged in and stayed on the dashboard', 'happy')) === null);
check('L. a negative scenario asserting an error is not flagged',
  circularUnchangedReason(scn('rejected an empty form and showed a validation error', 'negative')) === null);
check('M. a click that mutates then asserts unchanged is not flagged (real action)',
  circularUnchangedReason(scn('captured the badge count, clicked add to cart, then the count value')) === null);

/* ─── rejectCircular keeps order and reports reasons ─────────────────────── */
const plan: PlannedScenario[] = [
  scn('captured the first cell value, reloaded, the value is unchanged'),     // circular → rejected
  scn('captured the first cell value, sorted the table, the order changed'),   // valid → kept
  scn('captured the progress bar value after it stopped, the value held unchanged'), // valid → kept
];
const { kept, rejected } = rejectCircular(plan);
check('N. rejectCircular drops exactly the one circular scenario', rejected.length === 1 && kept.length === 2);
check('O. the rejected entry is the reload-unchanged scenario', rejected[0]?.scenario.name.includes('reloaded') === true);
check('P. the rejected entry carries a reason', !!rejected[0]?.reason && rejected[0].reason.length > 0);
check('Q. kept preserves plan order (sort first, then progress)',
  kept[0]?.name.includes('sorted') === true && kept[1]?.name.includes('progress') === true);
check('R. a plan with no circular scenarios keeps everything',
  rejectCircular([scn('captured the id, clicked regenerate, the id changed')]).rejected.length === 0);

/* ─── fill-and-verify survives, reload-unchanged still rejected, together ─── */
const mixed: PlannedScenario[] = [
  scn('filled text input in first iframe and value persisted'),            // fill action → kept
  scn('captured the first cell value, reloaded, the value is unchanged'),  // reload no-op → rejected
];
const mixedResult = rejectCircular(mixed);
check('W. a fill-and-verify scenario is accepted while a reload-unchanged one is rejected',
  mixedResult.kept.length === 1
  && mixedResult.kept[0]?.name.includes('filled') === true
  && mixedResult.rejected.length === 1
  && mixedResult.rejected[0]?.scenario.name.includes('reloaded') === true);

/* ─── vacuous absence: asserting a fake identifier is absent ──────────────── */
// The ui.vision negative scenario: assert a made-up frame name is not present.
// It was never there, so the assertion can never fail. Reject it at plan time.
check('AA. asserting a nonexistent fake frame is absent is vacuous',
  vacuousAbsenceReason(scn('verify the nonexistent-frame-xyz frame does not exist')) !== null);
check('BB. "fake-id element is not present" is vacuous',
  vacuousAbsenceReason(scn('check that a fake-id element is not present on the page')) !== null);
check('CC. "a bogus selector finds nothing" is vacuous',
  vacuousAbsenceReason(scn('assert a bogus selector frame is absent', 'negative')) !== null);
check('DD. a made-up name asserted gone is vacuous',
  vacuousAbsenceReason(scn('the made-up xyz panel is no longer present')) !== null);
// A REAL absence test (something existed and an action removed/hid it) is valid.
check('EE. removing a real row then asserting it is gone is NOT vacuous',
  vacuousAbsenceReason(scn('deleted the first cart item and the row is no longer present', 'happy')) === null);
check('FF. filtering out a real item then asserting absence is NOT vacuous',
  vacuousAbsenceReason(scn('filtered by out-of-stock and the matching product is absent', 'happy')) === null);
check('GG. a non-absence scenario is never flagged vacuous',
  vacuousAbsenceReason(scn('captured the id, clicked regenerate, the id changed')) === null);
check('HH. a real frame interaction is not flagged vacuous',
  vacuousAbsenceReason(scn('filled the text input inside frame 2 and the value persisted')) === null);
// rejectCircular folds the vacuous-absence rule in alongside circular.
const withVacuous: PlannedScenario[] = [
  scn('filled the text input inside frame 2 and the value persisted'),   // valid → kept
  scn('verify the nonexistent-frame-xyz frame does not exist'),          // vacuous → rejected
];
const vacResult = rejectCircular(withVacuous);
check('II. rejectCircular drops the vacuous-absence scenario and keeps the real one',
  vacResult.kept.length === 1
  && vacResult.kept[0]?.name.includes('filled') === true
  && vacResult.rejected.length === 1
  && vacResult.rejected[0]?.scenario.name.includes('nonexistent') === true);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: circular unchanged-assertions and vacuous absence-of-a-fake-identifier scenarios are rejected at plan time; valid held-value and real-absence scenarios survive.');
