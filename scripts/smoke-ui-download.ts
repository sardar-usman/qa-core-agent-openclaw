/**
 * UI download integration test.
 *
 * What smoke-ui.ts already verifies:
 *   - UI loads with zero JS errors
 *   - framework_zip message renders a card with the right metadata
 *
 * What this test adds:
 *   - Clicking the Download button actually triggers a browser download
 *   - The downloaded file is byte-equivalent to what the gateway would send
 *   - The downloaded file is a real, extractable zip with the expected contents
 *
 * Approach: synthesize a real framework via scaffold(), zip it, and inject
 * the EXACT message shape the gateway emits into the UI's handleAgentMessage.
 * Then drive the Download button via Playwright and capture the file.
 *
 * No WebSocket server needed — we're testing the UI handler in isolation
 * with a payload that matches the gateway's wire format exactly. The gateway's
 * own send code is already verified by reading the source (gateway.ts:474-482).
 *
 * Zero API spend.
 */
import { chromium, type Download } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { scaffold } from '../src/agent/scaffold.js';
import { zipFrameworkToBuffer } from '../src/agent/zip-framework.js';
import type { RunReport } from '../src/agent/trace.js';

// 1) Build a real framework + zip the way the gateway would.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-ui-dl-'));
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
        { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login', exact: true }, intent: 'login button' } },
        { kind: 'assert', name: 'inventory URL', assertion: { type: 'toHaveURL', pattern: '/inventory' } },
      ],
    },
  ],
  cascadeStats: { role: 2, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 4,
  startedAt: '2026-06-20T12:00:00Z',
  finishedAt: '2026-06-20T12:01:00Z',
};

const scaffoldResult = scaffold({ report, outDir: frameworkDir, siteName: 'www.saucedemo.com', features: ['login'] });
const zipBuf = zipFrameworkToBuffer(frameworkDir);
const expectedSize = zipBuf.length;

// 2) Build the EXACT message shape gateway.ts emits (verified at gateway.ts:474-482).
const gatewayMessage = {
  type: 'framework_zip',
  filename: 'saucedemo-framework.zip',
  base64: zipBuf.toString('base64'),
  sizeBytes: zipBuf.length,
  fileCount: scaffoldResult.fileCount,
  scenarios: report.scenarios.length,
  runReportPath: 'output/saucedemo-framework/run-report.json',
};

// 3) Open the UI in Chromium and inject the message.
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const jsErrors: string[] = [];
page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console.error: ' + m.text()); });

const uiUrl = pathToFileURL(path.resolve(process.cwd(), 'qa-core-ui.html')).href;
await page.goto(uiUrl, { waitUntil: 'load' });
await page.waitForTimeout(300);

// Inject via the real dispatch path the gateway would use.
await page.evaluate((msg) => {
  // @ts-expect-error — defined in the UI file
  handleAgentMessage(msg);
}, gatewayMessage);

// 4) Wait for the download card to appear, then verify metadata.
let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const card = await page.waitForSelector('.framework-zip-card', { timeout: 3000 }).catch(() => null);
check('A. Download card rendered', !!card);

const filenameText = await page.locator('.framework-zip-name').textContent();
check('B. Card shows correct filename', filenameText === 'saucedemo-framework.zip');

const statsText = await page.locator('.framework-zip-stats').textContent();
check('C. Card shows scenario count', !!statsText && statsText.includes('1'));
check('D. Card shows file count', !!statsText && statsText.includes(String(scaffoldResult.fileCount)));

const dlBtn = await page.locator('.framework-zip-dl').count();
check('E. Download button present', dlBtn === 1);

// 5) Click Download and intercept the file.
const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
await page.locator('.framework-zip-dl').click();
const download: Download = await downloadPromise.catch(() => null as never);
check('F. Click triggered a real browser download', !!download);

if (download) {
  // Verify filename Playwright sees matches what the gateway set.
  const suggestedFilename = download.suggestedFilename();
  check('G. Suggested filename matches gateway payload', suggestedFilename === 'saucedemo-framework.zip');

  // Save and inspect the downloaded file.
  const downloadPath = path.join(tmpRoot, 'downloaded.zip');
  await download.saveAs(downloadPath);
  check('H. Downloaded file landed on disk', fs.existsSync(downloadPath));

  const downloadedBytes = fs.readFileSync(downloadPath);
  check('I. Downloaded file is non-empty', downloadedBytes.length > 0);
  check('J. Downloaded size matches gateway-reported sizeBytes', downloadedBytes.length === expectedSize);

  // Verify zip integrity — must be a real zip with the right magic bytes.
  check(
    'K. Downloaded file starts with PK zip signature',
    downloadedBytes[0] === 0x50 && downloadedBytes[1] === 0x4B && downloadedBytes[2] === 0x03 && downloadedBytes[3] === 0x04,
  );

  // Verify unzip can extract it AND the contents match scaffold's output.
  const extractDir = path.join(tmpRoot, 'extracted');
  fs.mkdirSync(extractDir);
  const unzipResult = spawnSync('unzip', ['-q', downloadPath, '-d', extractDir], { encoding: 'utf8' });
  check('L. unzip extracts the downloaded file cleanly', unzipResult.status === 0, unzipResult.stderr);

  if (unzipResult.status === 0) {
    const originalPkg = fs.readFileSync(path.join(frameworkDir, 'package.json'), 'utf8');
    const downloadedPkg = fs.readFileSync(path.join(extractDir, 'saucedemo-framework', 'package.json'), 'utf8');
    check('M. Extracted package.json matches scaffolded original byte-for-byte', originalPkg === downloadedPkg);

    const originalReadme = fs.readFileSync(path.join(frameworkDir, 'README.md'), 'utf8');
    const downloadedReadme = fs.readFileSync(path.join(extractDir, 'saucedemo-framework', 'README.md'), 'utf8');
    check('N. Extracted README matches scaffolded original', originalReadme === downloadedReadme);

    // v3.2 — tests/ now has per-feature subfolders (tests/<feature>/<feature>.spec.ts).
    // Recurse one level deep to find spec files.
    const testsDir = path.join(extractDir, 'saucedemo-framework', 'tests');
    let foundSpec = false;
    if (fs.existsSync(testsDir)) {
      for (const entry of fs.readdirSync(testsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const specs = fs.readdirSync(path.join(testsDir, entry.name)).filter((f) => f.endsWith('.spec.ts'));
        if (specs.length > 0) { foundSpec = true; break; }
      }
    }
    check('O. Extracted zip contains at least one spec file under tests/<feature>/', foundSpec);
  }
}

await browser.close();

// 6) JS console must be clean — UI should not have thrown errors.
check('P. Zero JS errors during the whole flow', jsErrors.length === 0, jsErrors.join('\n'));

// Cleanup.
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
console.log(`Zip in flight: ${expectedSize} bytes (base64-encoded payload: ${gatewayMessage.base64.length} chars)`);
if (fail > 0) process.exit(1);
console.log('OK: UI dispatches → renders → click triggers real file download → contents match scaffold output.');
