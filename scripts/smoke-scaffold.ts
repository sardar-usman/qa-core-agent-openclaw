/**
 * Verifies the framework scaffolder:
 *   - All required files are written.
 *   - package.json is valid JSON and pins Playwright + axe-core.
 *   - playwright.config.ts mentions the target URL.
 *   - README mentions the site name.
 *   - tsconfig.json is valid JSON.
 *   - The POM pages/tests/a11y files still get written (pom.ts integration).
 *   - Re-running produces identical output (idempotency).
 *
 * No network. No LLM. Synthesizes a fixture RunReport then runs scaffold().
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scaffold } from '../src/agent/scaffold.js';
import type { RunReport } from '../src/agent/trace.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-scaffold-'));
const frameworkDir = path.join(tmpRoot, 'saucedemo-framework');

const report: RunReport = {
  url: 'https://www.saucedemo.com/',
  language: 'ts',
  scenarios: [
    {
      name: 'logged in with valid credentials',
      category: 'happy',
      steps: [
        { kind: 'navigate', url: 'https://www.saucedemo.com/' },
        { kind: 'fill', target: { level: 'role', arg: { role: 'textbox', name: 'Username', exact: true }, intent: 'username input' }, value: 'standard_user' },
        { kind: 'fill', target: { level: 'role', arg: { role: 'textbox', name: 'Password', exact: true }, intent: 'password input' }, value: 'secret_sauce' },
        { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login', exact: true }, intent: 'login button' } },
        { kind: 'assert', name: 'URL contains /inventory', assertion: { type: 'toHaveURL', pattern: '/inventory' } },
      ],
    },
  ],
  cascadeStats: { role: 4, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: {
    inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0,
    usd: 0.05, plannerUsd: 0.001, criticUsd: 0.005,
  },
  steps: 5,
  startedAt: '2026-06-20T12:00:00Z',
  finishedAt: '2026-06-20T12:01:00Z',
  review: {
    verdicts: [{ scenario: 'logged in with valid credentials', verdict: 'pass', reasons: ['specific URL assertion'], required_fixes: [] }],
    summary: 'Single happy-path scenario with a specific URL assertion.',
  },
  replay: {
    passed: 1, failed: 0, durationMs: 2500,
    verdicts: [{ name: 'logged in with valid credentials', passed: true, durationMs: 2500 }],
  },
  stability: {
    iterations: 3, passed: 1, flaked: 0, flaky: 0, broken: 0, flakeRate: 0, durationMs: 7500,
    verdicts: [{ name: 'logged in with valid credentials', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 7500 }],
  },
};

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const result = scaffold({
  report,
  outDir: frameworkDir,
  siteName: 'www.saucedemo.com',
  features: ['login'],
});

// 1. All required scaffold files exist.
const required = [
  'package.json',
  'playwright.config.ts',
  'tsconfig.json',
  '.gitignore',
  '.env.example',
  'fixtures/credentials.ts',
  'helpers/assertions.ts',
  'README.md',
];
for (const f of required) {
  check(`A. file exists: ${f}`, fs.existsSync(path.join(frameworkDir, f)));
}

// 2. package.json is valid JSON and pins the right deps.
let pkg: Record<string, unknown> | null = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(frameworkDir, 'package.json'), 'utf8')) as Record<string, unknown>;
  check('B. package.json parses as JSON', true);
} catch (e) {
  check('B. package.json parses as JSON', false, (e as Error).message);
}
if (pkg) {
  const deps = pkg.dependencies as Record<string, string> | undefined;
  check('C. package.json pins @playwright/test', !!deps?.['@playwright/test']);
  check('D. package.json pins @axe-core/playwright', !!deps?.['@axe-core/playwright']);
  const scripts = pkg.scripts as Record<string, string> | undefined;
  check('E. package.json has test script', scripts?.test === 'playwright test');
}

// 3. tsconfig.json is valid JSON.
try {
  JSON.parse(fs.readFileSync(path.join(frameworkDir, 'tsconfig.json'), 'utf8'));
  check('F. tsconfig.json parses as JSON', true);
} catch (e) {
  check('F. tsconfig.json parses as JSON', false, (e as Error).message);
}

// 4. playwright.config.ts references the target URL.
const pwConfig = fs.readFileSync(path.join(frameworkDir, 'playwright.config.ts'), 'utf8');
check('G. playwright.config.ts references baseURL', pwConfig.includes('https://www.saucedemo.com/'));
check('H. playwright.config.ts exports defineConfig', pwConfig.includes('defineConfig'));

// 5. README mentions the site + feature.
const readme = fs.readFileSync(path.join(frameworkDir, 'README.md'), 'utf8');
check('I. README mentions site', readme.includes('www.saucedemo.com'));
check('J. README mentions the feature', readme.includes('`login`'));
check('K. README has quick-start block', readme.includes('npx playwright test'));

// 6. POM files exist (pom.ts integration).
check('L. pages/ directory exists', fs.existsSync(path.join(frameworkDir, 'pages')));
check('M. tests/ directory exists', fs.existsSync(path.join(frameworkDir, 'tests')));
check('N. tests/a11y/ directory exists (inside tests so it runs by default)', fs.existsSync(path.join(frameworkDir, 'tests', 'a11y')));
check('N1. legacy top-level a11y/ directory does NOT exist', !fs.existsSync(path.join(frameworkDir, 'a11y')));
check('N2. tests/a11y/landing.a11y.spec.ts file exists', fs.existsSync(path.join(frameworkDir, 'tests', 'a11y', 'landing.a11y.spec.ts')));
check('O. run-report.json written', fs.existsSync(path.join(frameworkDir, 'run-report.json')));

// 7. fixtures/credentials.ts compiles (basic syntax shape).
const credsFixture = fs.readFileSync(path.join(frameworkDir, 'fixtures/credentials.ts'), 'utf8');
check('P. credentials fixture exports `credentials`', credsFixture.includes('export const credentials'));
check('Q. credentials fixture reads from env', credsFixture.includes('process.env.TEST_USERNAME'));

// 8. .gitignore covers the important things.
const gi = fs.readFileSync(path.join(frameworkDir, '.gitignore'), 'utf8');
check('R. .gitignore ignores node_modules', gi.includes('node_modules/'));
check('S. .gitignore ignores .env', gi.includes('.env'));
check('T. .gitignore ignores playwright/.auth', gi.includes('playwright/.auth/'));

// 9. ScaffoldResult reports what was written.
check('U. fileCount > 10 (sanity)', result.fileCount > 10);
check('V. frameworkDir matches outDir', result.frameworkDir === frameworkDir);

// 10. Idempotency — re-running produces identical content.
const firstPkg = fs.readFileSync(path.join(frameworkDir, 'package.json'), 'utf8');
const firstReadme = fs.readFileSync(path.join(frameworkDir, 'README.md'), 'utf8');
scaffold({
  report,
  outDir: frameworkDir,
  siteName: 'www.saucedemo.com',
  features: ['login'],
});
const secondPkg = fs.readFileSync(path.join(frameworkDir, 'package.json'), 'utf8');
const secondReadme = fs.readFileSync(path.join(frameworkDir, 'README.md'), 'utf8');
check('W. idempotent: package.json identical on re-run', firstPkg === secondPkg);
check('X. idempotent: README identical on re-run', firstReadme === secondReadme);

// Cleanup tmp dir.
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: scaffold emits a complete framework.');
