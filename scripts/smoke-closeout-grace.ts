/**
 * Locks the close-out grace on the step-budget guard (tools.ts).
 *
 * The bug this prevents: a 12-field registration form spends 12 steps on fills
 * alone, so on a 3-scenario plan the last full-form scenario can reach the budget
 * line exactly at its closing assertion. Without grace, all that fill work is
 * thrown away for want of one or two cheap steps and the scenario never ships.
 *
 * The fix: a scenario already in progress may run a few steps PAST the budget,
 * but ONLY to close itself out (assert / capture / assert_compare / end_scenario).
 * Action tools and begin_scenario stay blocked over budget, so the grace can
 * never start a new scenario or re-fill a form. Beyond the small grace window,
 * even closing calls are blocked and only finish() runs.
 *
 * This drives the real tools against a headless page and checks each boundary.
 */
import { chromium } from 'playwright';
import { createContext, runTool, type ToolContext } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};
const budgetRejected = (r: { ok: boolean; error?: string }): boolean =>
  r.ok === false && /Step budget exceeded/.test(r.error ?? '');

const browser = await chromium.launch();
const context = await browser.newContext();
await installEvalShim(context);
const page = await context.newPage();
await page.setContent(`
<!doctype html><html><body>
  <h1>Register</h1>
  <form onsubmit="return false">
    <label for="email">Email</label>
    <input id="email" type="email" />
    <button id="submit" type="submit">Register</button>
  </form>
</body></html>`, { waitUntil: 'load' });

const MAX = 10;
const GRACE = 4; // mirrors CLOSEOUT_GRACE in tools.ts
const ctx: ToolContext = createContext(page, MAX);

// Start a scenario while well under budget — it is the "in progress" scenario the
// grace protects.
await runTool(ctx, { name: 'begin_scenario', input: { name: 'filled the long form then asserts the outcome', category: 'happy', feature: 'register' } });

/* ─── A. over budget, non-closing calls are rejected ────────────────────────── */
ctx.steps = MAX; // at the budget line; the next tool tick pushes over
const overFill = await runTool(ctx, { name: 'fill', input: { intent: 'email input', value: 'a@b.com', css: '#email' } });
check('A1. fill is rejected over budget', budgetRejected(overFill), overFill.error);
check('A2. the email field was NOT filled (no page action ran)', (await page.locator('#email').inputValue()) === '');
ctx.steps = MAX;
const overBegin = await runTool(ctx, { name: 'begin_scenario', input: { name: 'a brand new scenario', category: 'edge', feature: 'register' } });
check('A3. begin_scenario is rejected over budget (grace never starts new work)', budgetRejected(overBegin), overBegin.error);
check('A4. no new scenario was started', !ctx.scenarios.some((s) => s.name === 'a brand new scenario') && ctx.current?.name === 'filled the long form then asserts the outcome');

/* ─── B. closing calls within grace ARE allowed for the in-progress scenario ── */
ctx.steps = MAX; // tick → MAX+1, inside MAX+GRACE
const graceAssert = await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'register heading', role: 'heading', label: 'Register' } });
check('B1. a closing assert within grace RUNS (work is salvaged, not budget-rejected)', graceAssert.ok === true, JSON.stringify(graceAssert));
ctx.steps = MAX;
const graceCapture = await runTool(ctx, { name: 'capture', input: { name: 'heading', source: 'text', intent: 'register heading', css: 'h1' } });
check('B2. a closing capture within grace runs', graceCapture.ok === true && !budgetRejected(graceCapture), JSON.stringify(graceCapture));
ctx.steps = MAX;
const graceEnd = await runTool(ctx, { name: 'end_scenario', input: {} });
check('B3. end_scenario within grace runs and is not budget-rejected', graceEnd.ok === true && !budgetRejected(graceEnd), JSON.stringify(graceEnd));
check('B4. the salvaged scenario actually shipped', ctx.scenarios.some((s) => s.name === 'filled the long form then asserts the outcome'));

/* ─── C. beyond the grace window, even closing calls are blocked ────────────── */
ctx.steps = 1; // back under budget to legitimately start a fresh in-progress scenario
await runTool(ctx, { name: 'begin_scenario', input: { name: 'reaches its assert far past the grace', category: 'happy', feature: 'register' } });
ctx.steps = MAX + GRACE; // tick → MAX+GRACE+1, past the grace window
const beyondAssert = await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'register heading', role: 'heading', label: 'Register' } });
check('C1. a closing assert PAST the grace window is rejected', budgetRejected(beyondAssert), beyondAssert.error);

/* ─── D. finish() is always allowed, no matter how far over budget ──────────── */
ctx.steps = MAX + 50;
const fin = await runTool(ctx, { name: 'finish', input: { summary: 'done' } });
check('D1. finish() runs regardless of the budget', fin.ok === true, JSON.stringify(fin));

await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: close-out grace — an in-progress scenario may assert and end a few steps past the budget so its fill work ships, while new scenarios and re-fills stay blocked.');
