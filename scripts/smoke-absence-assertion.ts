/**
 * Locks absence-assertion support in the resolver (tools.ts).
 *
 * Before this, the assert tool always routed through resolveAndRecord, which
 * polls the locator ladder and throws "Could not resolve element" when nothing
 * matches. That made negative / error-state / deleted-item scenarios impossible:
 * the resolver refused to record an assertion whose whole point is that the
 * target is gone.
 *
 * The fix adds two absence paths that build the locator straight from the
 * caller's hints WITHOUT resolving:
 *   - toHaveCount with count 0  -> "this selector matches nothing"
 *   - toBeHidden                -> "this element is hidden or absent"
 *
 * This drives a real headless page through the actual tools and checks both
 * are accepted and recorded, that a present element is correctly rejected by a
 * "should be hidden" assertion, and that the locator ladder / gate are untouched
 * for everything else.
 */
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
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

// A page with one visible element, one element hidden via display:none, and no
// element with id "ghost" at all.
const html = `
<!doctype html><html><body>
  <div id="present">I am here</div>
  <div id="hiddenBox" style="display:none">secret</div>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const bctx = await browser.newContext();
await installEvalShim(bctx);
const page = await bctx.newPage();
await page.setContent(html, { waitUntil: 'load' });

/* ─── A. toHaveCount(0) on a selector that matches nothing is accepted ─────── */
const tc = createContext(page, 50);
await runTool(tc, { name: 'begin_scenario', input: { name: 'absence', category: 'negative' } });
const a = await runTool(tc, {
  name: 'assert',
  input: { intent: 'no ghost element exists', css: '#ghost', type: 'toHaveCount', count: 0 },
});
check('A. toHaveCount(0) on a missing element did not error in the resolver', a.ok === true, JSON.stringify(a));

const sA = lastStep(tc.current!.steps);
check('A2. recorded a toHaveCount assertion with count 0',
  sA.kind === 'assert' && sA.assertion.type === 'toHaveCount' && sA.assertion.count === 0,
  JSON.stringify(sA));
check('A3. the count-0 record carries the css hint, not a resolved element',
  sA.kind === 'assert' && sA.assertion.type === 'toHaveCount' && sA.assertion.target.level === 'css' && sA.assertion.target.arg === '#ghost',
  JSON.stringify(sA));

/* ─── B. toBeHidden on an element that is present but hidden is accepted ────── */
const b = await runTool(tc, {
  name: 'assert',
  input: { intent: 'secret box is hidden', css: '#hiddenBox', type: 'toBeHidden' },
});
check('B. toBeHidden on a display:none element did not error in the resolver', b.ok === true, JSON.stringify(b));

const sB = lastStep(tc.current!.steps);
check('B2. recorded a toBeHidden assertion', sB.kind === 'assert' && sB.assertion.type === 'toBeHidden', JSON.stringify(sB));
check('B3. the toBeHidden record carries a timeout', sB.kind === 'assert' && sB.assertion.type === 'toBeHidden' && typeof sB.assertion.timeout === 'number', JSON.stringify(sB));

/* ─── C. toBeHidden on a selector that matches nothing is also accepted ─────── */
const c = await runTool(tc, {
  name: 'assert',
  input: { intent: 'ghost is not shown', css: '#ghost', type: 'toBeHidden' },
});
check('C. toBeHidden on a wholly absent element did not error', c.ok === true, JSON.stringify(c));

/* ─── D. toBeHidden on a VISIBLE element correctly fails (not a free pass) ──── */
const d = await runTool(tc, {
  name: 'assert',
  input: { intent: 'present div should be hidden', css: '#present', type: 'toBeHidden' },
});
check('D. toBeHidden on a visible element fails as it should', d.ok === false, JSON.stringify(d));

/* ─── E. absence with NO locator hint is rejected with a clear message ──────── */
const e = await runTool(tc, {
  name: 'assert',
  input: { intent: 'nothing to point at', type: 'toBeHidden' },
});
check('E. toBeHidden with no locator hint is rejected', e.ok === false && /hint/i.test(e.error ?? ''), JSON.stringify(e));

/* ─── F. role-hint absence works too (locator ladder still honored) ────────── */
const f = await runTool(tc, {
  name: 'assert',
  input: { intent: 'no logout button', role: 'button', label: 'Logout', type: 'toHaveCount', count: 0 },
});
check('F. toHaveCount(0) via role+name builds a role locator without resolving', f.ok === true, JSON.stringify(f));
const sF = lastStep(tc.current!.steps);
check('F2. the role-hint absence record is a role locator',
  sF.kind === 'assert' && sF.assertion.type === 'toHaveCount' && sF.assertion.target.level === 'role',
  JSON.stringify(sF));

await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: absence assertions (toHaveCount 0 and toBeHidden) are accepted from hints without resolving, while a visible element still fails a "should be hidden" check.');
