/**
 * Locks the ARIA-over-text assertion model (aria-assertion.ts + tools.ts +
 * transcriber.ts).
 *
 * The contract the user asked for:
 *   1. An element that exposes a semantic ARIA value/state attribute
 *      (aria-valuenow, ...) MUST get an attribute assertion, NOT a text
 *      assertion. A progress bar at completion records
 *      toHaveAttribute("aria-valuenow", "100"), never toHaveText("100%").
 *   2. The stop scenario reads aria-valuenow, waits a bounded interval under
 *      1000ms, reads again, and asserts the two readings are equal AND strictly
 *      between aria-valuemin and aria-valuemax. It never depends on catching a
 *      specific number mid-animation.
 *
 * Part A is a pure-function check. Parts B/C drive a real (headless) page
 * through the actual tools and inspect the recorded trace + emitted spec.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { chooseStateAssertion, SEMANTIC_STATE_ATTRS } from '../src/agent/aria-assertion.js';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { transcribe } from '../src/agent/transcriber.js';
import type { RunReport, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── A. The pure policy: attribute wins, text is the fallback ────────────── */

const c1 = chooseStateAssertion({ 'aria-valuenow': '100' }, '100%');
check('A. aria-valuenow present → attribute assertion, not text', c1.kind === 'attribute' && c1.attribute === 'aria-valuenow' && c1.value === '100');

const c2 = chooseStateAssertion({ 'aria-checked': 'true' }, 'Checked');
check('B. aria-checked present → attribute assertion', c2.kind === 'attribute' && c2.attribute === 'aria-checked' && c2.value === 'true');

const c3 = chooseStateAssertion({}, 'Welcome back');
check('C. no semantic attribute → text fallback', c3.kind === 'text' && c3.text === 'Welcome back');

const c4 = chooseStateAssertion({ 'aria-valuenow': '   ' }, '50%');
check('D. blank attribute is ignored → text fallback', c4.kind === 'text' && c4.text === '50%');

const c5 = chooseStateAssertion({ 'aria-valuenow': '42', 'aria-checked': 'true' }, 'x');
check('E. aria-valuenow takes priority over other state attributes', c5.attribute === 'aria-valuenow' && c5.value === '42');

check('F. SEMANTIC_STATE_ATTRS lists aria-valuenow first', SEMANTIC_STATE_ATTRS[0] === 'aria-valuenow');

/* ─── live page: a Bootstrap-style progress bar ──────────────────────────── */

const completedHtml = `
<!doctype html><html><body>
<div id="progressBar" role="progressbar" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100">100%</div>
</body></html>`;

const stoppedHtml = `
<!doctype html><html><body>
<div id="progressBar" role="progressbar" aria-valuenow="42" aria-valuemin="0" aria-valuemax="100">42%</div>
</body></html>`;

