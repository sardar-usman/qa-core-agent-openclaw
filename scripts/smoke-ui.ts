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
await browser.close();
console.log(JSON.stringify({ errors, hasStabilityRow, hasStatsContainer }, null, 2));
process.exit(errors.length ? 1 : 0);
