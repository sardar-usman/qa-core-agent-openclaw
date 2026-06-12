/**
 * Smoke test for the page.evaluate calls inside tools.ts and planner.ts.
 * Exercises the exact code paths that errored with "__name is not defined"
 * in the last live run. Runs against a tiny inline HTML so no network needed.
 */
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

const html = `
<!doctype html><html><body>
<h1>Login</h1>
<form>
  <label>Email <input id="email" name="email" required></label>
  <label>Password <input id="pass" name="pass" type="password" required></label>
  <button type="submit">Sign in</button>
  <button type="button" disabled>Disabled action</button>
</form>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await installEvalShim(ctx);   // matches runtime.ts setup
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'load' });

const toolCtx = createContext(page, 10);
const got = await runTool(toolCtx, { name: 'get_dom', input: {} });
await browser.close();

console.log(JSON.stringify(got, null, 2));
if (!got.ok) {
  console.error('FAIL: get_dom returned an error');
  process.exit(1);
}
const data = got.data as { inputs: Array<Record<string, unknown>>; buttons: Array<Record<string, unknown>> };
const anyRequired = data.inputs.some(i => i.required === true);
const anyDisabled = data.buttons.some(b => b.disabled === true);
const anyValidation = data.inputs.some(i => typeof i.validation === 'string' && (i.validation as string).length > 0);
if (!anyRequired) { console.error('FAIL: no input reported required'); process.exit(1); }
if (!anyDisabled) { console.error('FAIL: no button reported disabled'); process.exit(1); }
if (!anyValidation) { console.error('FAIL: no validation message captured'); process.exit(1); }
console.log('OK: required + disabled + validation surfaced correctly');