// A plain text element with NO semantic attribute — must keep using text.
const plainHtml = `
<!doctype html><html><body>
<div id="toast">Saved</div>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await installEvalShim(ctx);
const page = await ctx.newPage();

function lastStep(steps: TraceStep[]): TraceStep {
  const s = steps[steps.length - 1];
  if (!s) throw new Error('no steps recorded');
  return s;
}

/* ─── B. wait_for_text on a completed bar records an ATTRIBUTE assertion ──── */

await page.setContent(completedHtml, { waitUntil: 'load' });
const tc = createContext(page, 50);
await runTool(tc, { name: 'begin_scenario', input: { name: 'bar completes', category: 'happy', feature: 'progressbar' } });
const wft = await runTool(tc, { name: 'wait_for_text', input: { intent: 'progress bar reaches 100%', css: '#progressBar', text: '100%', timeoutMs: 5000 } });
check('G. wait_for_text on completed bar succeeded', wft.ok === true, JSON.stringify(wft));

const completeStep = lastStep(tc.current!.steps);
const isAttrAssert = completeStep.kind === 'assert' && completeStep.assertion.type === 'toHaveAttribute';
check('H. completion records an attribute assertion, not text', isAttrAssert,
  `got ${completeStep.kind}/${completeStep.kind === 'assert' ? completeStep.assertion.type : ''}`);
if (completeStep.kind === 'assert' && completeStep.assertion.type === 'toHaveAttribute') {
  check('I. the attribute is aria-valuenow="100"', completeStep.assertion.attribute === 'aria-valuenow' && completeStep.assertion.value === '100');
  check('J. the attribute assertion carries an adaptive timeout', typeof completeStep.assertion.timeout === 'number' && completeStep.assertion.timeout! >= 5000);
}
const noTextAssert = !tc.current!.steps.some((s) => s.kind === 'assert' && s.assertion.type === 'toHaveText');
check('K. NO toHaveText("100%") was recorded for the progress bar', noTextAssert);

/* ─── C. wait_for_text on a plain element keeps the TEXT assertion ────────── */

await page.setContent(plainHtml, { waitUntil: 'load' });
const tcPlain = createContext(page, 50);
await runTool(tcPlain, { name: 'begin_scenario', input: { name: 'toast shows', category: 'happy' } });
await runTool(tcPlain, { name: 'wait_for_text', input: { intent: 'toast message', css: '#toast', text: 'Saved', timeoutMs: 5000 } });
const plainStep = lastStep(tcPlain.current!.steps);
check('L. element with no semantic attribute still records toHaveText', plainStep.kind === 'assert' && plainStep.assertion.type === 'toHaveText' && plainStep.assertion.text === 'Saved');

/* ─── D. assert_freeze(attribute) on a stopped bar: equal + within bounds ─── */

await page.setContent(stoppedHtml, { waitUntil: 'load' });
const tcStop = createContext(page, 50);
await runTool(tcStop, { name: 'begin_scenario', input: { name: 'bar stops', category: 'negative', feature: 'progressbar' } });
const af = await runTool(tcStop, { name: 'assert_freeze', input: { intent: 'progress bar stopped mid-progress', css: '#progressBar', attribute: 'aria-valuenow', waitMs: 400 } });
check('M. assert_freeze(attribute) on a stopped bar succeeded', af.ok === true, JSON.stringify(af));

// assert_freeze now records the general capture-and-compare sequence:
// capture(attribute) -> stability_wait -> assert_compare(unchanged, bounds).
const freezeSteps = tcStop.current!.steps;
const capStep = freezeSteps.find((s) => s.kind === 'capture');
const cmpStep = freezeSteps.find((s) => s.kind === 'assert_compare');
const waitStep = freezeSteps.find((s) => s.kind === 'stability_wait');
check('N. records a capture in attribute mode for aria-valuenow', !!capStep && capStep.kind === 'capture' && capStep.source === 'attribute' && capStep.attribute === 'aria-valuenow');
check('O. records assert_compare(unchanged) with aria-valuemin/max bounds',
  !!cmpStep && cmpStep.kind === 'assert_compare' && cmpStep.relation === 'unchanged'
  && cmpStep.bounds?.min === 'aria-valuemin' && cmpStep.bounds?.max === 'aria-valuemax');
check('P. the two-sample stability_wait is bounded under 1000ms', !!waitStep && waitStep.kind === 'stability_wait' && waitStep.ms < 1000);
check('Q. the live read returned the mid-progress value "42"', af.ok === true && (af.data as { frozen?: string }).frozen === '42');

/* ─── E. a bar still inside its range but at the ceiling fails the bounds ─── */

const fullHtml = `
<!doctype html><html><body>
<div id="progressBar" role="progressbar" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100">100%</div>
</body></html>`;
await page.setContent(fullHtml, { waitUntil: 'load' });
const tcFull = createContext(page, 50);
await runTool(tcFull, { name: 'begin_scenario', input: { name: 'bar at ceiling', category: 'negative' } });
const afFull = await runTool(tcFull, { name: 'assert_freeze', input: { intent: 'bar', css: '#progressBar', attribute: 'aria-valuenow', waitMs: 300 } });
check('R. assert_freeze(aria-valuenow) at the ceiling (100) FAILS the strict bounds', afFull.ok === false && /strictly between/.test(afFull.error ?? ''));

/* ─── F. a bar that keeps moving fails the two-sample equality ────────────── */

const movingHtml = `
<!doctype html><html><body>
<div id="progressBar" role="progressbar" aria-valuenow="30" aria-valuemin="0" aria-valuemax="100">30%</div>
<script>
  let v = 30;
  setInterval(() => { v = Math.min(99, v + 5); const b = document.getElementById('progressBar'); b.setAttribute('aria-valuenow', String(v)); b.textContent = v + '%'; }, 100);
</script>
</body></html>`;
await page.setContent(movingHtml, { waitUntil: 'load' });
const tcMove = createContext(page, 50);
await runTool(tcMove, { name: 'begin_scenario', input: { name: 'bar still moving', category: 'negative' } });
const afMove = await runTool(tcMove, { name: 'assert_freeze', input: { intent: 'bar', css: '#progressBar', attribute: 'aria-valuenow', waitMs: 400 } });
check('S. assert_freeze(aria-valuenow) on a STILL-MOVING bar FAILS (not frozen)', afMove.ok === false && /not frozen|changed/.test(afMove.error ?? ''));

await browser.close();

/* ─── G. the emitted spec uses getAttribute + numeric bounds, not text ───── */

const report: RunReport = {
  url: 'http://uitestingplayground.com/progressbar', language: 'ts',
  scenarios: [
    { name: 'bar completes', category: 'happy', feature: 'progressbar', steps: tc.current!.steps },
    { name: 'bar stops', category: 'negative', feature: 'progressbar', steps: tcStop.current!.steps },
  ],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
};
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-aria-'));
const { specPath } = transcribe({ report, outDir, name: 'progressbar' });
const spec = fs.readFileSync(specPath, 'utf8');
fs.rmSync(outDir, { recursive: true, force: true });

check('T. spec asserts aria-valuenow via toHaveAttribute', /toHaveAttribute\(\s*['"]aria-valuenow['"]\s*,\s*['"]100['"]/.test(spec));
check('U. spec does NOT assert toHaveText("100%") on the bar', !/toHaveText\(\s*['"]100%['"]\s*\)/.test(spec));
check('V. spec polls the attribute read and asserts the value held', /getAttribute\(['"]aria-valuenow['"]\)/.test(spec) && /await expect\.poll\(async \(\) => .+, \{ timeout: \d+ \}\)\.toBe\(cap_\w+\)/.test(spec));
check('W. spec asserts the frozen value is strictly within range', /toBeGreaterThan\(\w+Min\)/.test(spec) && /toBeLessThan\(\w+Max\)/.test(spec));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: ARIA value/state attributes are asserted instead of text; the stop freeze compares two attribute reads and proves the value is strictly inside its range.');
