/**
 * Locks the outcome-assertion retry cap and the finding it produces (tools.ts).
 *
 * The bug this prevents: a happy-path scenario asserts a success signal that was
 * assumed, not verified (e.g. "land on /auth/login"). The page never redirects,
 * so the Explorer re-fills the whole form and re-submits over and over until the
 * step budget is gone, starving every later scenario and inflating cost.
 *
 * The fix: after OUTCOME_RETRY_CAP failures of the SAME assertion, stop. Capture
 * what the page actually did (URL + visible messages), record a finding, drop the
 * half-built scenario, and block further actions until the next begin_scenario.
 * A wrong success signal fails loudly with the real page state instead of
 * thrashing.
 *
 * This drives a real (headless) page through the actual tools and checks the
 * counter, the cap trip, the captured state, the block, and the per-signature
 * independence of the counter.
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

const browser = await chromium.launch();
const context = await browser.newContext();
await installEvalShim(context);
const page = await context.newPage();
const ctx: ToolContext = createContext(page, 80);

// A form that never navigates on submit and shows a visible failure alert. The
// happy-path success signal the plan would assume ("/success") never appears.
const formHtml = `
<!doctype html><html><body>
  <h1>Register</h1>
  <div class="alert" role="alert">Registration failed: email already in use</div>
  <form onsubmit="return false">
    <label for="email">Email</label>
    <input id="email" type="email" />
    <button id="submit" type="submit">Register</button>
  </form>
</body></html>`;
await page.setContent(formHtml, { waitUntil: 'load' });

/* ─── A. first failure of an assertion is an honest retry, not a finding ────── */
await runTool(ctx, { name: 'begin_scenario', input: { name: 'registered and landed on success', category: 'happy', feature: 'register' } });
const fail1 = await runTool(ctx, { name: 'assert', input: { type: 'toHaveURL', pattern: '/success', timeout: 800 } });
check('A1. first failure returns ok:false (retry allowed)', fail1.ok === false);
check('A2. first failure is NOT yet a finding', (fail1.data as { finding?: boolean } | undefined)?.finding !== true);
check('A3. no finding recorded after one failure', ctx.findings.length === 0);
check('A4. scenario still in progress, not blocked', ctx.current !== null && ctx._blockUntilNewScenario === false);

/* ─── B. second failure of the SAME assertion trips the cap → a finding ─────── */
const fail2 = await runTool(ctx, { name: 'assert', input: { type: 'toHaveURL', pattern: '/success', timeout: 800 } });
check('B1. second failure returns ok:false', fail2.ok === false);
check('B2. second failure is flagged as a finding', (fail2.data as { finding?: boolean }).finding === true);
check('B3. directive tells the model to stop and begin_scenario', /Do NOT retry|begin_scenario/.test(fail2.error ?? ''));
check('B4. exactly one finding recorded', ctx.findings.length === 1, JSON.stringify(ctx.findings));
const finding = ctx.findings[0]!;
check('B5. finding names the scenario', finding.scenario === 'registered and landed on success');
check('B6. finding records what was expected (the assumed success URL)', /success/.test(finding.expected));
check('B7. finding captured the visible failure message', finding.messages.some((m) => /already in use/.test(m)), JSON.stringify(finding.messages));
check('B8. scenario was dropped (not shipped green) and is now null', ctx.current === null);
check('B9. further actions are blocked until the next scenario', ctx._blockUntilNewScenario === true);
check('B10. the finding scenario was NOT pushed to ctx.scenarios', !ctx.scenarios.some((s) => s.name === 'registered and landed on success'));

/* ─── C. while blocked, action tools are rejected cheaply (no re-fill) ──────── */
const blockedFill = await runTool(ctx, { name: 'fill', input: { intent: 'email input', value: 'someone@example.com', testid: 'email' } });
check('C1. fill is rejected while blocked', blockedFill.ok === false);
check('C2. block message points at begin_scenario / finish', /begin_scenario|finish/.test(blockedFill.error ?? ''));
check('C3. the email field was NOT filled (no page action ran)', (await page.locator('#email').inputValue()) === '');
const blockedAssert = await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'register button', css: '#submit' } });
check('C4. assert is rejected while blocked', blockedAssert.ok === false);

