import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const url = pathToFileURL(path.resolve(process.cwd(), 'qa-core-ui.html')).href;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text());
});
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(500);
const hasStabilityRow = (await page.locator('#pipeStability').count()) === 1;
const hasStatsContainer = (await page.locator('#pipeStabilityStats').count()) === 1;

// v3 — simulate the gateway sending a framework_zip message and verify the
// UI renders a download card with the right metadata and a working download
// trigger. We construct a tiny but VALID zip in the page so the decoded
// bytes are byte-equal to a real zip.
//
// The fixture is the smallest possible zip — an empty central directory
// preceded by no local file headers. It's a valid zip per spec.
const downloadResult = await page.evaluate(async () => {
  // 22-byte "end of central directory" record with zero entries.
  const eocd = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06,   // signature 0x06054b50
    0, 0,                       // disk number
    0, 0,                       // disk where central dir starts
    0, 0,                       // entries on this disk
    0, 0,                       // total entries
    0, 0, 0, 0,                 // central dir size
    0, 0, 0, 0,                 // central dir offset
    0, 0,                       // comment length
  ]);
  let bin = '';
  for (let i = 0; i < eocd.length; i++) bin += String.fromCharCode(eocd[i]!);
  const base64 = btoa(bin);
  const fakeMessage = {
    type: 'framework_zip',
    filename: 'sample-framework.zip',
    base64,
    sizeBytes: eocd.length,
    fileCount: 13,
    scenarios: 5,
    runReportPath: 'output/sample-framework/run-report.json',
  };
  // Trigger the gateway's onmessage path directly.
  // @ts-expect-error — handleAgentMessage is defined in the UI file
  handleAgentMessage(fakeMessage);
  // Wait one tick for DOM update.
  await new Promise((r) => setTimeout(r, 50));
  const card = document.querySelector('.framework-zip-card');
  const nameEl = document.querySelector('.framework-zip-name');
  const dl = document.querySelector('.framework-zip-dl');
  return {
    cardRendered: !!card,
    filenameShown: nameEl?.textContent ?? null,
    downloadBtnPresent: !!dl,
    statsText: document.querySelector('.framework-zip-stats')?.textContent ?? null,
  };
});

await browser.close();
console.log(JSON.stringify({ errors, hasStabilityRow, hasStatsContainer, downloadResult }, null, 2));

// Hard assertions on the new behaviour.
let failed = errors.length > 0;
if (!downloadResult.cardRendered) { console.error('FAIL: framework-zip-card did not render'); failed = true; }
if (downloadResult.filenameShown !== 'sample-framework.zip') { console.error('FAIL: filename not shown'); failed = true; }
if (!downloadResult.downloadBtnPresent) { console.error('FAIL: download button not present'); failed = true; }
if (!downloadResult.statsText?.includes('5')) { console.error('FAIL: scenarios count not shown'); failed = true; }
if (!downloadResult.statsText?.includes('13')) { console.error('FAIL: file count not shown'); failed = true; }

if (failed) process.exit(1);
console.log('OK: UI renders framework_zip download card with correct metadata.');
