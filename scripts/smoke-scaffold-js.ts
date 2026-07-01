/**
 * JS-path scaffold verification.
 *
 * Mirrors smoke-scaffold.ts but with `language: 'js'` on the RunReport.
 * Asserts:
 *   - Correct files exist with .js extensions (config, fixtures, helpers)
 *   - tsconfig.json is NOT emitted (pointless for JS)
 *   - package.json does NOT include typescript / @types/node devDeps
 *   - JS files use CommonJS syntax (require / module.exports) — no `import`/`export`
 *   - playwright.config.js compiles as valid JS (we eval it after stubbing
 *     `@playwright/test`'s defineConfig to confirm no syntax errors)
 *   - README references .js extensions in the project layout
 *
 * No network, no LLM, no API spend.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scaffold } from '../src/agent/scaffold.js';
import type { RunReport } from '../src/agent/trace.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-scaffold-js-'));
const frameworkDir = path.join(tmpRoot, 'saucedemo-framework-js');

const report: RunReport = {
  url: 'https://www.saucedemo.com/',
  language: 'js',   // <-- the change vs smoke-scaffold.ts
  scenarios: [
    {
      name: 'logged in with valid credentials',
      category: 'happy',
      steps: [
        { kind: 'navigate', url: 'https://www.saucedemo.com/' },
        { kind: 'fill', target: { level: 'role', arg: { role: 'textbox', name: 'Username', exact: true }, intent: 'username input' }, value: 'standard_user' },
        { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login', exact: true }, intent: 'login button' } },
        { kind: 'assert', name: 'URL', assertion: { type: 'toHaveURL', pattern: '/inventory' } },
      ],
    },
  ],
  cascadeStats: { role: 2, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 4,
  startedAt: '2026-06-22T12:00:00Z',
  finishedAt: '2026-06-22T12:01:00Z',
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

// 1. Required files with .js extensions exist.
const required = [
  'package.json',
  'playwright.config.js',
  '.gitignore',
  '.env.example',
  'fixtures/credentials.js',
  'helpers/assertions.js',
  'README.md',
];
for (const f of required) {
  check(`A. JS file exists: ${f}`, fs.existsSync(path.join(frameworkDir, f)));
}

// 2. Files that should NOT exist on JS path.
const forbidden = [
  'playwright.config.ts',
  'tsconfig.json',
  'fixtures/credentials.ts',
  'helpers/assertions.ts',
];
for (const f of forbidden) {
  check(`B. NOT present on JS path: ${f}`, !fs.existsSync(path.join(frameworkDir, f)));
}

// 3. ScaffoldResult correctly reports language.
check('C. ScaffoldResult.language === js', result.language === 'js');

// 4. package.json — TS devDeps must NOT be present.
const pkg = JSON.parse(fs.readFileSync(path.join(frameworkDir, 'package.json'), 'utf8')) as Record<string, unknown>;
const deps = pkg.dependencies as Record<string, string>;
const devDeps = pkg.devDependencies as Record<string, string> | undefined;
check('D. dependencies includes @playwright/test', !!deps?.['@playwright/test']);
check('E. dependencies includes @axe-core/playwright', !!deps?.['@axe-core/playwright']);
check('F. devDependencies has NO typescript', !devDeps || !devDeps['typescript']);
check('G. devDependencies has NO @types/node', !devDeps || !devDeps['@types/node']);

// 5. playwright.config.js uses CommonJS — `require` + `module.exports`.
const pwConfig = fs.readFileSync(path.join(frameworkDir, 'playwright.config.js'), 'utf8');
check('H. playwright.config.js uses require()', /\brequire\(['"]@playwright\/test['"]\)/.test(pwConfig));
check('I. playwright.config.js uses module.exports', /module\.exports\s*=/.test(pwConfig));
check('J. playwright.config.js does NOT use ESM import', !/^import\s/m.test(pwConfig));
check('K. playwright.config.js does NOT use export default', !/^export\s+default/m.test(pwConfig));
check('L. playwright.config.js mentions the target URL', pwConfig.includes('https://www.saucedemo.com/'));

// 6. fixtures/credentials.js uses CommonJS.
const credsJs = fs.readFileSync(path.join(frameworkDir, 'fixtures/credentials.js'), 'utf8');
check('M. credentials.js uses module.exports', /module\.exports\s*=/.test(credsJs));
check('N. credentials.js does NOT use export const', !/^export\s+const/m.test(credsJs));
check('O. credentials.js reads from env', credsJs.includes('process.env.TEST_USERNAME'));

// 7. helpers/assertions.js uses CommonJS + JSDoc types.
const assertJs = fs.readFileSync(path.join(frameworkDir, 'helpers/assertions.js'), 'utf8');
check('P. assertions.js uses require()', /\brequire\(['"]@playwright\/test['"]\)/.test(assertJs));
check('Q. assertions.js uses module.exports', /module\.exports\s*=/.test(assertJs));
check('R. assertions.js does NOT use TS type imports', !/import\s+{[^}]*type\s+/.test(assertJs));
check('S. assertions.js has @ts-check directive', assertJs.includes('// @ts-check'));
check('T. assertions.js uses JSDoc Page type', /@param\s+\{import\(['"]@playwright\/test['"]\)\.Page\}/.test(assertJs));

// 8. README references .js in the project layout.
const readme = fs.readFileSync(path.join(frameworkDir, 'README.md'), 'utf8');
check('U. README mentions JavaScript', /JavaScript/.test(readme));
check('V. README project layout references playwright.config.js', /playwright\.config\.js/.test(readme));
check('W. README does NOT mention tsconfig.json', !readme.includes('tsconfig.json'));
check('X. README references .spec.js extension', /\.spec\.js/.test(readme));

// 9. POM files (from pom.ts) also use .js extensions.
const pages = fs.readdirSync(path.join(frameworkDir, 'pages'));
check('Y. pages/ contains .js files', pages.every((f) => f.endsWith('.js')) && pages.length > 0);
// v3.2 — tests/ now has per-feature subfolders. Recurse one level deep.
const testsRoot = path.join(frameworkDir, 'tests');
const testFolderEntries = fs.readdirSync(testsRoot, { withFileTypes: true });
const testFeatureFolders = testFolderEntries.filter((e) => e.isDirectory());
check('Z. tests/ contains at least one per-feature subfolder', testFeatureFolders.length > 0);
let foundJsSpec = false;
for (const folder of testFeatureFolders) {
  const specs = fs.readdirSync(path.join(testsRoot, folder.name)).filter((f) => f.endsWith('.spec.js'));
  if (specs.length > 0) foundJsSpec = true;
}
check('Z2. tests/<feature>/ contains at least one .spec.js file', foundJsSpec);
// v3.3 — a11y moved inside tests/ so playwright's default testDir picks it up.
const a11y = fs.readdirSync(path.join(frameworkDir, 'tests', 'a11y'));
check('AA. tests/a11y/ contains .js files', a11y.every((f) => f.endsWith('.spec.js')) && a11y.length > 0);
check('AA1. legacy top-level a11y/ directory does NOT exist on JS path', !fs.existsSync(path.join(frameworkDir, 'a11y')));

// 10. JS config syntactically loads (eval after stubbing the dependency).
//     This catches obvious syntax errors in the generated config.
const syntaxCheckOk = (() => {
  try {
    // Stub @playwright/test for the eval — we only care about syntax.
    const sandbox = {
      module: { exports: {} as Record<string, unknown> },
      require: (mod: string) => {
        if (mod === '@playwright/test') {
          return { defineConfig: (cfg: unknown) => cfg, devices: { 'Desktop Chrome': {} } };
        }
        throw new Error('unexpected require: ' + mod);
      },
      process: { env: {}, env_BASE_URL: undefined },
    };
    // eslint-disable-next-line no-new-func
    const fn = new Function('module', 'require', 'process', pwConfig);
    fn(sandbox.module, sandbox.require, sandbox.process);
    return typeof sandbox.module.exports === 'object';
  } catch {
    return false;
  }
})();
check('AB. playwright.config.js parses + evals without syntax errors', syntaxCheckOk);

// 11. Idempotency — re-running produces identical content on the JS path too.
const firstPkg = fs.readFileSync(path.join(frameworkDir, 'package.json'), 'utf8');
const firstReadme = fs.readFileSync(path.join(frameworkDir, 'README.md'), 'utf8');
scaffold({ report, outDir: frameworkDir, siteName: 'www.saucedemo.com', features: ['login'] });
const secondPkg = fs.readFileSync(path.join(frameworkDir, 'package.json'), 'utf8');
const secondReadme = fs.readFileSync(path.join(frameworkDir, 'README.md'), 'utf8');
check('AC. idempotent: JS package.json identical on re-run', firstPkg === secondPkg);
check('AD. idempotent: JS README identical on re-run', firstReadme === secondReadme);

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: scaffold emits a clean JavaScript framework when language=js.');
