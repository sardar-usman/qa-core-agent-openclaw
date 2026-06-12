/**
 * Reproduces the bug seen in the live run:
 *   page with multiple checkboxes → agent passes a css selector that matches
 *   N elements → expects toHaveCount(N) → must succeed (used to fail because
 *   the cascade wrapped the locator in `.first()`, collapsing count to 1).
 */
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

const html = `
<!doctype html><html><body>
<h1>Checkboxes</h1>
<div id="checkboxes">
  <input type="checkbox" id="c1">
  <input type="checkbox" id="c2">
  <input type="checkbox" id="c3">
</div>
</body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext();
  await installEvalShim(ctx);
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'load' });

  const tc = createContext(page, 20);
  await runTool(tc, { name: 'begin_scenario', input: { name: 'checkbox count test', category: 'edge' } });

  // The exact shape the live agent used.
  const result = await runTool(tc, {
    name: 'assert',
    input: {
      type: 'toHaveCount',
      intent: 'checkbox inputs',
      css: '#checkboxes input[type=checkbox]',
      count: 3,
    },
  });
  console.log('assert toHaveCount(3):', JSON.stringify(result));
  if (!result.ok) {
    console.error('FAIL: toHaveCount(3) errored — bug not fixed');
    process.exit(1);
  }

  // Also verify the recorded step has ambiguous stripped (so transcriber emits
  // the call without `.first()`).
  const step = tc.current?.steps[0];
  if (!step || step.kind !== 'assert' || step.assertion.type !== 'toHaveCount') {
    console.error('FAIL: scenario step is not the toHaveCount assertion'); process.exit(1);
  }
  if (step.assertion.target.ambiguous === true) {
    console.error('FAIL: toHaveCount record still has ambiguous=true — would emit .first() in spec'); process.exit(1);
  }
  console.log('OK: toHaveCount(N) succeeds AND target.ambiguous is not set on the recorded step');
} finally {
  await browser.close();
}
