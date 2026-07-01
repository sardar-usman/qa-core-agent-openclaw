/**
 * Locks the table-context exception to gate RULE 3 (src/agent/gate.ts).
 *
 * On a table, a positional address ("row 1, column 1") is stable and correct:
 * that cell HAS no role or id of its own because its content changes by design
 * when you sort, and proving the order changed is the whole point of a sort
 * test. So RULE 3 allows positional pseudo-classes and deep table chains for
 * capture / assert_compare when the selector targets a table. The SAME
 * positional selector OUTSIDE a table is still fragile and rejected, and a
 * hashed / auto-generated class is fragile even inside a table.
 *
 * Pure function, zero LLM, zero network.
 */
import { runGate, isFragileCssSelector, isTablePositionalSelector } from '../src/agent/gate.js';
import type { Scenario, SelectorRecord, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const NAV: TraceStep = { kind: 'navigate', url: 'https://the-internet.herokuapp.com/tables' };
const CLICK_SORT: TraceStep = {
  kind: 'click',
  target: { level: 'role', arg: { role: 'columnheader', name: 'Last Name' }, intent: 'last name column header' },
};

function captureCell(arg: string): TraceStep {
  return { kind: 'capture', varName: 'firstCell', source: 'text', target: { level: 'css', arg, intent: 'first row first cell' }, intent: 'first row first cell' };
}
function compareCell(arg: string, relation: 'changed' | 'unchanged'): TraceStep {
  return { kind: 'assert_compare', varName: 'firstCell', relation, source: 'text', target: { level: 'css', arg, intent: 'first row first cell' }, intent: 'first row first cell', readVar: 'firstCellNow' };
}
function scenario(steps: TraceStep[]): Scenario {
  return { name: 'sort changes the row order', category: 'happy', steps: structuredClone(steps) };
}

/* ─── the sort selector from the live run ────────────────────────────────── */
const SORT_SEL = '#table2 tbody tr:nth-of-type(1) td:nth-of-type(1)';

/* ─── isTablePositionalSelector unit checks ──────────────────────────────── */
check('A. table-scoped nth-of-type chain is a table-positional selector', isTablePositionalSelector(SORT_SEL));
check('B. bare td:nth-child is a table-positional selector', isTablePositionalSelector('td:nth-child(1)'));
check('C. tr:first-child is a table-positional selector', isTablePositionalSelector('tr:first-child'));
check('D. role=cell positional is a table-positional selector', isTablePositionalSelector('[role="row"] :nth-child(1)'));
check('E. role=gridcell is a table-positional selector', isTablePositionalSelector('[role="gridcell"]:first-child'));
check('F. a non-table positional selector is NOT table-positional', !isTablePositionalSelector('li:nth-child(2)'));
check('G. a non-table div chain is NOT table-positional', !isTablePositionalSelector('.list .item:nth-child(3)'));
check('H. a hashed class inside a table is NOT exempted (still fragile)', !isTablePositionalSelector('#table2 tbody tr .css-1a2b3c:nth-child(1)'));
check('I. "td" inside a word does not trip the table match', !isTablePositionalSelector('.tddl:nth-child(1)'));

/* the selector is genuinely fragile by the global rule (so the exception matters) */
check('J. the sort selector IS fragile by the global rule', isFragileCssSelector(SORT_SEL));

/* ─── RULE 3a: positional capture/compare INSIDE a table is allowed ──────── */
const tableSort = scenario([NAV, captureCell(SORT_SEL), CLICK_SORT, compareCell(SORT_SEL, 'changed')]);
const tableSortRes = runGate(tableSort);
check('K. sort scenario with table-scoped positional capture+compare is ALLOWED', tableSortRes.violations.length === 0,
  JSON.stringify(tableSortRes.violations));

/* bare td:nth-child positional, no table id scope, still inside a table → allowed */
const bareTable = scenario([NAV, captureCell('td:nth-child(1)'), CLICK_SORT, compareCell('td:nth-child(1)', 'changed')]);
check('L. bare td:nth-child capture+compare is ALLOWED (still a table cell)', runGate(bareTable).violations.length === 0);

/* role-based row/cell positional → allowed */
const roleTable = scenario([NAV, captureCell('[role="row"]:nth-of-type(1) [role="cell"]:nth-of-type(1)'), CLICK_SORT, compareCell('[role="row"]:nth-of-type(1) [role="cell"]:nth-of-type(1)', 'changed')]);
check('M. role=row/cell positional capture+compare is ALLOWED', runGate(roleTable).violations.length === 0);

/* ─── the same positional selector OUTSIDE a table is still rejected ─────── */
const listSel = 'ul.results li:nth-of-type(1) span:nth-of-type(1)';
const listSort = scenario([NAV, captureCell(listSel), CLICK_SORT, compareCell(listSel, 'changed')]);
const listRes = runGate(listSort);
check('N. the same positional shape OUTSIDE a table is REJECTED', listRes.violations.length > 0, JSON.stringify(listRes.violations));
check('O. the out-of-table rejection is a RULE 3 violation', listRes.violations.every((v) => v.rule === 3));

/* a hashed class inside a table is still rejected (fragile beyond position) */
const hashedSel = '#table2 tbody .css-9f2k1a:nth-child(1)';
const hashedTable = scenario([NAV, captureCell(hashedSel), CLICK_SORT, compareCell(hashedSel, 'changed')]);
check('P. a hashed class inside a table is STILL rejected', runGate(hashedTable).violations.length > 0);

/* a plain li:nth-child outside any table is rejected (regression guard for existing RULE 3) */
const liSel = 'li:nth-child(2)';
const liScn = scenario([NAV, captureCell(liSel), CLICK_SORT, compareCell(liSel, 'unchanged')]);
check('Q. plain li:nth-child capture/compare outside a table is REJECTED', runGate(liScn).violations.length > 0);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: gate RULE 3 allows positional selectors inside a table for capture/compare, still rejects them outside a table and rejects hashed classes anywhere.');