/* ─── D. begin_scenario lifts the block but does NOT wipe the failure counts ──
 *        The counts persist across a restart on purpose: a restart of the SAME
 *        failing outcome must keep accumulating toward the cap, not reset to 0.
 *        Counts are cleared only when an assertion PASSES (section D4 below). ── */
await page.setContent(formHtml, { waitUntil: 'load' });
const trippedSig = ctx._assertFailures.size; // the /success signature is still tracked
const begin2 = await runTool(ctx, { name: 'begin_scenario', input: { name: 'rejected duplicate email shows error', category: 'negative', feature: 'register' } });
check('D1. begin_scenario succeeds after a finding', begin2.ok === true);
check('D2. block is lifted', ctx._blockUntilNewScenario === false);
check('D3. failure counts are NOT wiped by begin_scenario (they survive restarts)', ctx._assertFailures.size === trippedSig && trippedSig >= 1);
// The negative scenario asserts the real visible failure state — this passes.
const realAssert = await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'failure alert', role: 'alert' } });
check('D4. a real, observable assertion still passes normally', realAssert.ok === true, JSON.stringify(realAssert));
await runTool(ctx, { name: 'end_scenario', input: {} });
check('D5. the well-formed negative scenario ships', ctx.scenarios.some((s) => s.name === 'rejected duplicate email shows error'));

/* ─── F. the cap survives a scenario RESTART: the same assertion failing once,
 *        then once more after a begin_scenario, trips the cap on the 2nd failure.
 *        This is the real-world case the live run hit — a gate-forced restart
 *        used to reset the counter so the cap never fired. ─────────────────── */
await page.setContent(formHtml, { waitUntil: 'load' });
const findingsBeforeF = ctx.findings.length;
await runTool(ctx, { name: 'begin_scenario', input: { name: 'lands on a page that never loads', category: 'happy', feature: 'register' } });
const restartFail1 = await runTool(ctx, { name: 'assert', input: { type: 'toHaveURL', pattern: '/never-here', timeout: 600 } });
check('F1. first failure of a fresh signature is an honest retry', restartFail1.ok === false && (restartFail1.data as { finding?: boolean } | undefined)?.finding !== true);
check('F2. one failure, no finding yet', ctx.findings.length === findingsBeforeF);
// Simulate a restart (the model re-issues begin_scenario after a gate reject).
await page.setContent(formHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'lands on a page that never loads', category: 'happy', feature: 'register' } });
const restartFail2 = await runTool(ctx, { name: 'assert', input: { type: 'toHaveURL', pattern: '/never-here', timeout: 600 } });
check('F3. the SAME assertion failing again AFTER a restart trips the cap', (restartFail2.data as { finding?: boolean }).finding === true);
check('F4. a finding was recorded for the restarted scenario', ctx.findings.length === findingsBeforeF + 1 && ctx.findings[ctx.findings.length - 1]!.scenario === 'lands on a page that never loads');
check('F5. further actions are blocked again', ctx._blockUntilNewScenario === true);

/* ─── E. the cap is per-signature: two different assertions failing once each
 *        do NOT trip it (only the SAME assertion failing twice does) ────────── */
await page.setContent(formHtml, { waitUntil: 'load' });
const findingsBeforeE = ctx.findings.length;
await runTool(ctx, { name: 'begin_scenario', input: { name: 'two distinct checks each fail once', category: 'edge', feature: 'register' } });
const distinctA = await runTool(ctx, { name: 'assert', input: { type: 'toHaveURL', pattern: '/dashboard', timeout: 600 } });
const distinctB = await runTool(ctx, { name: 'assert', input: { type: 'toHaveURL', pattern: '/welcome', timeout: 600 } });
check('E1. first distinct assertion fails without a finding', distinctA.ok === false && (distinctA.data as { finding?: boolean } | undefined)?.finding !== true);
check('E2. second DIFFERENT assertion also fails without tripping the cap', distinctB.ok === false && (distinctB.data as { finding?: boolean } | undefined)?.finding !== true);
check('E3. no finding from two single failures of different signatures', ctx.findings.length === findingsBeforeE);
check('E4. not blocked — each signature only failed once', ctx._blockUntilNewScenario === false);

await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: retry cap — same assertion failing twice records a finding with real page state, blocks the re-fill thrash, and resets on the next scenario; the counter is per-signature.');
