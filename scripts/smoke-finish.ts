/**
 * Verify the finish() guard:
 *   - finish with a scenario that has assertions  → kept
 *   - finish with a scenario that has only navigate/wait/click steps → dropped
 *
 * Runs entirely against a static inline page, no network needed.
 */
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

const html = `
<!doctype html><html><body>
<h1>Demo</h1>
<input id="q" name="q" placeholder="Search">
<button>Submit</button>
</body></html>`;

async function withPage<T>(fn: (page: import('playwright').Page) => Promise<T>): Promise<T> {
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

// Case A — incomplete scenario (only a wait), should be dropped on finish.
const caseA = await withPage(async (page) => {
  const tc = createContext(page, 20);
  await runTool(tc, { name: 'begin_scenario', input: { name: 'abandoned scenario', category: 'happy' } });
  await runTool(tc, { name: 'wait', input: { ms: 50 } });
  const fin = await runTool(tc, { name: 'finish', input: { summary: 'gave up' } });
  return { fin, scenarios: tc.scenarios.length };
});

// Case B — complete scenario (with an assertion), should be kept on finish.
const caseB = await withPage(async (page) => {
  const tc = createContext(page, 20);
  await runTool(tc, { name: 'begin_scenario', input: { name: 'real scenario', category: 'happy' } });
  await runTool(tc, { name: 'assert', input: { type: 'toBeVisible', intent: 'submit button', role: 'button', label: 'Submit' } });
  const fin = await runTool(tc, { name: 'finish', input: { summary: 'ok' } });
  return { fin, scenarios: tc.scenarios.length };
});

console.log('Case A (incomplete):', JSON.stringify(caseA, null, 2));
console.log('Case B (complete):  ', JSON.stringify(caseB, null, 2));

let ok = true;
if (caseA.scenarios !== 0) { console.error('FAIL: incomplete scenario was NOT dropped'); ok = false; }
const aData = caseA.fin.data as { droppedIncomplete?: number; scenarios?: number };
if (aData?.droppedIncomplete !== 1) { console.error('FAIL: finish did not report droppedIncomplete=1'); ok = false; }
if (caseB.scenarios !== 1) { console.error('FAIL: complete scenario was incorrectly dropped'); ok = false; }
const bData = caseB.fin.data as { droppedIncomplete?: number };
if (bData?.droppedIncomplete !== 0) { console.error('FAIL: finish reported droppedIncomplete on a valid scenario'); ok = false; }

if (ok) console.log('OK: finish drops incomplete, keeps complete');
process.exit(ok ? 0 : 1);
