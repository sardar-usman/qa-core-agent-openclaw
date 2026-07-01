/**
 * Locks the standalone /heal command (src/agent/heal.ts).
 *
 * Given a Playwright spec whose selectors no longer match the live page, heal()
 * opens the page, probes each locator, and re-resolves the broken ones with the
 * SAME locator ladder + healResolve the Explorer uses — never an LLM guess. It
 * confirms each re-resolved locator points to the SAME intended element, writes
 * the repaired spec back, and reports anything it could not heal.
 *
 * Checks:
 *   A. a broken selector (a button that became a link, same accessible name) is
 *      healed to the correct element and the file is written back;
 *   B. an intact selector is left untouched;
 *   C. a selector for an element that is not on the page is reported unhealable,
 *      not silently changed;
 *   D. a selector that loosely matches a DIFFERENT element (right type, wrong
 *      identity) is refused by the same-element confirmation — a wrong heal is
 *      worse than no heal;
 *   E. a spec whose only broken selector is unhealable writes nothing back.
 *
 * Serves a static page from a local HTTP server. No network, no model call.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heal } from '../src/agent/heal.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const PAGE_HTML = `<!doctype html><html><body>
  <a href="#">Sign In</a>
  <input aria-label="Username" />
  <input aria-label="Contact" type="email" />
</body></html>`;

// A tiny server that returns the same page for every request.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE_HTML);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const url = `http://127.0.0.1:${port}/`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-heal-cmd-'));

/* ─── main spec: one healable, one intact, two unhealable ─────────────────── */
const specPath = path.join(dir, 'login.spec.ts');
const originalSpec = `import { test, expect } from '@playwright/test';

test('login flow', async ({ page }) => {
  await page.goto('${url}');
  await page.getByRole("button", {"name":"Sign In"}).click();
  await page.getByLabel("Username").fill("ada");
  await page.getByRole("textbox", {"name":"Email"}).fill("x");
  await page.getByRole("button", {"name":"Nonexistent Widget"}).click();
});
`;
fs.writeFileSync(specPath, originalSpec);

const result = await heal({ specPath });

check('A1. exactly one selector was healed', result.healed.length === 1, JSON.stringify(result.healed));
const h = result.healed[0];
check('A2. the healed selector was the broken button locator', !!h && /getByRole\("button", ?\{"name":"Sign In"\}\)/.test(h.old), h?.old);
check('A3. it re-resolved to the SAME element by a different stable locator (the link)',
  !!h && h.new.includes('getByRole("link"') && h.new.includes('Sign In'), h?.new);

check('B1. the still-valid selector was left intact', result.intact === 1, `intact=${result.intact}`);
check('B2. all four locators were scanned', result.scanned === 4, `scanned=${result.scanned}`);

check('C1. two selectors were reported unhealable', result.unhealable.length === 2, JSON.stringify(result.unhealable));
const notFound = result.unhealable.find((u) => /Nonexistent Widget/.test(u.selector));
check('C2. the missing element is reported as could-not-re-resolve', !!notFound && /re-resolved/i.test(notFound.reason), notFound?.reason);

const wrongEl = result.unhealable.find((u) => /"name":"Email"/.test(u.selector));
check('D1. the loose "Email" match to the Contact field was refused', !!wrongEl, JSON.stringify(result.unhealable));
check('D2. the refusal reason is a different-element / confirmation failure',
  !!wrongEl && /different element|not healing/i.test(wrongEl.reason), wrongEl?.reason);

/* the file was written back with ONLY the confirmed heal applied */
const healedSrc = fs.readFileSync(specPath, 'utf8');
check('E1. the file was written back', result.filesWritten.includes(specPath));
check('E2. the healed spec now uses the link locator', /getByRole\("link", ?\{"name":"Sign In"/.test(healedSrc), healedSrc);
check('E3. the broken button locator is gone', !healedSrc.includes('getByRole("button", {"name":"Sign In"})'));
check('E4. the intact Username locator is unchanged', healedSrc.includes('getByLabel("Username")'));
check('E5. the unhealable selectors were left unchanged, not wrongly rewritten',
  healedSrc.includes('getByRole("textbox", {"name":"Email"})') && healedSrc.includes('getByRole("button", {"name":"Nonexistent Widget"})'), healedSrc);

/* ─── a spec whose only broken selector is unhealable writes nothing back ──── */
const specPath2 = path.join(dir, 'ghost.spec.ts');
const ghostSpec = `import { test, expect } from '@playwright/test';

test('ghost', async ({ page }) => {
  await page.goto('${url}');
  await page.getByRole("button", {"name":"Totally Absent Control"}).click();
});
`;
fs.writeFileSync(specPath2, ghostSpec);
const result2 = await heal({ specPath: specPath2 });
check('F1. nothing was healed', result2.healed.length === 0, JSON.stringify(result2.healed));
check('F2. the missing selector is reported unhealable', result2.unhealable.length === 1, JSON.stringify(result2.unhealable));
check('F3. no file was written', result2.filesWritten.length === 0 && result2.healedPath === null);
check('F4. the spec file is byte-for-byte unchanged', fs.readFileSync(specPath2, 'utf8') === ghostSpec);

/* ─── POM: the broken locator lives in an imported page object, URL too ─────── */
const pomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-heal-pom-'));
fs.mkdirSync(path.join(pomDir, 'pages'));
const pagePath = path.join(pomDir, 'pages', 'login-page.ts');
const pageObj = `import { type Page, type Locator } from '@playwright/test';

export class LoginPage {
  readonly url = "${url}";
  readonly signIn: Locator;
  constructor(page: Page) {
    this.page = page;
    this.signIn = page.getByRole("button", {"name":"Sign In"});
  }
  async goto() { await this.page.goto(this.url); }
}
`;
fs.writeFileSync(pagePath, pageObj);
const pomSpecPath = path.join(pomDir, 'login.spec.ts');
fs.writeFileSync(pomSpecPath, `import { test, expect } from '@playwright/test';
import { LoginPage } from './pages/login-page';

test('login', async ({ page }) => {
  const lp = new LoginPage(page);
  await lp.goto();
  await lp.signIn.click();
});
`);

const pomResult = await heal({ specPath: pomSpecPath });
check('G1. POM: the target URL was found in the page object (readonly url)', pomResult.scanned >= 1, JSON.stringify(pomResult));
check('G2. POM: the broken locator inside the page object was healed', pomResult.healed.length === 1, JSON.stringify(pomResult.healed));
check('G3. POM: the page-object FILE (not the spec) was written back', pomResult.filesWritten.includes(pagePath), JSON.stringify(pomResult.filesWritten));
const healedPageObj = fs.readFileSync(pagePath, 'utf8');
check('G4. POM: the page object now uses the link locator', /getByRole\("link", ?\{"name":"Sign In"/.test(healedPageObj), healedPageObj);
fs.rmSync(pomDir, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
await new Promise<void>((resolve) => server.close(() => resolve()));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: /heal re-resolves broken selectors against the live page (same ladder as exploration), confirms the same element, writes the fix back, and reports what it cannot heal.');
