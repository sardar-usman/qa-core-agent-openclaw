/**
 * Locks the adaptive Explorer step budget (stepBudgetFor in runtime.ts) — pure
 * function, zero browser, zero LLM.
 *
 * The contract:
 *   - the budget scales with the plan size, so a small plan on a trivial page
 *     cannot run dry on one gate retry (a full begin..end cycle, ~7 calls)
 *   - it ALSO scales with form complexity: a scenario that fills a 12-field form
 *     needs ~12 steps just for the fills, which the scenario-count-only budget
 *     could not cover. The fill term adds one step per fillable field PAST the
 *     base, so a light page is untouched and a long form gets room for the fills.
 *   - a light / 1-action page does not balloon (form term stays at the base)
 *   - it never regresses below the historical floor of 40
 *   - it is monotonic non-decreasing in both the plan size and the field count
 *   - a 3-scenario plan gets enough room for all three plus one retry
 *     (the case that previously abandoned scenario 3 at the hidden 30-turn cap)
 */
import { stepBudgetFor } from '../src/agent/runtime.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── floor ──────────────────────────────────────────────────────────────── */
check('A. never below the floor of 40', stepBudgetFor(0) === 40 && stepBudgetFor(1) === 40 && stepBudgetFor(2) === 40);
check('B. a 0 / negative plan still floors to 40 (treated as 1)', stepBudgetFor(0) === 40 && stepBudgetFor(-5) === 40);

/* ─── scales with the plan ───────────────────────────────────────────────── */
// 6 orientation + 14 per scenario.
check('C. 3 scenarios → 48 (6 + 14×3), above the old fixed 40', stepBudgetFor(3) === 48);
check('D. 5 scenarios → 76', stepBudgetFor(5) === 76);
check('E. 10 scenarios → 146', stepBudgetFor(10) === 146);

/* ─── the regression this fixes ──────────────────────────────────────────── */
// The last progressbar run did 30 tool calls: 23 of real work + 7 wasted on one
// gate retry. A 3-scenario budget must clear that with margin to spare.
const REAL_WORK_3 = 23;
const ONE_RETRY = 7;
check('F. 3-scenario budget covers real work + one full retry with headroom',
  stepBudgetFor(3) >= REAL_WORK_3 + ONE_RETRY,
  `budget ${stepBudgetFor(3)} vs needed ${REAL_WORK_3 + ONE_RETRY}`);

/* ─── form-aware: a long form gets more steps per scenario ───────────────────
 * A 1-action page must NOT balloon: a 1-2 field page keeps the scenario-count
 * budget. A 12-field form gets one extra step per field past the base, so three
 * register scenarios (~36 fills) finally fit. The default field count is 0, so
 * every check above (which omits it) is the light-page case and stays correct. */
check('I. a 1-action page does not balloon (1 field === no field info)',
  stepBudgetFor(3, 1) === stepBudgetFor(3, 0) && stepBudgetFor(3, 1) === 48, `${stepBudgetFor(3, 1)}`);
check('J. a 2-field page still floors to 40 on a 2-scenario plan', stepBudgetFor(2, 2) === 40);
check('K. the form term only engages past the base (~6 fields)',
  stepBudgetFor(3, 6) === 48 && stepBudgetFor(3, 7) === 51, `${stepBudgetFor(3, 6)} / ${stepBudgetFor(3, 7)}`);
check('L. a 3-scenario 12-field form (register) → 66 (6 + 3×(8+12)), up from 48',
  stepBudgetFor(3, 12) === 66, `${stepBudgetFor(3, 12)}`);
// 66 must cover three full 12-field scenarios. A full register scenario in a
// live run was ~19 steps (12 fills + begin/navigate/click/get_dom/asserts/end).
const FULL_FORM_SCENARIO = 19;
check('M. the register budget covers three full-form scenarios with headroom',
  stepBudgetFor(3, 12) >= FULL_FORM_SCENARIO * 3, `budget ${stepBudgetFor(3, 12)} vs needed ${FULL_FORM_SCENARIO * 3}`);
check('N. the fill term is capped so a mega-form cannot run away (100 fields === 24)',
  stepBudgetFor(2, 100) === stepBudgetFor(2, 24) && stepBudgetFor(2, 100) === 70, `${stepBudgetFor(2, 100)}`);

/* ─── monotonic ──────────────────────────────────────────────────────────── */
let monotonic = true;
let prev = -1;
for (let n = 0; n <= 50; n++) {
  const b = stepBudgetFor(n);
  if (b < prev) { monotonic = false; break; }
  prev = b;
}
check('G. stepBudgetFor is monotonic non-decreasing in the plan size', monotonic);
let monotonicF = true;
prev = -1;
for (let f = 0; f <= 60; f++) {
  const b = stepBudgetFor(3, f);
  if (b < prev) { monotonicF = false; break; }
  prev = b;
}
check('G2. stepBudgetFor is monotonic non-decreasing in the field count', monotonicF);

/* ─── integer ────────────────────────────────────────────────────────────── */
check('H. always an integer', Number.isInteger(stepBudgetFor(3)) && Number.isInteger(stepBudgetFor(7, 12)));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the Explorer step budget scales with the plan AND form complexity, never drops below 40, and a light page does not balloon.');
