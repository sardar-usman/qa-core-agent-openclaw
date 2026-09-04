/**
 * Locks in-run selector recovery (CLAUDE.md invariant 24).
 *
 * Recovery is NOT the healer (that is the qa-core-heal package): it repairs a
 * selector that fails to resolve DURING exploration by re-resolving against
 * the live page by semantic intent alone, dropping the stale hint that
 * suppressed the match. Locks:
 *   - A selector whose stale hints fail to resolve is recovered to the RIGHT
 *     element and the action completes.
 *   - The recovery is recorded on ctx.heals (the entry that feeds
 *     RunReport.heals and the dashboard's 'heal' event) with the from/to/
 *     intent/scenario shape.
 *   - A selector that resolves normally records NO recovery.
 *   - A failed ASSERTION is never recovered: the element resolved, the value
 *     was wrong, so it runs through the retry cap and becomes a finding with
 *     ctx.heals untouched.
 *   - A selector that cannot be recovered becomes a finding after
 *     RECOVERY_CAP failures and blocks further actions, never a silent pass.
 *
 * Drives the real tools against a local fixture. No network. No LLM.
 */
import { chromium } from 'playwright';
import { createContext, runTool, type ToolContext } from '../src/agent/tools.js';
import { recoverResolve } from '../src/agent/selector-recovery.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const browser = await chromium.launch();
const context = await browser.newContext();
await installEvalShim(context);
const page = await context.newPage();
const ctx: ToolContext = createContext(page, 80);

// The button's accessible name is "Place order". The model will ask for it
// with a STALE label hint ("Confirm purchase") and a dead css id: the normal
// resolve fails on every level, recovery re-finds it by intent alone.
const html = `
<!doctype html><html><body>
  <h1>Checkout</h1>
  <label for="email">Email</label>
  <input id="email" type="text" value="pre@example.com" />
  <label for="coupon">Coupon</label>
  <input id="coupon" type="text" value="SAVE10" />
  <button type="button" onclick="document.getElementById('status').textContent='ordered'">Place order</button>
  <div id="status"></div>
</body></html>`;
await page.setContent(html, { waitUntil: 'load' });

/* ─── A. recoverResolve drops the stale hint and re-finds by intent ─────────── */
const direct = await recoverResolve(page, { intent: 'place order control', label: 'Confirm purchase', css: '#old-place-order' });
check('A1. recoverResolve finds the element by intent alone', direct !== null);
check('A2. recovered locator is the real button', direct !== null && (await direct.locator.textContent()) === 'Place order');

/* ─── B. an action locator with stale hints is recovered and recorded ───────── */
await runTool(ctx, { name: 'begin_scenario', input: { name: 'placed an order', category: 'happy', feature: 'checkout' } });
const clicked = await runTool(ctx, { name: 'click', input: { intent: 'place order control', label: 'Confirm purchase', css: '#old-place-order' } });
check('B1. the click succeeds via recovery', clicked.ok === true, JSON.stringify(clicked));
check('B2. the RIGHT element was clicked (page reacted)', (await page.locator('#status').textContent()) === 'ordered');
check('B3. exactly one recovery recorded on ctx.heals', ctx.heals.length === 1, JSON.stringify(ctx.heals));
const heal = ctx.heals[0];
check('B4. entry carries the RunReport.heals shape (scenario/intent/from/to)',
  heal !== undefined && heal.scenario === 'placed an order' && heal.intent === 'place order control'
  && typeof heal.from === 'string' && typeof heal.to === 'string' && heal.from !== heal.to,
  JSON.stringify(heal));
check('B5. `from` names the stale hints, `to` the recovered locator',
  heal !== undefined && /Confirm purchase|old-place-order/.test(heal.from) && /Place order/i.test(heal.to),
  JSON.stringify(heal));
check('B6. no finding was recorded (recovery is not a failure)', ctx.findings.length === 0);

/* ─── C. a selector that resolves normally records NO recovery ──────────────── */
const normal = await runTool(ctx, { name: 'fill', input: { intent: 'email input', label: 'Email', value: 'buyer@example.com' } });
check('C1. a resolvable selector works first try', normal.ok === true, JSON.stringify(normal));
check('C2. no extra recovery recorded', ctx.heals.length === 1);

/* ─── D. a failed ASSERTION is never recovered ──────────────────────────────
 *        The coupon field RESOLVES fine and was never filled in this
 *        scenario, so the assertion keeps the model's wrong value and fails.
 *        That failure runs through the assertion retry cap (finding on the
 *        2nd failure) and must never add a recovery entry. ────────────────── */
const healsBefore = ctx.heals.length;
const wrong1 = await runTool(ctx, { name: 'assert', input: { type: 'toHaveValue', intent: 'coupon input', label: 'Coupon', value: 'WRONG99', timeout: 600 } });
check('D1. first assertion failure is an honest retry', wrong1.ok === false && ctx.findings.length === 0);
const wrong2 = await runTool(ctx, { name: 'assert', input: { type: 'toHaveValue', intent: 'coupon input', label: 'Coupon', value: 'WRONG99', timeout: 600 } });
check('D2. second failure of the same assertion becomes a finding', wrong2.ok === false && ctx.findings.length === 1, JSON.stringify(ctx.findings));
check('D3. NO recovery was attempted or recorded for the failed assertion', ctx.heals.length === healsBefore, JSON.stringify(ctx.heals));
check('D4. the finding is an assertion finding, not a locator finding', ctx.findings[0] !== undefined && !/could not be resolved or recovered/.test(ctx.findings[0].messages.join(' ')));

/* ─── E. a selector that cannot be recovered becomes a finding after the cap ── */
await page.setContent(html, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'clicked a control that is not there', category: 'edge', feature: 'checkout' } });
const findingsBeforeE = ctx.findings.length;
const gone1 = await runTool(ctx, { name: 'click', input: { intent: 'frobnicate gizmo control', label: 'Frobnicate' } });
check('E1. first unrecoverable failure returns ok:false (honest retry)', gone1.ok === false && ctx.findings.length === findingsBeforeE);
const gone2 = await runTool(ctx, { name: 'click', input: { intent: 'frobnicate gizmo control', label: 'Frobnicate' } });
check('E2. the RECOVERY_CAP-th failure records a locator finding', gone2.ok === false && ctx.findings.length === findingsBeforeE + 1, JSON.stringify(ctx.findings.slice(-1)));
check('E3. the finding says the selector could not be resolved or recovered',
  ctx.findings[ctx.findings.length - 1]!.messages.some((m) => /could not be resolved or recovered/.test(m)),
  JSON.stringify(ctx.findings.slice(-1)));
check('E4. the half-built scenario was dropped and actions are blocked', ctx.current === null && ctx._blockUntilNewScenario === true);
check('E5. still no recovery entry from the unrecoverable selector', ctx.heals.length === healsBefore);

await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: in-run selector recovery repairs stale action locators, records each recovery for the report, never touches failed assertions, and caps into a finding.');
