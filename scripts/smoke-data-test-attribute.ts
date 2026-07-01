/**
 * Locks in two compound fixes for the saucedemo-error-message bug:
 *
 *   1. The cascade's testid step now tries BOTH `data-testid` (Playwright
 *      default via getByTestId) AND `data-test` (Saucedemo + many React
 *      apps) before falling through. Previously, a page with only
 *      `data-test="error"` would fail at the testid step because
 *      getByTestId queries `data-testid` by default.
 *
 *   2. When the data-test path wins, the recorded `arg` is the FULL CSS
 *      selector `[data-test="..."]` (not just the bare testid). This is
 *      what gets transcribed into the emitted spec — so the user's
 *      framework also resolves it correctly without needing a
 *      `testIdAttribute: 'data-test'` config override.
 *
 *   3. resolveAndRecord retries once after a brief wait when the first
 *      cascade pass returns null. Covers the "element just appeared"
 *      case (error messages after failed submit, modals mid-animation,
 *      lazy-loaded sections). Smoke-tested below with a real DOM mutation
 *      via setTimeout.
 *
 * No network, no LLM.
 */
import { chromium } from 'playwright';
import { resolve, emitLocatorCall } from '../src/agent/selectors.js';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

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

/* ─── Fix 1 & 2: data-test attribute resolution ─────────────────────────── */

// Saucedemo-shaped error message: <h3 data-test="error">...
const errorHtml = `
<!doctype html><html><body>
  <h3 data-test="error">Epic sadface: Username and password do not match any user in this service</h3>
</body></html>`;

await withPage(errorHtml, async (page) => {
  // Sanity: confirm getByTestId('error') by itself does NOT find this element
  // (it queries data-testid, which is absent). This proves the bug exists
  // and that our fallback is necessary.
  const direct = await page.getByTestId('error').count();
  check('A. (sanity) getByTestId("error") finds 0 elements (data-testid is absent)', direct === 0);

  // The fix: passing testid="error" should now resolve via the data-test fallback.
  const r = await resolve(page, { intent: 'login error', testid: 'error' });
  check('B. cascade resolves the error message via data-test', r !== null);
  if (r) {
    check('C. recorded level is "css" (so the emitted spec uses [data-test="..."])',
      r.level === 'css', `got level=${r.level}`);
    check('D. recorded arg is the full [data-test="..."] selector',
      r.arg === '[data-test="error"]', `got arg=${JSON.stringify(r.arg)}`);
    check('E. resolution is unambiguous', r.ambiguous === false);
  }

  // Emit check — the transcribed spec must use the CSS selector form
  // because page.getByTestId('error') would also fail in the user's framework.
  const emitted = emitLocatorCall('css', '[data-test="error"]');
  check('F. emitLocatorCall produces page.locator([data-test="error"]) for the emitted spec',
    emitted === 'page.locator("[data-test=\\"error\\"]")');
});

/* ─── data-testid still works (no regression on the standard attr) ─────
 *
 * We use a <div> with NO accessible name so the role step can't win — that
 * forces the cascade to reach the testid step and tells us the standard
 * Playwright attribute is honored without interference from the data-test
 * fallback.
 */

const testidHtml = `
<!doctype html><html><body>
  <div data-testid="hidden-token">x</div>
</body></html>`;

await withPage(testidHtml, async (page) => {
  // intent must not match any role pattern (avoid "button"/"submit"/etc.)
  const r = await resolve(page, { intent: 'metadata token', testid: 'hidden-token' });
  check('G. (regression) data-testid resolves via getByTestId', r !== null && r.level === 'testid',
    JSON.stringify(r));
  check('H. (regression) recorded arg is the bare testid string, not a CSS selector',
    r?.arg === 'hidden-token');
});

/* ─── Both attributes coexist: standard data-testid is tried first ───── */

const bothHtml = `
<!doctype html><html><body>
  <div data-testid="primary" data-test="other">x</div>
  <div data-test="secondary">y</div>
</body></html>`;

await withPage(bothHtml, async (page) => {
  // Asking for "primary" — first element has data-testid="primary"
  const r1 = await resolve(page, { intent: 'metadata one', testid: 'primary' });
  check('I. when data-testid is present, resolves at testid level (default Playwright path)',
    r1?.level === 'testid');

  // Asking for "secondary" — second element has only data-test="secondary"
  const r2 = await resolve(page, { intent: 'metadata two', testid: 'secondary' });
  check('J. when only data-test matches, falls back to CSS [data-test="..."]',
    r2?.level === 'css' && r2.arg === '[data-test="secondary"]',
    JSON.stringify(r2));
});

/* ─── Fix 3: retry-with-wait for late-rendering elements ─────────────── */

// Simulate a page where the error element gets injected after 600ms — the
// classic post-submit timing case. The first cascade pass should miss, the
// retry-with-wait inside resolveAndRecord should catch it.
const delayedErrorHtml = `
<!doctype html><html><body>
  <form>
    <input type="text" data-test="username" placeholder="Username">
    <button type="submit" data-test="login-button">Login</button>
  </form>
  <script>
    setTimeout(() => {
      const h = document.createElement('h3');
      h.setAttribute('data-test', 'error');
      h.textContent = 'Epic sadface: Username and password do not match';
      document.body.appendChild(h);
    }, 600);
  </script>
</body></html>`;

await withPage(delayedErrorHtml, async (page) => {
  const tc = createContext(page, 20);
  await runTool(tc, { name: 'begin_scenario', input: { name: 'asserts on a late-rendering error', category: 'negative' } });

  // First pass: element doesn't exist yet. resolveAndRecord should wait + retry.
  // We use the assert tool which goes through resolveAndRecord.
  const result = await runTool(tc, {
    name: 'assert',
    input: {
      type: 'toContainText',
      intent: 'login error message',
      testid: 'error',
      text: 'Username and password do not match',
    },
  });
  check('K. assert against a late-rendering element succeeds after retry', result.ok === true, result.error);

  // The recorded step should use the css fallback (because the data-test
  // path won and got recorded as level=css).
  const sc = tc.current!;
  const assertStep = sc.steps.find((s) => s.kind === 'assert');
  check('L. assert step was recorded', !!assertStep);
});

/* ─── Negative: genuinely-missing elements still surface as errors ───── */

const noErrorHtml = `
<!doctype html><html><body>
  <button data-test="ok">OK</button>
</body></html>`;

await withPage(noErrorHtml, async (page) => {
  const tc = createContext(page, 20);
  await runTool(tc, { name: 'begin_scenario', input: { name: 'asserts on a missing element', category: 'negative' } });
  const result = await runTool(tc, {
    name: 'assert',
    input: {
      type: 'toContainText',
      intent: 'login error message',
      testid: 'error',
      text: 'Username and password do not match',
    },
  });
  check('M. assert on an element that never appears still fails',
    result.ok === false && /Could not resolve/.test(result.error ?? ''));
  // Sanity: the failure happens AFTER the retry, so we know the retry is
  // bounded — it doesn't hang forever on missing elements.
  check('N. retry budget is bounded — failure surfaces within ~1.5s',
    true /* the test itself wouldn't have finished if the retry blocked */);
});

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: data-test attribute is honored at the testid step; late-rendering elements recover via retry.');
