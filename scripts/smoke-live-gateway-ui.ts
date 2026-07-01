/**
 * Full live integration: real gateway + real UI + real /explore against
 * saucedemo + real download click + real file verification.
 *
 * This is the test the user asked for. It costs ~$0.20-0.60 in Anthropic API
 * tokens (one full /explore run) and takes 2-5 minutes wall clock.
 *
 * Approach:
 *   1. Connect Playwright to qa-core-ui.html (assumes gateway is already
 *      running on ws://127.0.0.1:18789 — the harness starts it externally).
 *   2. Click Connect in the UI.
 *   3. Type /explore https://www.saucedemo.com/ --features login into the
 *      chat input. Submit.
 *   4. Wait for the framework_zip download card to appear (up to 6 min — the
 *      full 5-stage pipeline runs in the gateway).
 *   5. Click the Download button. Capture the file via Playwright's download
 *      event.
 *   6. Verify the downloaded zip is real, extractable, contains the expected
 *      framework files.
 *
 * Cleanup: this script does not start or stop the gateway. The caller orchestrates that.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const UI_PATH = path.resolve(process.cwd(), 'qa-core-ui.html');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-live-'));
const DL_PATH = path.join(TMP, 'downloaded.zip');

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

console.log('=== Live gateway + UI + /explore integration ===');
console.log(`UI: ${UI_PATH}`);
console.log(`Tmp: ${TMP}`);
console.log('');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const jsErrors: string[] = [];
page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  // Strip benign "extension" / "favicon" noise; surface real errors only.
  const t = m.text();
  if (m.type() === 'error' && !/favicon|chrome-extension/.test(t)) jsErrors.push('console.error: ' + t);
});

try {
  await page.goto(pathToFileURL(UI_PATH).href, { waitUntil: 'load' });
  await page.waitForTimeout(300);

  // 1) Click Connect.
  console.log('▸ Connecting to ws://127.0.0.1:18789 ...');
  await page.click('.connect-btn');

  // Wait for the gateway-pill state to flip to "connected" via the toast or status.
  // Status dot picks up `.live` class when connected; do that as our signal.
  await page.waitForSelector('#statusDot.live', { timeout: 8000 });
  check('A. UI connected to gateway', true);

  // Drop any earlier "Connected" toast.
  await page.waitForTimeout(500);

  // 2) Type the explore command and submit.
  const cmd = '/explore https://www.saucedemo.com/ --features login';
  console.log(`▸ Sending: ${cmd}`);
  await page.fill('#msgInput', cmd);
  await page.click('.send-btn');

  // 3) Wait for the download card. Generous timeout — full pipeline runs here.
  console.log('▸ Waiting for /explore pipeline to finish + download card (up to 8 min)...');
  const cardLocator = page.locator('.framework-zip-card').last();
  await cardLocator.waitFor({ state: 'visible', timeout: 8 * 60 * 1000 });
  check('B. Framework download card rendered after live /explore', true);

  // 4) Pull card metadata.
  const filename = await cardLocator.locator('.framework-zip-name').textContent() ?? '';
  const stats = await cardLocator.locator('.framework-zip-stats').textContent() ?? '';
  console.log(`  card filename: ${filename}`);
  console.log(`  card stats:    ${stats.replace(/\s+/g, ' ').trim()}`);
  check('C. Card filename present', filename.length > 0);
  check('D. Card stats include "scenarios" + "files"', /scenarios/.test(stats) && /files/.test(stats));
  check('E. Card filename matches expected slug', filename.includes('www-saucedemo-com-framework') && filename.endsWith('.zip'));

  // 5) Click Download and capture the file.
  console.log('▸ Clicking Download...');
  const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
  await cardLocator.locator('.framework-zip-dl').click();
  const download = await downloadPromise;
  check('F. Click triggered a real browser download', !!download);
  check('G. Suggested filename matches card filename', download.suggestedFilename() === filename);

  await download.saveAs(DL_PATH);
  check('H. Downloaded file landed on disk', fs.existsSync(DL_PATH));

  const bytes = fs.readFileSync(DL_PATH);
  check('I. Downloaded file non-empty', bytes.length > 0);
  check(
    'J. First 4 bytes are PK zip signature',
    bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04,
  );
  console.log(`  downloaded size: ${bytes.length} bytes`);

  // 6) Extract and inspect.
  const extractDir = path.join(TMP, 'extracted');
  fs.mkdirSync(extractDir);
  const unzip = spawnSync('unzip', ['-q', DL_PATH, '-d', extractDir], { encoding: 'utf8' });
  check('K. unzip extracts cleanly', unzip.status === 0, unzip.stderr);

  // Locate the framework root inside the extract (one top-level dir).
  const topEntries = fs.readdirSync(extractDir).filter((e) => fs.statSync(path.join(extractDir, e)).isDirectory());
  check('L. Zip has exactly one top-level dir', topEntries.length === 1);
  const fwRoot = path.join(extractDir, topEntries[0] ?? '');

  for (const expected of [
    'package.json',
    'playwright.config.ts',
    'tsconfig.json',
    'README.md',
    '.gitignore',
    '.env.example',
    'fixtures/credentials.ts',
    'helpers/assertions.ts',
    'run-report.json',
  ]) {
    check(`M. Extracted contains ${expected}`, fs.existsSync(path.join(fwRoot, expected)));
  }
  const hasPagesDir = fs.existsSync(path.join(fwRoot, 'pages')) && fs.statSync(path.join(fwRoot, 'pages')).isDirectory();
  const hasTestsDir = fs.existsSync(path.join(fwRoot, 'tests')) && fs.statSync(path.join(fwRoot, 'tests')).isDirectory();
  const hasA11yDir = fs.existsSync(path.join(fwRoot, 'a11y')) && fs.statSync(path.join(fwRoot, 'a11y')).isDirectory();
  check('N. Extracted contains pages/, tests/, a11y/', hasPagesDir && hasTestsDir && hasA11yDir);

  const pkg = JSON.parse(fs.readFileSync(path.join(fwRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  const deps = pkg.dependencies as Record<string, string>;
  check('O. package.json pins Playwright to ~1.60 (the v3 hotfix)', deps['@playwright/test']?.startsWith('~1.60') === true);

  // 7) Confirm the gateway's framework dir exists on disk too.
  const onDiskFw = path.join(process.cwd(), 'output', 'www-saucedemo-com-framework');
  const onDiskZip = path.join(process.cwd(), 'output', 'www-saucedemo-com-framework.zip');
  // The CLI writes a .zip beside the dir; the gateway path does NOT — it only streams
  // the zip via WebSocket. So we expect the directory only.
  check('P. Gateway wrote the framework dir to disk too', fs.existsSync(onDiskFw));
  console.log(`  (note: gateway path does not write a sibling .zip — that's CLI-only)`);
  void onDiskZip;

  // 8) JS console clean.
  check('Q. Zero JS errors during whole flow', jsErrors.length === 0, jsErrors.join('\n'));

} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: Full live gateway + UI + /explore + download verified end-to-end.');
