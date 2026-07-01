import fs from 'node:fs';
import path from 'node:path';
import type { RunReport } from './trace.js';
import { transcribePOM, type POMTranscribeResult } from './pom.js';
import { renderUniqueDataHelper } from './unique-data.js';

/**
 * Framework scaffolder.
 *
 * Wraps the existing POM emitter (pom.ts) with the additional files needed
 * to make the output a complete, standalone Playwright project. Honors the
 * language flag end-to-end:
 *
 *   --lang ts (default):                  --lang js:
 *     playwright.config.ts                  playwright.config.js (CommonJS)
 *     tsconfig.json                         (no tsconfig — pointless for JS)
 *     fixtures/credentials.ts               fixtures/credentials.js (CommonJS)
 *     helpers/assertions.ts                 helpers/assertions.js  (CommonJS + JSDoc types)
 *     helpers/unique-data.ts                helpers/unique-data.js (per-run unique email/token)
 *     pages/*.ts (from pom.ts)              pages/*.js (from pom.ts)
 *     tests/<feature>/*.spec.ts             tests/<feature>/*.spec.js
 *     tests/a11y/landing.a11y.spec.ts       tests/a11y/landing.a11y.spec.js
 *     package.json (incl. typescript dev)   package.json (no TS devDeps)
 *
 * Plus, in both languages:
 *     package.json, README.md, .gitignore, .env.example, run-report.json
 *
 * The user can `cd <out> && npm install && npx playwright test` immediately
 * regardless of which language they picked.
 *
 * Design rules:
 *   - pom.ts is the source of truth for pages/tests/a11y emission. We do not
 *     re-implement that logic here. We call it and add the project shell.
 *   - All file contents are derived from the RunReport — no LLM calls.
 *   - The scaffold is idempotent: re-running with the same RunReport
 *     produces byte-identical files.
 *   - JS path uses CommonJS (`require` / `module.exports`) so users do not
 *     need to set "type": "module". This matches Playwright's documented
 *     JS examples and "just works" out of the box.
 */

export interface ScaffoldOptions {
  /** The verified RunReport from the explore pipeline. `report.language` controls TS vs JS. */
  report: RunReport;
  /** The framework root directory to write into. Will be created. */
  outDir: string;
  /** Display name of the site, used in README and package.json name. */
  siteName: string;
  /** Feature names the run was scoped to (if any). Surfaced in README. */
  features?: string[];
}

export interface ScaffoldResult {
  frameworkDir: string;
  filesWritten: string[];
  fileCount: number;
  pomResult: POMTranscribeResult;
  language: 'ts' | 'js';
}

/** Runtime dependencies pinned into every generated framework. */
const RUNTIME_DEPS = {
  '@playwright/test': '~1.60.0',
  '@axe-core/playwright': '^4.10.0',
} as const;

/** Dev dependencies — TypeScript-only. JS frameworks ship without these. */
const TS_DEV_DEPS = {
  '@types/node': '^22.0.0',
  typescript: '^5.6.0',
} as const;

