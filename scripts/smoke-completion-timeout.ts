/**
 * Locks the adaptive-timeout measurement anchor (tools.ts + adaptive-timeout.ts).
 *
 * The regression this guards against:
 *   A progress bar fills to aria-valuenow="100" over a few seconds. The model
 *   clicks Start, spends a turn thinking, THEN issues a toHaveAttribute assert.
 *   By the time the assert runs the bar is already at 100, so measuring the
 *   settle from the assert call gives ~0ms and the emitted timeout collapses to
 *   the 5000ms floor — too short for replay, where the bar fills from scratch.
 *
 * The fix: the observed settle is anchored to the last state-changing action
 * (the Start click), so it covers the FULL action-to-target window regardless of
 * how long the model waited before asserting. The adaptiveTimeout FORMULA is
 * unchanged — only the duration fed into it.
 *
 * This drives a real headless page through the actual tools and inspects the
 * recorded timeout on the trace step.
 */
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { ADAPTIVE_FLOOR_MS, ADAPTIVE_CEILING_MS } from '../src/agent/adaptive-timeout.js';
import type { TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

function lastStep(steps: TraceStep[]): TraceStep {
  const s = steps[steps.length - 1];
  if (!s) throw new Error('no steps recorded');
  return s;
}

// Bar fills 0 -> 100 over ~4s (20 ticks of +5 every 200ms) once Start is clicked.
const FILL_MS = 4000;
const animatedBar = `
<!doctype html><html><body>
<button id="start">Start</button>
<div id="progressBar" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">0%</div>
<script>
  document.getElementById('start').addEventListener('click', function () {
    var v = 0;
    var id = setInterval(function () {
      v = Math.min(100, v + 5);
      var b = document.getElementById('progressBar');
      b.setAttribute('aria-valuenow', String(v));
      b.textContent = v + '%';
      if (v >= 100) clearInterval(id);
    }, 200);
  });
</script>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const bctx = await browser.newContext();
await installEvalShim(bctx);
const page = await bctx.newPage();

/* ─── A. Late assert on a completed bar still gets the full-window timeout ─── */
// Click Start, wait until the bar is already at 100 (simulating the model
// spending a turn thinking), THEN assert. The old code measured ~0ms here.
await page.setContent(animatedBar, { waitUntil: 'load' });
const tc = createContext(page, 50);
await runTool(tc, { name: 'begin_scenario', input: { name: 'bar completes', category: 'happy', feature: 'progressbar' } });
await runTool(tc, { name: 'click', input: { intent: 'Start button', role: 'button', label: 'Start' } });
// The model "thinks" — the bar finishes filling before the assert is issued.
await new Promise((r) => setTimeout(r, FILL_MS + 600));
const a = await runTool(tc, { name: 'assert', input: { intent: 'progress bar reached 100', css: '#progressBar', type: 'toHaveAttribute', attribute: 'aria-valuenow', value: '100' } });
check('A. toHaveAttribute on the completed bar succeeded', a.ok === true, JSON.stringify(a));

const step = lastStep(tc.current!.steps);
let recorded = -1;
if (step.kind === 'assert' && step.assertion.type === 'toHaveAttribute') recorded = step.assertion.timeout ?? -1;
check('B. recorded an aria-valuenow="100" attribute assertion', step.kind === 'assert' && step.assertion.type === 'toHaveAttribute' && step.assertion.attribute === 'aria-valuenow');
check('C. the timeout is NOT the 5000ms floor (the regression value)', recorded > ADAPTIVE_FLOOR_MS,
  `recorded ${recorded}ms — measurement collapsed to the floor, the anchor is broken`);
check('D. the timeout covers the full ~4s fill window (>= 6000ms)', recorded >= 6000,
  `recorded ${recorded}ms, expected to reflect the ${FILL_MS}ms fill plus margin`);
check('E. the timeout is sane (<= adaptive ceiling)', recorded <= ADAPTIVE_CEILING_MS, `recorded ${recorded}ms`);

/* ─── B. A genuinely instant state still floors at 5000 ───────────────────── */
// Anchoring must not inflate an assertion on a static element checked right
// after navigation — the floor is still the right minimum there.
await page.setContent(`<!doctype html><html><body><div id="msg">Ready</div></body></html>`, { waitUntil: 'load' });
const tc2 = createContext(page, 50);
await runTool(tc2, { name: 'begin_scenario', input: { name: 'static text', category: 'happy' } });
const a2 = await runTool(tc2, { name: 'assert', input: { intent: 'message', css: '#msg', type: 'toHaveText', text: 'Ready' } });
const step2 = lastStep(tc2.current!.steps);
let recorded2 = -1;
if (step2.kind === 'assert' && 'timeout' in step2.assertion) recorded2 = (step2.assertion as { timeout?: number }).timeout ?? -1;
check('F. an instant static assertion still floors at 5000ms', a2.ok === true && recorded2 === ADAPTIVE_FLOOR_MS,
  `recorded ${recorded2}ms`);

await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the completion timeout is measured from the triggering action, so a late assert on a finished animation keeps the full-window timeout instead of the floor.');
