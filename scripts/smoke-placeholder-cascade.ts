/**
 * Lock in the three coordinated fixes that close the cascade-resolution gap
 * the user hit on saucedemo:
 *
 *   1. role+name retry with generic suffixes stripped — "password input"
 *      retries as "password", which substring-matches the accessible name
 *      "Password" (case-insensitive). This was the actual blocker.
 *
 *   2. New `placeholder` cascade level (between label and testid). Catches
 *      forms where a real <label> sets a different accessible name than
 *      the placeholder, and the agent is referring to the placeholder text.
 *
 *   3. get_dom extracts `data-test` AND `data-testid`. Saucedemo (and many
 *      React apps) use `data-test`. Previously the agent's DOM snapshot
 *      had no testid hint to pass on those pages.
 *
 * No network. Static HTML via setContent.
 */
import { chromium } from 'playwright';
import { resolve, emitLocatorCall, stripGenericSuffixes } from '../src/agent/selectors.js';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

// Saucedemo-style form: inputs with placeholders but no <label>, using
// `data-test` (not `data-testid`).
const saucedemoLikeHtml = `
<!doctype html><html><body>
<h1>Sign in</h1>
<form>
  <input type="text" data-test="username" placeholder="Username" name="user-name">
  <input type="password" data-test="password" placeholder="Password" name="password">
  <button type="submit" data-test="login-button">Login</button>
</form>
</body></html>`;

// Page where a real <label> dominates the accessible name and the agent
// might still want to refer to the placeholder text. Only the placeholder
// cascade can bridge this.
const labelMaskingPlaceholderHtml = `
<!doctype html><html><body>
<form>
  <label for="phone">Mobile Number</label>
  <input id="phone" placeholder="555-1234">
</form>
</body></html>`;

