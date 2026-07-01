/**
 * Locks in the v3.2 per-feature framework structure.
 *
 * Synthesizes a RunReport with scenarios tagged with `feature: 'login'` and
 * `feature: 'cart'`, then asserts:
 *   - One <feature>-page.ts per feature in pages/
 *   - tests/<feature>/<feature>.spec.ts for each feature
 *   - Each spec contains ONLY scenarios for its feature
 *   - Spec import path is '../../pages/<feature>-page' (two levels up)
 *   - Describe title includes the feature name
 *   - PageGroup class name is PascalCase (LoginPage, CartPage)
 *   - Fallback: if a scenario has no feature, the URL-pathname derivation
 *     still produces a sensible group (legacy behaviour preserved)
 *   - Framework directory name uses brand slug ("saucedemo-automation-framework"
 *     not "www-saucedemo-com-framework")
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scaffold, frameworkDirName, brandSlug } from '../src/agent/scaffold.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

// 1) Brand-slug helper produces the right names.
check('A. brandSlug strips www. and .com', brandSlug('https://www.saucedemo.com/') === 'saucedemo');
check('B. brandSlug preserves subdomains', brandSlug('https://demo.playwright.dev') === 'demo-playwright');
check('C. brandSlug handles multi-segment hosts', brandSlug('https://the-internet.herokuapp.com') === 'the-internet-herokuapp');
check('D. frameworkDirName appends -automation-framework', frameworkDirName('https://www.saucedemo.com/') === 'saucedemo-automation-framework');

// 2) Multi-feature run produces per-feature page + per-feature spec folder.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-fgroup-'));
const frameworkDir = path.join(tmpRoot, frameworkDirName('https://www.saucedemo.com/'));

const report: RunReport = {
  url: 'https://www.saucedemo.com/',
  language: 'ts',
  scenarios: [
    {
      name: 'logged in with valid credentials', category: 'happy', feature: 'login',
      steps: [
        { kind: 'navigate', url: 'https://www.saucedemo.com/' },
        { kind: 'fill', target: { level: 'role', arg: { role: 'textbox', name: 'Username', exact: true }, intent: 'username input' }, value: 'standard_user' },
        { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login', exact: true }, intent: 'login button' } },
        { kind: 'assert', name: 'inventory URL', assertion: { type: 'toHaveURL', pattern: '/inventory' } },
      ],
    },
    {
      name: 'rejects invalid password', category: 'negative', feature: 'login',
      steps: [
        { kind: 'navigate', url: 'https://www.saucedemo.com/' },
        { kind: 'fill', target: { level: 'role', arg: { role: 'textbox', name: 'Password', exact: true }, intent: 'password input' }, value: 'wrong' },
        { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login', exact: true }, intent: 'login button' } },
        { kind: 'assert', name: 'error visible', assertion: { type: 'toContainText', target: { level: 'css', arg: '[data-test=error]', intent: 'error message' }, text: 'do not match' } },
      ],
    },
    {
      name: 'added item to cart and saw badge', category: 'happy', feature: 'cart',
      steps: [
        { kind: 'navigate', url: 'https://www.saucedemo.com/inventory.html' },
        { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Add to cart', exact: false }, intent: 'add to cart button' } },
        { kind: 'assert', name: 'badge', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.shopping_cart_badge', intent: 'cart badge' }, text: '1' } },
      ],
    },
  ],
  cascadeStats: { role: 5, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 2, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 11,
  startedAt: '2026-06-22T12:00:00Z',
  finishedAt: '2026-06-22T12:01:00Z',
};

const result = scaffold({ report, outDir: frameworkDir, siteName: 'www.saucedemo.com', features: ['login', 'cart'] });

// 3) pages/ contains BasePage + one <feature>-page.ts per feature.
const pagesDir = path.join(frameworkDir, 'pages');
const pageFiles = fs.readdirSync(pagesDir).sort();
check('E. pages/ contains BasePage.ts', pageFiles.includes('BasePage.ts'));
check('F. pages/ contains login-page.ts (kebab-case, not LoginPage.ts)', pageFiles.includes('login-page.ts'));
check('G. pages/ contains cart-page.ts', pageFiles.includes('cart-page.ts'));
check('H. pages/ does NOT contain LoginPage.ts (old PascalCase filename)', !pageFiles.includes('LoginPage.ts'));
check('I. pages/ does NOT contain CartPage.ts', !pageFiles.includes('CartPage.ts'));

// 4) Class name inside the file IS PascalCase (LoginPage, CartPage).
const loginPageSource = fs.readFileSync(path.join(pagesDir, 'login-page.ts'), 'utf8');
const cartPageSource = fs.readFileSync(path.join(pagesDir, 'cart-page.ts'), 'utf8');
check('J. login-page.ts exports `LoginPage` class', /export\s+class\s+LoginPage\b/.test(loginPageSource));
check('K. cart-page.ts exports `CartPage` class', /export\s+class\s+CartPage\b/.test(cartPageSource));

// 5) tests/<feature>/ folders exist with the right spec file.
const testsDir = path.join(frameworkDir, 'tests');
check('L. tests/login/ folder exists', fs.existsSync(path.join(testsDir, 'login')));
check('M. tests/cart/ folder exists', fs.existsSync(path.join(testsDir, 'cart')));
check('N. tests/login/login.spec.ts exists', fs.existsSync(path.join(testsDir, 'login', 'login.spec.ts')));
check('O. tests/cart/cart.spec.ts exists', fs.existsSync(path.join(testsDir, 'cart', 'cart.spec.ts')));

// 6) Each spec contains ONLY its feature's scenarios, not the other feature's.
const loginSpec = fs.readFileSync(path.join(testsDir, 'login', 'login.spec.ts'), 'utf8');
const cartSpec = fs.readFileSync(path.join(testsDir, 'cart', 'cart.spec.ts'), 'utf8');
check('P. login spec contains "logged in with valid credentials"', loginSpec.includes('logged in with valid credentials'));
check('Q. login spec contains "rejects invalid password"', loginSpec.includes('rejects invalid password'));
check('R. login spec does NOT contain "added item to cart"', !loginSpec.includes('added item to cart'));
check('S. cart spec contains "added item to cart"', cartSpec.includes('added item to cart'));
check('T. cart spec does NOT contain "logged in with valid credentials"', !cartSpec.includes('logged in with valid credentials'));

// 7) Import paths are correct for the new two-levels-deep location.
check('U. login spec imports from ../../pages/login-page', /from\s+['"]\.\.\/\.\.\/pages\/login-page['"]/.test(loginSpec));
check('V. cart spec imports from ../../pages/cart-page', /from\s+['"]\.\.\/\.\.\/pages\/cart-page['"]/.test(cartSpec));

// 8) Describe title includes the feature name.
check('W. login spec describe mentions "login"', /test\.describe\([^)]*login[^)]*\)/.test(loginSpec));
check('X. cart spec describe mentions "cart"', /test\.describe\([^)]*cart[^)]*\)/.test(cartSpec));

// 9) ScaffoldResult correctly reports features.
check('Y. scaffoldResult.pomResult.features has both', result.pomResult.features.includes('login') && result.pomResult.features.includes('cart'));
check('Z. scaffoldResult.pomResult.specFiles has length 2', result.pomResult.specFiles.length === 2);

// 10) Legacy fallback — scenarios without `feature` group by URL pathname.
const tmpLegacy = path.join(tmpRoot, 'legacy-framework');
const legacyReport: RunReport = {
  url: 'https://www.saucedemo.com/',
  language: 'ts',
  scenarios: [
    {
      name: 'something happens', category: 'happy',
      // NO feature field — should fall back to URL-pathname derivation.
      steps: [
        { kind: 'navigate', url: 'https://www.saucedemo.com/' },
        { kind: 'assert', name: 'on home', assertion: { type: 'toHaveURL', pattern: 'saucedemo' } },
      ],
    },
  ],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 2,
  startedAt: '2026-06-22T12:00:00Z',
  finishedAt: '2026-06-22T12:00:30Z',
};
const legacyResult = scaffold({ report: legacyReport, outDir: tmpLegacy, siteName: 'www.saucedemo.com' });
check('AA. Legacy (no feature) produces at least 1 spec file', legacyResult.pomResult.specFiles.length >= 1);
check('AB. Legacy fallback derives a sensible feature folder', legacyResult.pomResult.features.length >= 1);

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: per-feature page + per-feature spec folder structure verified end-to-end.');
