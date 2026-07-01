/**
 * Locks in two more cascade-resolution fixes surfaced by a real saucedemo run:
 *
 *   1. Text fallback. When the agent passes only `intent` + `text` (no css,
 *      testid, role, or label), the cascade now tries `getByText(text)` as
 *      a last resort BEFORE giving up. Covers the very common case of
 *      asserting on an error message / toast / heading where the only
 *      stable identifier is the visible copy. Records as level='css' with
 *      Playwright's `text=...` selector syntax so the emitted spec is
 *      straightforward.
 *
 *   2. CSS quote normalisation. Models sometimes emit selectors with
 *      over-escaped quotes — `[data-test=\"foo\"]` — when serialising
 *      through their tool-use JSON. Playwright's CSS engine can't parse
 *      the backslash-quote, so the locator silently matches nothing.
 *      normalizeCssQuotes() strips the backslashes before passing to
 *      Playwright. Idempotent on already-clean selectors.
 *
 * No network, no LLM.
 */
import { chromium } from 'playwright';
import {
  resolve,
  emitLocatorCall,
  normalizeCssQuotes,
} from '../src/agent/selectors.js';
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

/* ─── normalizeCssQuotes (pure) ─────────────────────────────────────── */

check('A. strips backslash-quote inside attribute selectors',
  normalizeCssQuotes('[data-test=\\"foo\\"]') === '[data-test="foo"]');
check('B. strips backslash-single-quote',
  normalizeCssQuotes("[data-test=\\'bar\\']") === "[data-test='bar']");
check('C. mixed escape forms in one selector',
  normalizeCssQuotes('h3[data-test=\\"error\\"]') === 'h3[data-test="error"]');
check('D. already-clean selector is unchanged (idempotent)',
  normalizeCssQuotes('[data-test="foo"]') === '[data-test="foo"]');
check('E. selectors without quotes are unchanged',
  normalizeCssQuotes('div.my-class > button') === 'div.my-class > button');
check('F. empty string is safe',
  normalizeCssQuotes('') === '');
check('G. complex saucedemo selector is normalised',
  normalizeCssQuotes('[data-test=\\"add-to-cart-sauce-labs-backpack\\"]') === '[data-test="add-to-cart-sauce-labs-backpack"]');

/* ─── Text fallback resolves error messages ─────────────────────────── */

// The exact saucedemo error-message shape. Only stable identifier: the text.
const errorHtml = `
<!doctype html><html><body>
  <h3 data-test="error">Epic sadface: Username and password do not match any user in this service</h3>
</body></html>`;

await withPage(errorHtml, async (page) => {
  // No css, testid, role, label — only intent + text. This is exactly what
  // failed in the user's screenshot.
  const r = await resolve(page, {
    intent: 'login error message',
    text: 'Username and password do not match',
  });
  check('H. resolves via text fallback when only intent + text are given',
    r !== null, JSON.stringify(r));
  if (r) {
    check('I. recorded level is css (using text=... selector form)',
      r.level === 'css');
    check('J. recorded arg uses Playwright text= syntax',
      typeof r.arg === 'string' && r.arg === 'text=Username and password do not match');
  }
});

/* ─── Text fallback ONLY fires when other hints fail ────────────────── */

const ambiguousHtml = `
<!doctype html><html><body>
  <button>Submit</button>
  <h3>Submit clicked successfully</h3>
</body></html>`;

await withPage(ambiguousHtml, async (page) => {
  // intent matches role+name on the button → cascade wins at role level
  // BEFORE the text fallback runs. Sanity: text fallback shouldn't preempt.
  const r = await resolve(page, { intent: 'submit', text: 'Submit clicked successfully' });
  check('K. text fallback does NOT preempt earlier cascade wins',
    r !== null && r.level === 'role', JSON.stringify(r));
});

/* ─── Text fallback rejects empty / very-short text ──────────────────── */

await withPage(errorHtml, async (page) => {
  // Short fragments would match too much. The cascade requires >=4 chars
  // before trying getByText so trivial fragments don't trigger false matches.
  const r1 = await resolve(page, { intent: 'x', text: 'ab' });
  check('L. text <4 chars is ignored (avoids matching everything)',
    r1 === null || r1.level !== 'css' || (typeof r1.arg === 'string' && !r1.arg.startsWith('text=')));

  const r2 = await resolve(page, { intent: 'x', text: '' });
  check('M. empty text is ignored', r2 === null);
});

/* ─── Over-escaped CSS is rescued by normalisation ─────────────────── */

const dataTestHtml = `
<!doctype html><html><body>
  <button data-test="add-to-cart-sauce-labs-backpack">Add to cart</button>
</body></html>`;

await withPage(dataTestHtml, async (page) => {
  // The exact malformed-quote string the agent produced in the user's screenshot.
  const r = await resolve(page, {
    intent: 'add backpack to cart button',
    css: '[data-test=\\"add-to-cart-sauce-labs-backpack\\"]',
  });
  check('N. resolves an over-escaped data-test selector via quote normalisation',
    r !== null && r.level === 'css', JSON.stringify(r));
  if (r) {
    check('O. recorded arg is the CLEANED selector (no backslash-quotes)',
      r.arg === '[data-test="add-to-cart-sauce-labs-backpack"]', JSON.stringify(r.arg));
  }
});

/* ─── Combined: emitted code from the text fallback is valid Playwright ─ */

// The cascade records text fallback as level=css with `text=…` arg. The
// emitter should produce `page.locator("text=…")`, which is a real
// Playwright text engine selector and works in the user's framework.
const emitted = emitLocatorCall('css', 'text=Username and password do not match');
check('P. emitted spec uses page.locator("text=…") form',
  emitted === 'page.locator("text=Username and password do not match")');

/* ─── Negative: genuinely-missing text still fails fast ───────────────── */

await withPage('<!doctype html><html><body><p>hello world</p></body></html>', async (page) => {
  const r = await resolve(page, {
    intent: 'login error message',
    text: 'no such text appears here',
  });
  check('Q. text fallback fails when the text isn\'t on the page', r === null);
});

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: text fallback rescues assertion-only resolves; over-escaped CSS quotes are normalised.');