async function withPage<T>(html: string, fn: (page: import('playwright').Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    await installEvalShim(ctx);
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

// ─── 1) stripGenericSuffixes — pure unit tests ──────────────────────────
check('A. stripGenericSuffixes("password input") → "password"', stripGenericSuffixes('password input') === 'password');
check('B. stripGenericSuffixes("submit button") → "submit"', stripGenericSuffixes('submit button') === 'submit');
check('C. stripGenericSuffixes("username field") → "username"', stripGenericSuffixes('username field') === 'username');
check('D. stripGenericSuffixes("the username input") → "the username"', stripGenericSuffixes('the username input') === 'the username');
check('E. stripGenericSuffixes("search") returns null (single word)', stripGenericSuffixes('search') === null);
check('F. stripGenericSuffixes("input") returns null (all generic)', stripGenericSuffixes('input') === null);
check('G. stripGenericSuffixes("Sign In") returns null (nothing to strip)', stripGenericSuffixes('Sign In') === null);

// ─── 2) role retry — saucedemo's original failing scenario ──────────────
await withPage(saucedemoLikeHtml, async (page) => {
  // The originally-reported error: intent "password input", no other hints.
  // After the fix, role+name retries with "password" (suffix stripped) and
  // substring-matches the accessible name "Password" (case-insensitive).
  const r = await resolve(page, { intent: 'password input' });
  check('H. intent "password input" resolves (role+name retry with shortened name)', r !== null);
  check('I. winning level is "role" (saucedemo password has accessible name "Password")',
    r?.level === 'role', JSON.stringify(r));
  if (r && r.level === 'role') {
    const arg = r.arg as { role: string; name: string; exact?: boolean };
    check('J. winning role is "textbox"', arg.role === 'textbox');
    check('K. recorded name is the SHORTENED form ("password")', arg.name === 'password', arg.name);
  }

  // Submit button — same pattern.
  const btn = await resolve(page, { intent: 'login button' });
  check('L. intent "login button" resolves at role level', btn?.level === 'role');
  if (btn?.level === 'role') {
    const arg = btn.arg as { name: string };
    check('M. button recorded name is "login" or "Login" (matches accessible name)',
      arg.name.toLowerCase() === 'login', arg.name);
  }
});

// ─── 3) placeholder cascade — wins when label takes the role+name slot ──
await withPage(labelMaskingPlaceholderHtml, async (page) => {
  // Accessible name is "Mobile Number" (from <label>). Agent refers to the
  // PLACEHOLDER text "555-1234". Only the placeholder layer can match.
  const r = await resolve(page, { intent: '555-1234' });
  check('N. intent matching ONLY the placeholder (not the label) resolves',
    r !== null, JSON.stringify(r));
  check('O. winning level is "placeholder"', r?.level === 'placeholder', r?.level);
  check('P. winning arg is the placeholder text "555-1234"', r?.arg === '555-1234');

  // Confirm the role+name path doesn't accidentally also match here.
  const roleOnly = page.getByRole('textbox', { name: '555-1234' });
  check('Q. (sanity) getByRole({name: "555-1234"}) does NOT match — placeholder is not the acc name',
    (await roleOnly.count()) === 0);

  // emitLocatorCall produces getByPlaceholder() for the new level.
  check('R. emitLocatorCall("placeholder", "555-1234") → getByPlaceholder("555-1234")',
    emitLocatorCall('placeholder', '555-1234') === 'page.getByPlaceholder("555-1234")');
  check('S. ambiguous=true appends .first()',
    emitLocatorCall('placeholder', '555-1234', true) === 'page.getByPlaceholder("555-1234").first()');
});

// ─── 4) get_dom extracts `data-test` alongside `data-testid` ────────────
await withPage(saucedemoLikeHtml, async (page) => {
  const tc = createContext(page, 20);
  await runTool(tc, { name: 'begin_scenario', input: { name: 'inspect dom', category: 'happy' } });
  const dom = await runTool(tc, { name: 'get_dom', input: {} });
  if (!dom.ok) {
    check('T. get_dom returns ok', false, dom.error);
  } else {
    const data = dom.data as {
      inputs: Array<{ testid?: string; placeholder?: string }>,
      buttons: Array<{ testid?: string }>,
    };
    check('T. get_dom returns ok', true);
    check('U. username input testid surfaced from data-test',
      data.inputs.some((i) => i.testid === 'username'), JSON.stringify(data.inputs));
    check('V. password input testid surfaced from data-test',
      data.inputs.some((i) => i.testid === 'password'));
    check('W. login button testid surfaced from data-test',
      data.buttons.some((b) => b.testid === 'login-button'));
    check('X. placeholder is exposed in get_dom output',
      data.inputs.some((i) => i.placeholder === 'Password'));
  }
});

// ─── 5) End-to-end — the original reported error no longer happens ──────
await withPage(saucedemoLikeHtml, async (page) => {
  const tc = createContext(page, 20);
  await runTool(tc, { name: 'begin_scenario', input: { name: 'fill password by intent', category: 'happy' } });
  const fill = await runTool(tc, {
    name: 'fill',
    input: { intent: 'password input', value: 'secret_sauce' },
  });
  check('Y. fill({intent: "password input"}) succeeds (no "Could not resolve" error)',
    fill.ok === true, fill.error);
  check('Z. value reaches the actual password input on the page',
    await page.locator('input[type=password]').inputValue() === 'secret_sauce');

  const sc = tc.current!;
  const fillStep = sc.steps.find((s) => s.kind === 'fill');
  check('AA. fill step was recorded', !!fillStep);
  if (fillStep && fillStep.kind === 'fill') {
    check('AB. recorded target.level is "role" (best-available level wins)',
      fillStep.target.level === 'role', fillStep.target.level);
  }
  check('AC. cascadeStats.role bumped exactly once',
    tc.cascadeStats.role === 1 && tc.cascadeStats.placeholder === 0,
    JSON.stringify(tc.cascadeStats));
});

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: cascade now resolves under-instrumented forms (role+name last-word retry + placeholder layer + data-test extraction).');