export function scaffold(opts: ScaffoldOptions): ScaffoldResult {
  fs.mkdirSync(opts.outDir, { recursive: true });

  const lang = opts.report.language;
  const ext = lang;

  // 1. Let pom.ts emit pages/ and tests/ (including tests/a11y/) — pom
  //    respects report.language for file extensions and import syntax already.
  const specName = slugify(opts.siteName);
  const pomResult = transcribePOM({
    report: opts.report,
    outDir: opts.outDir,
    name: specName,
  });

  // 2. Write the framework shell. Each file is plain text derived from the
  //    report — no LLM, no dynamic generation.
  const written: string[] = [];
  const writeFile = (relPath: string, contents: string): void => {
    const full = path.join(opts.outDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
    written.push(relPath);
  };

  writeFile('package.json', renderPackageJson(opts, lang));
  writeFile(`playwright.config.${ext}`, renderPlaywrightConfig(opts, lang));
  if (lang === 'ts') {
    writeFile('tsconfig.json', renderTsConfig());
  }
  writeFile('.gitignore', renderGitignore());
  writeFile('.env.example', renderEnvExample(opts));
  writeFile(`fixtures/credentials.${ext}`, renderCredentialsFixture(opts, lang));
  writeFile(`helpers/assertions.${ext}`, renderAssertionsHelper(lang));
  writeFile(`helpers/unique-data.${ext}`, renderUniqueDataHelper(lang));
  writeFile('README.md', renderReadme(opts, pomResult, lang));

  // Self-sufficient framework dir: write run-report.json here too.
  writeFile('run-report.json', JSON.stringify(opts.report, null, 2));

  // pom.ts wrote pages/, tests/<feature>/, tests/a11y/. run-report.json is
  // already in `written` above, so don't list it twice. specFiles is an array
  // (one per feature group) — spread it in.
  const pomFiles = [
    ...pomResult.pageFiles,
    ...pomResult.specFiles,
    pomResult.a11yFile,
  ].map((p) => path.relative(opts.outDir, p));

  const allFiles = [...written, ...pomFiles];
  return {
    frameworkDir: opts.outDir,
    filesWritten: allFiles,
    fileCount: allFiles.length,
    pomResult,
    language: lang,
  };
}

/* ───────────────────────── helpers ───────────────────────── */

function slugify(s: string): string {
  return s
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase();
}

/**
 * Compact brand slug used as the framework directory's leading token.
 *   "https://www.saucedemo.com/"          → "saucedemo"
 *   "https://the-internet.herokuapp.com"  → "the-internet-herokuapp"
 *   "https://demo.playwright.dev"         → "demo-playwright"
 *   "https://practicesoftwaretesting.com" → "practicesoftwaretesting"
 *
 * Rule: strip the protocol + `www.` prefix, drop the last dotted segment
 * (the TLD), replace remaining dots with hyphens, and clean up.
 *
 * The full framework directory name is `<brandSlug>-automation-framework`.
 */
export function brandSlug(input: string): string {
  let host: string;
  try { host = new URL(input).hostname; } catch { host = input.replace(/^https?:\/\//i, '').split('/')[0] ?? input; }
  host = host.toLowerCase().replace(/^www\./, '');
  const parts = host.split('.');
  if (parts.length > 1) parts.pop(); // drop TLD
  return parts.join('-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'site';
}

/** Convenience: full framework directory name for a given site URL. */
export function frameworkDirName(siteUrl: string): string {
  return `${brandSlug(siteUrl)}-automation-framework`;
}

export type UrlValidation =
  | { ok: true; url: string; normalized: boolean }
  | { ok: false; reason: string };

/**
 * Validate + normalize a URL for /explore (and the CLI equivalent).
 *
 * Accepts:
 *   "https://shop.com"          → ok
 *   "http://localhost:3000"     → ok
 *   "shop.com"                  → ok (auto-prepended https://; normalized=true)
 *   "www.shop.com/cart"         → ok (auto-prepended https://; normalized=true)
 *
 * Rejects:
 *   ""                           → reason: empty
 *   "--", "?", "(ts)", "-"       → reason: doesn't look like a URL
 *   "ftp://shop.com"             → reason: only http(s) supported
 *   "javascript:alert(1)"        → reason: only http(s) supported
 *   "https://"                   → reason: missing hostname
 *
 * We do NOT verify the host actually resolves — that's the Planner's job
 * (it'll fail fast with a navigation error). We only filter out things that
 * obviously can't be URLs so the agent stops wasting tokens on garbage input.
 */
export function normalizeAndValidateUrl(input: string): UrlValidation {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, reason: "the URL is empty" };

  // Reject obvious non-URL tokens: dashes, parens, single chars, pure punctuation.
  if (/^[-_.,;:!?()[\]{}'"]+$/.test(raw)) {
    return { ok: false, reason: `"${raw}" doesn't look like a URL — try something like https://www.example.com/` };
  }

  // Auto-prepend https:// if the user just typed a bare host like "shop.com".
  // Only do this when the input clearly looks like a host (has a dot, no spaces).
  let candidate = raw;
  let normalized = false;
  if (!/^https?:\/\//i.test(candidate)) {
    if (/^[a-z0-9][\w.-]*\.[a-z]{2,}/i.test(candidate) && !/\s/.test(candidate)) {
      candidate = 'https://' + candidate;
      normalized = true;
    } else {
      return { ok: false, reason: `"${raw}" doesn't start with http:// or https://` };
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: `"${raw}" isn't a valid URL` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `only http:// and https:// URLs are supported (got ${parsed.protocol})` };
  }

  if (!parsed.hostname) {
    return { ok: false, reason: `"${raw}" is missing a hostname` };
  }

  // Reject hostnames with no dot AND not localhost — catches "https://foo" type
  // inputs that parse but won't resolve to anything.
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
    return { ok: false, reason: `"${parsed.hostname}" doesn't look like a real hostname` };
  }

  return { ok: true, url: parsed.toString(), normalized };
}

function renderPackageJson(opts: ScaffoldOptions, lang: 'ts' | 'js'): string {
  const obj: Record<string, unknown> = {
    name: slugify(opts.siteName) + '-tests',
    version: '0.1.0',
    description: `Playwright test framework for ${opts.siteName}, generated by QA-Core.`,
    private: true,
    scripts: {
      test: 'playwright test',
      'test:ui': 'playwright test --ui',
      'test:report': 'playwright show-report',
      'test:headed': 'playwright test --headed',
      'test:debug': 'playwright test --debug',
    },
    dependencies: RUNTIME_DEPS,
  };
  // Only TS frameworks need a typescript + @types/node dev install.
  if (lang === 'ts') {
    obj.devDependencies = TS_DEV_DEPS;
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

function renderPlaywrightConfig(opts: ScaffoldOptions, lang: 'ts' | 'js'): string {
  const baseUrl = opts.report.url;
  if (lang === 'js') {
    // CommonJS so users don't need "type": "module" in package.json.
    // // @ts-check lets editors give JSDoc-based IntelliSense if they want it.
    return `// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright configuration for ${opts.siteName}.
 * Generated by QA-Core.
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.BASE_URL || ${JSON.stringify(baseUrl)},
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Uncomment to add cross-browser coverage:
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit',  use: { ...devices['Desktop Safari'] } },
  ],
});
`;
  }
  // TypeScript path — ES module syntax.
  return `import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for ${opts.siteName}.
 * Generated by QA-Core.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.BASE_URL || ${JSON.stringify(baseUrl)},
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Uncomment to add cross-browser coverage:
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit',  use: { ...devices['Desktop Safari'] } },
  ],
});
`;
}

function renderTsConfig(): string {
  const obj = {
    compilerOptions: {
      target: 'ES2022',
      module: 'commonjs',
      lib: ['ES2022', 'DOM'],
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      strict: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      moduleResolution: 'node',
      types: ['node'],
    },
    include: ['pages/**/*.ts', 'tests/**/*.ts', 'fixtures/**/*.ts', 'helpers/**/*.ts'],
  };
  return JSON.stringify(obj, null, 2) + '\n';
}

function renderGitignore(): string {
  return `# Node
node_modules/
npm-debug.log*

# Playwright
test-results/
playwright-report/
blob-report/
playwright/.cache/
playwright/.auth/

# Env
.env
.env.local

# OS
.DS_Store
Thumbs.db
`;
}

function renderEnvExample(opts: ScaffoldOptions): string {
  return `# Base URL the tests run against. Override locally to point at staging.
BASE_URL=${opts.report.url}

# Optional: credentials for auth-gated tests.
# These are consumed by fixtures/credentials.{ts,js}.
# TEST_USERNAME=your_user
# TEST_PASSWORD=your_password
`;
}

function renderCredentialsFixture(opts: ScaffoldOptions, lang: 'ts' | 'js'): string {
  // Seed example usernames from any fill steps in the trace (best-effort,
  // passwords are never surfaced).
  const seenUsernames = new Set<string>();
  for (const scenario of opts.report.scenarios) {
    for (const step of scenario.steps) {
      if (step.kind === 'fill') {
        const intent = step.target.intent.toLowerCase();
        if (/(user|email|login)/.test(intent) && !/password/.test(intent)) {
          seenUsernames.add(step.value);
        }
      }
    }
  }
  const seedComment = seenUsernames.size > 0
    ? `// Usernames observed during exploration:\n//   ${[...seenUsernames].slice(0, 5).join(', ')}`
    : '// No credentials were observed during exploration.';

  if (lang === 'js') {
    return `/**
 * Test credentials.
 *
 * Pull from env vars first, fall back to placeholder strings so the tests
 * compile even when env is unset. Replace the placeholders OR set the env
 * vars before running auth-gated tests.
 *
 * ${seedComment}
 */
module.exports = {
  credentials: {
    username: process.env.TEST_USERNAME || 'REPLACE_ME_USERNAME',
    password: process.env.TEST_PASSWORD || 'REPLACE_ME_PASSWORD',
  },
};
`;
  }
  // TypeScript path.
  return `/**
 * Test credentials.
 *
 * Pull from env vars first, fall back to placeholder strings so the tests
 * compile even when env is unset. Replace the placeholders OR set the env
 * vars before running auth-gated tests.
 *
 * ${seedComment}
 */
export const credentials = {
  username: process.env.TEST_USERNAME || 'REPLACE_ME_USERNAME',
  password: process.env.TEST_PASSWORD || 'REPLACE_ME_PASSWORD',
};
`;
}

function renderAssertionsHelper(lang: 'ts' | 'js'): string {
  if (lang === 'js') {
    // CommonJS + JSDoc types. `// @ts-check` lets the editor give JSDoc-based
    // IntelliSense for users who want it; no TypeScript installation needed.
    return `// @ts-check
const { expect } = require('@playwright/test');

/**
 * Custom assertion helpers.
 *
 * Add project-specific helpers here as your suite grows. The two below are
 * common patterns that show up across most Playwright frameworks.
 */

/**
 * Wait for the URL to change away from a given path. Useful after form submits.
 * @param {import('@playwright/test').Page} page
 * @param {string} fromPath
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<void>}
 */
async function expectUrlChanged(page, fromPath, timeoutMs = 5000) {
  await expect.poll(() => page.url(), { timeout: timeoutMs }).not.toContain(fromPath);
}

/**
 * Assert a locator contains text matching any of several candidates.
 * @param {import('@playwright/test').Locator} locator
 * @param {string[]} candidates
 * @returns {Promise<void>}
 */
async function expectAnyText(locator, candidates) {
  const actual = (await locator.textContent()) ?? '';
  const match = candidates.some((c) => actual.includes(c));
  expect(match, \`expected text to contain one of [\${candidates.join(', ')}], got: \${actual}\`).toBe(true);
}

module.exports = { expectUrlChanged, expectAnyText };
`;
  }
  // TypeScript path.
  return `import { expect, type Page, type Locator } from '@playwright/test';

/**
 * Custom assertion helpers.
 *
 * Add project-specific helpers here as your suite grows. The two below are
 * common patterns that show up across most Playwright frameworks.
 */

/** Wait for the URL to change away from a given path. Useful after form submits. */
export async function expectUrlChanged(page: Page, fromPath: string, timeoutMs = 5000): Promise<void> {
  await expect.poll(() => page.url(), { timeout: timeoutMs }).not.toContain(fromPath);
}

/** Assert a locator contains text matching any of several candidates. */
export async function expectAnyText(locator: Locator, candidates: string[]): Promise<void> {
  const actual = (await locator.textContent()) ?? '';
  const match = candidates.some(c => actual.includes(c));
  expect(match, \`expected text to contain one of [\${candidates.join(', ')}], got: \${actual}\`).toBe(true);
}
`;
}

function renderReadme(opts: ScaffoldOptions, pomResult: POMTranscribeResult, lang: 'ts' | 'js'): string {
  const ext = lang;
  const langLabel = lang === 'ts' ? 'TypeScript' : 'JavaScript';

  const featureBlock = opts.features && opts.features.length > 0
    ? `## Features covered

This framework was scoped to these features:
${opts.features.map((f) => `- \`${f}\``).join('\n')}
`
    : `## What was tested

The agent scanned the landing page and produced ${pomResult.scenarios} verified scenarios covering the highest-signal flows it could find.
`;

  const verdictBlock = opts.report.review?.summary
    ? `## Critic summary

> ${opts.report.review.summary.split('\n').join('\n> ')}
`
    : '';

  const replayBlock = opts.report.replay && !opts.report.replay.skipped
    ? `## Verification

Every scenario in this framework passed:
- 1× live exploration (recorded by Opus, verified by Sonnet)
- 1× independent reality-check replay
- ${opts.report.stability?.iterations ?? 3}× stability re-runs

Stability flake_rate: ${((opts.report.stability?.flakeRate ?? 0) * 100).toFixed(1)}%
`
    : '';

  // Project layout — explicitly reflects the language used.
  const tsconfigLine = lang === 'ts' ? '├── tsconfig.json\n' : '';

  return `# ${opts.siteName} — Playwright test framework (${langLabel})

Generated by [QA-Core](https://github.com/sardarusmanjutt/qa-core-agent) on ${opts.report.startedAt.slice(0, 10)}.

Target: ${opts.report.url}

${featureBlock}
## Quick start

\`\`\`bash
npm install
npx playwright install chromium
npx playwright test
\`\`\`

Open the HTML report after a run:

\`\`\`bash
npx playwright show-report
\`\`\`

## Project layout

\`\`\`
.
├── package.json
├── playwright.config.${ext}
${tsconfigLine}├── pages/                      # Page Object Model classes
│   ├── BasePage.${ext}
│   └── <feature>-page.${ext}
├── tests/                      # Generated scenarios — runs via \`npx playwright test\`
│   ├── <feature>/
│   │   └── <feature>.spec.${ext}
│   └── a11y/                   # Auto-injected accessibility check (axe-core)
│       └── landing.a11y.spec.${ext}
├── fixtures/
│   └── credentials.${ext}          # Test data (replace placeholders)
├── helpers/
│   └── assertions.${ext}           # Reusable custom matchers
└── run-report.json             # Original QA-Core run report (cost, cascade, verdicts)
\`\`\`

## Credentials

Auth-gated tests pull from environment variables. Copy \`.env.example\` to \`.env\` and fill in:

\`\`\`bash
cp .env.example .env
# edit .env with your real values
\`\`\`

${verdictBlock}${replayBlock}
## Adding more tests

This framework was generated from a single \`/explore\` run. To extend it:

1. Add a new \`.spec.${ext}\` file under \`tests/\` that imports the relevant page object from \`pages/\`.
2. Run \`npx playwright test\` to verify.

To regenerate the framework against the same URL (e.g. after a UI change), re-run the QA-Core agent:

\`\`\`bash
qa-core explore ${opts.report.url}
\`\`\`

---

_Framework scaffolding generated by QA-Core. Pages and tests transcribed from a verified browser session._
`;
}
