/**
 * Locks the capture-and-compare primitive (tools.ts + replay.ts +
 * transcriber.ts + gate.ts).
 *
 * The contract the user asked for:
 *   1. Capture a REAL runtime value (attribute, text, or count) into a named
 *      variable. The value is read off the page, never a literal the model
 *      invents.
 *   2. After an action, assert a relationship to the captured value: changed,
 *      unchanged, equal, greater, less, or the old value is now absent.
 *   3. The emitted spec reads the value, stores it, acts, re-reads, and asserts
 *      the relationship — no placeholder strings.
 *
 * Each part drives a real (headless) page through the actual tools, inspects
 * the recorded trace + the live verdict, then checks the emitted spec.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { transcribe } from '../src/agent/transcriber.js';
import type { RunReport, Scenario } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const browser = await chromium.launch();
const context = await browser.newContext();
await installEvalShim(context);
const page = await context.newPage();

const ctx = createContext(page, 80);

/* ─── A. capture an attribute, act, assert it CHANGED ─────────────────────── */
// A button whose id regenerates on click. The stable handle is its text "Go".
const dynamicIdHtml = `
<!doctype html><html><body>
<button id="btn-original" onclick="this.id='btn-'+Math.floor(Math.random()*1e9)">Go</button>
</body></html>`;
await page.setContent(dynamicIdHtml, { waitUntil: 'load' });

await runTool(ctx, { name: 'begin_scenario', input: { name: 'button id regenerates on click', category: 'happy', feature: 'dynamic-id' } });
const capA = await runTool(ctx, { name: 'capture', input: { name: 'oldId', source: 'attribute', attribute: 'id', role: 'button', label: 'Go', intent: 'Go button' } });
check('A1. capture(attribute id) read the REAL id off the page', capA.ok === true && (capA.data as { value?: string }).value === 'btn-original', JSON.stringify(capA));
await runTool(ctx, { name: 'click', input: { intent: 'Go button', role: 'button', label: 'Go' } });
const cmpA = await runTool(ctx, { name: 'assert_compare', input: { name: 'oldId', relation: 'changed' } });
check('A2. assert_compare(changed) passes after the id regenerated', cmpA.ok === true, JSON.stringify(cmpA));
const stepsA = ctx.current!.steps;
check('A3. recorded a capture step (attribute, id)', stepsA.some((s) => s.kind === 'capture' && s.source === 'attribute' && s.attribute === 'id'));
check('A4. recorded an assert_compare(changed) step', stepsA.some((s) => s.kind === 'assert_compare' && s.relation === 'changed'));
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── B. capture a count, act, assert it INCREASED ────────────────────────── */
const listHtml = `
<!doctype html><html><body>
<ul id="list"><li class="item">a</li><li class="item">b</li></ul>
<button onclick="const li=document.createElement('li');li.className='item';li.textContent='x';document.getElementById('list').appendChild(li);">Add</button>
</body></html>`;
await page.setContent(listHtml, { waitUntil: 'load' });

await runTool(ctx, { name: 'begin_scenario', input: { name: 'adding an item increases the list count', category: 'happy', feature: 'list' } });
const capB = await runTool(ctx, { name: 'capture', input: { name: 'startCount', source: 'count', css: '.item', intent: 'list items' } });
check('B1. capture(count) read the starting count "2"', capB.ok === true && (capB.data as { value?: string }).value === '2', JSON.stringify(capB));
await runTool(ctx, { name: 'click', input: { intent: 'Add button', role: 'button', label: 'Add' } });
const cmpB = await runTool(ctx, { name: 'assert_compare', input: { name: 'startCount', relation: 'greater', css: '.item' } });
check('B2. assert_compare(greater) passes after the count went up', cmpB.ok === true, JSON.stringify(cmpB));
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── C. capture a value, act, assert the OLD value is ABSENT ─────────────── */
await page.setContent(dynamicIdHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'old id no longer matches after regeneration', category: 'edge', feature: 'dynamic-id' } });
const capC = await runTool(ctx, { name: 'capture', input: { name: 'goneId', source: 'attribute', attribute: 'id', role: 'button', label: 'Go', intent: 'Go button' } });
check('C1. capture read the id before the action', capC.ok === true && (capC.data as { value?: string }).value === 'btn-original');
await runTool(ctx, { name: 'click', input: { intent: 'Go button', role: 'button', label: 'Go' } });
const cmpC = await runTool(ctx, { name: 'assert_compare', input: { name: 'goneId', relation: 'absent' } });
check('C2. assert_compare(absent) passes — the old id matches nothing now', cmpC.ok === true, JSON.stringify(cmpC));
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── D. falsifiability: changed must FAIL when the value did not change ───── */
const staticIdHtml = `
<!doctype html><html><body>
<button id="btn-static">Stay</button>
</body></html>`;
await page.setContent(staticIdHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'static id does not change', category: 'negative', feature: 'dynamic-id' } });
await runTool(ctx, { name: 'capture', input: { name: 'sameId', source: 'attribute', attribute: 'id', role: 'button', label: 'Stay', intent: 'Stay button' } });
await runTool(ctx, { name: 'click', input: { intent: 'Stay button', role: 'button', label: 'Stay' } });
const cmpD = await runTool(ctx, { name: 'assert_compare', input: { name: 'sameId', relation: 'changed' } });
check('D1. assert_compare(changed) FAILS when the id stayed the same', cmpD.ok === false && /relation does not hold/.test(cmpD.error ?? ''), JSON.stringify(cmpD));
// Abandon this scenario — it was only here to prove the assertion can fail.
ctx.current = null;

/* ─── E. capture without a prior capture name is rejected ─────────────────── */
await runTool(ctx, { name: 'begin_scenario', input: { name: 'compare with no capture', category: 'happy', feature: 'list' } });
const cmpE = await runTool(ctx, { name: 'assert_compare', input: { name: 'neverCaptured', relation: 'changed' } });
check('E1. assert_compare with an unknown name is rejected', cmpE.ok === false && /No capture named/.test(cmpE.error ?? ''));
ctx.current = null;

await browser.close();

/* ─── F. the emitted spec reads real values and asserts relationships ─────── */
const report: RunReport = {
  url: 'http://example.com/dynamicid', language: 'ts',
  scenarios: ctx.scenarios as Scenario[],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
};
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-capcmp-'));
const { specPath } = transcribe({ report, outDir, name: 'dynamicid' });
const spec = fs.readFileSync(specPath, 'utf8');
fs.rmSync(outDir, { recursive: true, force: true });

check('F1. spec declares a captured const read via getAttribute("id")', /const cap_\w+ = \(await .*getAttribute\("id"\)\)\?\.trim\(\) \?\? '';/.test(spec));
check('F2. spec polls the re-read value .not.toBe the captured one (changed)', /await expect\.poll\(async \(\) => .+, \{ timeout: \d+ \}\)\.not\.toBe\(cap_\w+\)/.test(spec));
check('F3. spec reads a count and polls until it is greater', /\.count\(\)/.test(spec) && /await expect\.poll\(async \(\) => Number\(.+\), \{ timeout: \d+ \}\)\.toBeGreaterThan\(Number\(cap_\w+\)\)/.test(spec));
check('F4. spec asserts the old value is absent via a value selector + count 0', /page\.locator\(`\[id="\$\{cap_\w+\}"\]`\)\)\.toHaveCount\(0\)/.test(spec));
check('F5. spec contains NO invented placeholder id strings', !/button-fixed-id|previously-captured-id|placeholder/i.test(spec));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: capture-and-compare — real values captured, changed/greater/absent asserted, falsifiable, no placeholder strings.');
