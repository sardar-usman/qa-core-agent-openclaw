/**
 * Locks in key resolver (selectors.ts) invariants — pure function tests,
 * zero browser, zero LLM.
 *
 * Covers:
 *   - emitLocatorCall for all cascade levels including new text/alt/title/xpath
 *   - Nameless role arg emits page.getByRole(role) without name
 *   - Named role arg emits page.getByRole(role, { name })
 *   - CascadeLevel type includes new tiers
 */
import { emitLocatorCall, stripGenericSuffixes } from '../src/agent/selectors.js';
import type { CascadeLevel } from '../src/agent/selectors.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── emitLocatorCall: existing tiers ───────────────────────────────────── */

check(
  'A. role with name emits getByRole + opts',
  emitLocatorCall('role', { role: 'button', name: 'Submit', exact: true }) ===
    'page.getByRole("button", {"name":"Submit","exact":true})',
);

check(
  'B. role without name emits getByRole(role) only',
  emitLocatorCall('role', { role: 'progressbar' }) === 'page.getByRole("progressbar")',
);

check(
  'C. role without name does NOT include name key in output',
  !emitLocatorCall('role', { role: 'progressbar' }).includes('name'),
);

check(
  'D. label emits getByLabel',
  emitLocatorCall('label', 'Email') === 'page.getByLabel("Email")',
);

check(
  'E. placeholder emits getByPlaceholder',
  emitLocatorCall('placeholder', 'Enter email') === 'page.getByPlaceholder("Enter email")',
);

check(
  'F. testid emits getByTestId',
  emitLocatorCall('testid', 'submit-btn') === 'page.getByTestId("submit-btn")',
);

check(
  'G. css emits page.locator',
  emitLocatorCall('css', '#foo') === 'page.locator("#foo")',
);

/* ─── emitLocatorCall: new tiers ─────────────────────────────────────────── */

check(
  'H. text emits getByText',
  emitLocatorCall('text', 'Login successful') === 'page.getByText("Login successful")',
);

check(
  'I. alt emits getByAltText',
  emitLocatorCall('alt', 'Company logo') === 'page.getByAltText("Company logo")',
);

check(
  'J. title emits getByTitle',
  emitLocatorCall('title', 'Close dialog') === 'page.getByTitle("Close dialog")',
);

check(
  'K. xpath emits page.locator with xpath= prefix',
  emitLocatorCall('xpath', '//button[@data-action="submit"]') ===
    'page.locator("xpath=//button[@data-action=\\"submit\\"]")',
);

/* ─── emitLocatorCall: ambiguous flag appends .first() ───────────────────── */

check(
  'L. ambiguous role appends .first()',
  emitLocatorCall('role', { role: 'button', name: 'OK' }, true).endsWith('.first()'),
);

check(
  'M. ambiguous nameless role appends .first()',
  emitLocatorCall('role', { role: 'progressbar' }, true) === 'page.getByRole("progressbar").first()',
);

check(
  'N. ambiguous text appends .first()',
  emitLocatorCall('text', 'Error', true) === 'page.getByText("Error").first()',
);

/* ─── CascadeLevel type covers all tiers ─────────────────────────────────── */
// If this compiles, all new levels are in the type.
const allLevels: CascadeLevel[] = ['role', 'label', 'placeholder', 'text', 'alt', 'title', 'testid', 'css', 'xpath'];
check('O. all 9 cascade levels are in the type', allLevels.length === 9);

/* ─── stripGenericSuffixes ───────────────────────────────────────────────── */

check('P. "password input" strips to "password"', stripGenericSuffixes('password input') === 'password');
check('Q. "submit button" strips to "submit"', stripGenericSuffixes('submit button') === 'submit');
check('R. "search" (single word) returns null', stripGenericSuffixes('search') === null);
check('S. "input" (all generic) returns null', stripGenericSuffixes('input') === null);

/* ─── nameless role arg structure ────────────────────────────────────────── */
// Ensure that a nameless arg object (only role, no name property) correctly
// emits the nameless form and NOT a form with name: undefined or name: ""
const namelessOut = emitLocatorCall('role', { role: 'progressbar' });
check('T. nameless role output has no undefined', !namelessOut.includes('undefined'));
check('U. nameless role output has no empty string name', !namelessOut.includes('""'));
check('V. nameless role matches expected form', namelessOut === 'page.getByRole("progressbar")');

/* ─── named role with only role+name (no exact) ─────────────────────────── */
const namedNoExact = emitLocatorCall('role', { role: 'button', name: 'Log in' });
check('W. named role without exact emits correct form', namedNoExact === 'page.getByRole("button", {"name":"Log in"})');

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: Resolver cascade level expansion and emitLocatorCall all correct.');
