/**
 * Locks form-control handling (tools.ts + replay.ts + transcriber.ts + pom.ts).
 *
 * The bug this prevents: the Explorer called fill() on a <select> and got
 * "Element is not an <input>". You cannot fill a select. The fix detects the
 * real control type and routes each one to the action Playwright supports:
 *   <select>            -> selectOption (by value, label, or index)
 *   checkbox / radio    -> check / uncheck
 *   text input/textarea -> fill
 *   file input          -> setInputFiles
 *
 * Each part drives a real (headless) page through the actual tools, inspects
 * the recorded trace + the live page state, then checks the emitted spec.
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

const formHtml = `
<!doctype html><html><body>
<form>
  <label for="country">Country</label>
  <select id="country" name="country">
    <option value="">Choose...</option>
    <option value="us">United States</option>
    <option value="ca">Canada</option>
    <option value="uk">United Kingdom</option>
  </select>
  <label><input type="checkbox" id="terms"> I accept the terms</label>
  <label><input type="radio" name="plan" id="pro" value="pro"> Pro plan</label>
  <label for="bio">Bio</label>
  <textarea id="bio" name="bio"></textarea>
</form>
</body></html>`;

const sel = (id: string) => page.locator(`#${id}`);

/* ─── A. fill() on a <select> auto-routes to selectOption (the reported bug) ── */
await page.setContent(formHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'country select set via fill', category: 'happy', feature: 'register' } });
const fillSelect = await runTool(ctx, { name: 'fill', input: { intent: 'country dropdown', value: 'Canada', label: 'Country' } });
check('A1. fill on a <select> does NOT error ("Element is not an <input>")', fillSelect.ok === true, JSON.stringify(fillSelect));
check('A2. fill reports it auto-dispatched to select_option', (fillSelect.data as { autoDispatched?: string }).autoDispatched === 'select_option');
check('A3. recorded step kind is select_option, not fill', ctx.current!.steps.some((s) => s.kind === 'select_option') && !ctx.current!.steps.some((s) => s.kind === 'fill'));
check('A4. the select actually moved to Canada (value "ca")', (await sel('country').inputValue()) === 'ca');
await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'country dropdown', label: 'Country' } });
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── B. fill() on a checkbox auto-routes to check ─────────────────────────── */
await page.setContent(formHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'accept terms via fill', category: 'happy', feature: 'register' } });
const fillCheck = await runTool(ctx, { name: 'fill', input: { intent: 'accept terms', value: 'true', role: 'checkbox', label: 'I accept the terms' } });
check('B1. fill on a checkbox does NOT error', fillCheck.ok === true, JSON.stringify(fillCheck));
check('B2. fill reports it auto-dispatched to set_checked', (fillCheck.data as { autoDispatched?: string }).autoDispatched === 'set_checked');
check('B3. recorded step kind is set_checked, not fill', ctx.current!.steps.some((s) => s.kind === 'set_checked'));
check('B4. the checkbox is actually checked', (await sel('terms').isChecked()) === true);
await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'accept terms', role: 'checkbox', label: 'I accept the terms' } });
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── C. explicit select_option by value, label, and index ─────────────────── */
await page.setContent(formHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'select option three ways', category: 'happy', feature: 'register' } });
const byValue = await runTool(ctx, { name: 'select_option', input: { intent: 'country', optionValue: 'us', label: 'Country' } });
check('C1. select_option by value selects United States', byValue.ok === true && (await sel('country').inputValue()) === 'us');
const byLabel = await runTool(ctx, { name: 'select_option', input: { intent: 'country', optionLabel: 'United Kingdom', label: 'Country' } });
check('C2. select_option by label selects United Kingdom (value "uk")', byLabel.ok === true && (await sel('country').inputValue()) === 'uk');
const byIndex = await runTool(ctx, { name: 'select_option', input: { intent: 'country', optionIndex: 2, label: 'Country' } });
check('C3. select_option by index 2 selects Canada (value "ca")', byIndex.ok === true && (await sel('country').inputValue()) === 'ca');
const noPick = await runTool(ctx, { name: 'select_option', input: { intent: 'country', label: 'Country' } });
check('C4. select_option with no option given is rejected', noPick.ok === false && /optionValue|optionLabel|optionIndex/.test(noPick.error ?? ''));
await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'country', label: 'Country' } });
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── D. explicit set_checked check then uncheck ───────────────────────────── */
await page.setContent(formHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'toggle terms', category: 'edge', feature: 'register' } });
await runTool(ctx, { name: 'set_checked', input: { intent: 'terms', checked: true, role: 'checkbox', label: 'I accept the terms' } });
check('D1. set_checked(true) ticks the box', (await sel('terms').isChecked()) === true);
await runTool(ctx, { name: 'set_checked', input: { intent: 'terms', checked: false, role: 'checkbox', label: 'I accept the terms' } });
check('D2. set_checked(false) unticks the box', (await sel('terms').isChecked()) === false);
await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'terms', role: 'checkbox', label: 'I accept the terms' } });
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── E. fill() on a radio checks it; fill() on a textarea still fills ──────── */
await page.setContent(formHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'radio and textarea', category: 'happy', feature: 'register' } });
const fillRadio = await runTool(ctx, { name: 'fill', input: { intent: 'pro plan', value: 'on', role: 'radio', label: 'Pro plan' } });
check('E1. fill on a radio checks it (no error)', fillRadio.ok === true && (await sel('pro').isChecked()) === true);
const fillTextarea = await runTool(ctx, { name: 'fill', input: { intent: 'bio', value: 'hello there', label: 'Bio' } });
check('E2. fill on a textarea still fills (kind stays fill)', fillTextarea.ok === true && (await sel('bio').inputValue()) === 'hello there');
check('E3. textarea recorded as a real fill step', ctx.current!.steps.some((s) => s.kind === 'fill' && s.value === 'hello there'));
await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'bio', label: 'Bio' } });
await runTool(ctx, { name: 'end_scenario', input: {} });

await browser.close();

/* ─── F. the emitted spec uses the right Playwright call for each control ──── */
const report: RunReport = {
  url: 'http://example.com/register', language: 'ts',
  scenarios: ctx.scenarios as Scenario[],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
};
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-form-'));
const { specPath } = transcribe({ report, outDir, name: 'register' });
const spec = fs.readFileSync(specPath, 'utf8');
fs.rmSync(outDir, { recursive: true, force: true });

check('F1. spec selects the dropdown with selectOption, not fill', /\.selectOption\(/.test(spec));
check('F2. spec ticks the checkbox with .check()', /\.check\(\)/.test(spec));
check('F3. spec unticks with .uncheck()', /\.uncheck\(\)/.test(spec));
check('F4. spec emits selectOption by value, label, and index', /selectOption\(\{ value:/.test(spec) && /selectOption\(\{ label:/.test(spec) && /selectOption\(\{ index:/.test(spec));
// No combobox/select line may use fill, and "Canada" must never be filled.
const comboboxFilled = spec.split('\n').some((l) => /combobox/.test(l) && /\.fill\(/.test(l));
check('F5. the country select is NEVER filled', !comboboxFilled && !/\.fill\("Canada"\)/.test(spec));
check('F6. the textarea IS filled (fill still works for text)', /\.fill\("hello there"\)/.test(spec));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: form controls — select gets selectOption, checkbox/radio get check, textarea gets fill, never a broken fill on a non-input.');
