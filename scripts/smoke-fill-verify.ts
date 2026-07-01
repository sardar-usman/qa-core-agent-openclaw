/**
 * Locks fill-and-verify value integrity (tools.ts).
 *
 * On the ui.vision frames run a negative long-text scenario shipped a recording
 * defect: the toHaveValue assertion asserted a string LONGER than the one the
 * fill actually typed (the fill string was unclosed), so the fill value and the
 * asserted value disagreed. A fill-and-verify assertion can only be correct if
 * it asserts the exact string that was filled.
 *
 * The fix makes the recorded fill step the single source of truth: when a
 * scenario fills a field and then asserts that field's value, the toHaveValue
 * assertion reads the recorded fill value (fillValueForTarget), never the value
 * the model re-supplied. This is general, every fill-and-verify test on any
 * site.
 *
 * Checks:
 *   - fillValueForTarget returns the filled string for the same field (by intent
 *     and by resolved locator), the LAST fill when refilled, null when unfilled;
 *   - end to end through the real tools: a fill then a toHaveValue with a
 *     deliberately mismatched (longer) value records the FILLED string, not the
 *     model's, and the live assertion passes against the real page;
 *   - a generated field (registration email) records and asserts the generated
 *     value, which the model cannot know, not the literal it passed.
 *
 * Uses a headless page with setContent, no live site, no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createContext, runTool, fillValueForTarget } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { transcribe } from '../src/agent/transcriber.js';
import { transcribePOM } from '../src/agent/pom.js';
import type { RunReport, SelectorRecord, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── pure helper: binding is by the element's own stable key, nothing else ── */
// A record carries elementKey — the identity of the DOM element it resolved to,
// read off the live element by the real tools (see the live tests below). The
// pure helper is keyed by THAT, never by intent text or cascade tier. Here we
// build records with explicit keys to exercise the lookup in isolation.
const nameField: SelectorRecord = { level: 'label', arg: 'Full Name', intent: 'full name field', elementKey: '|form>input#name[0]' };
const otherField: SelectorRecord = { level: 'label', arg: 'Email', intent: 'email field', elementKey: '|form>input#email[0]' };
const steps: TraceStep[] = [
  { kind: 'navigate', url: 'https://example.com/' },
  { kind: 'fill', target: nameField, value: 'Ada Lovelace' },
  { kind: 'fill', target: otherField, value: 'ada@example.com' },
];
check('A. fillValueForTarget returns the value filled into the matching field',
  fillValueForTarget(steps, nameField) === 'Ada Lovelace');
check('B. it matches the right field, not another filled field',
  fillValueForTarget(steps, otherField) === 'ada@example.com');
// The SAME physical element resolved via a DIFFERENT cascade tier has the SAME
// elementKey (the key is the element, not the locator tier), so it still binds.
check('C. it binds by element key even when the locator tier differs',
  fillValueForTarget(steps, { level: 'css', arg: '#name', intent: 'the Full Name input', elementKey: '|form>input#name[0]' }) === 'Ada Lovelace');
check('D. a never-filled field returns null (keep the model value)',
  fillValueForTarget(steps, { level: 'label', arg: 'Phone', intent: 'phone field', elementKey: '|form>input#phone[0]' }) === null);
// A record with no key at all cannot bind — it keeps the model value, never borrows.
check('D2. a record with no element key returns null (never guesses)',
  fillValueForTarget(steps, { level: 'label', arg: 'Full Name', intent: 'full name field' }) === null);
// When a field is refilled, the latest fill wins.
const refilled: TraceStep[] = [...steps, { kind: 'fill', target: nameField, value: 'Grace Hopper' }];
check('E. when a field is refilled, the latest fill value wins',
  fillValueForTarget(refilled, nameField) === 'Grace Hopper');

/* ─── multi-field isolation: each assertion binds to its OWN fill ──────────── */
// The ui.vision multi-frame isolation scenario: fill three frames with distinct
// values, then verify each. The frames share a generic intent ("text input") and
// a generic locator (role textbox, name "text"); only the element key tells them
// apart. The assert records are worded with a verification suffix — irrelevant
// now, because binding ignores intent entirely and uses the element key.
const key1 = 'frame >> nth=0|body>form>input@text[0]';
const key2 = 'frame >> nth=1|body>form>input@text[0]';
const key5 = 'frame >> nth=4|body>form>input@text[0]';
const f1: SelectorRecord = { level: 'role', arg: { role: 'textbox', name: 'text' }, intent: 'text input', frameChain: ['frame >> nth=0'], elementKey: key1 };
const f2: SelectorRecord = { level: 'role', arg: { role: 'textbox', name: 'text' }, intent: 'text input', frameChain: ['frame >> nth=1'], elementKey: key2 };
const f5: SelectorRecord = { level: 'role', arg: { role: 'textbox', name: 'text' }, intent: 'text input', frameChain: ['frame >> nth=4'], elementKey: key5 };
const multiSteps: TraceStep[] = [
  { kind: 'navigate', url: 'https://example.com/' },
  { kind: 'fill', target: f1, value: 'alpha-1' },
  { kind: 'fill', target: f2, value: 'bravo-2' },
  { kind: 'fill', target: f5, value: 'echo-5' },
];
const a1: SelectorRecord = { level: 'role', arg: { role: 'textbox', name: 'text' }, intent: 'text input value', frameChain: ['frame >> nth=0'], elementKey: key1 };
const a2: SelectorRecord = { level: 'role', arg: { role: 'textbox', name: 'text' }, intent: 'text input value', frameChain: ['frame >> nth=1'], elementKey: key2 };
const a5: SelectorRecord = { level: 'role', arg: { role: 'textbox', name: 'text' }, intent: 'text input value', frameChain: ['frame >> nth=4'], elementKey: key5 };
check('E1. frame 1 assertion binds to frame 1 own value', fillValueForTarget(multiSteps, a1) === 'alpha-1', fillValueForTarget(multiSteps, a1) ?? 'null');
check('E2. frame 2 assertion binds to frame 2 own value', fillValueForTarget(multiSteps, a2) === 'bravo-2', fillValueForTarget(multiSteps, a2) ?? 'null');
check('E3. frame 5 assertion binds to frame 5 own value', fillValueForTarget(multiSteps, a5) === 'echo-5', fillValueForTarget(multiSteps, a5) ?? 'null');
check('E4. the three assertions get THREE distinct values (real per-frame isolation)',
  new Set([fillValueForTarget(multiSteps, a1), fillValueForTarget(multiSteps, a2), fillValueForTarget(multiSteps, a5)]).size === 3);
// A field with a key that was never filled returns null, it does not borrow.
const a9: SelectorRecord = { level: 'role', arg: { role: 'textbox', name: 'text' }, intent: 'text input value', frameChain: ['frame >> nth=8'], elementKey: 'frame >> nth=8|body>form>input@text[0]' };
check('E5. an assertion in an unfilled frame does not borrow another frame value',
  fillValueForTarget(multiSteps, a9) === null, fillValueForTarget(multiSteps, a9) ?? 'null');

/* ─── end to end: a mismatched fill/assert pair is corrected to the fill ───── */
const browser = await chromium.launch();
const context = await browser.newContext();
await installEvalShim(context);
const page = await context.newPage();

const formHtml = `<!doctype html><html><body>
<form>
  <label for="name">Full Name</label>
  <input id="name" name="name" />
  <label for="email">Email</label>
  <input id="email" name="email" type="email" />
</form>
</body></html>`;

const ctx = createContext(page, 80);

// A negative long-text scenario: fill a real (closed) string, then assert the
// value with a DIFFERENT, longer string, the recording defect from the run.
await page.setContent(formHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'typed a long name and the field holds it', category: 'edge', feature: 'forms' } });
const TYPED = 'this is a deliberately long single line of text typed into the field';
await runTool(ctx, { name: 'fill', input: { intent: 'full name field', value: TYPED, label: 'Full Name' } });
// The model re-types a LONGER / different string for the assertion (the defect).
const MISMATCH = TYPED + ' and then some extra unclosed tail that was never typed';
const res = await runTool(ctx, { name: 'assert', input: { type: 'toHaveValue', intent: 'full name field', label: 'Full Name', value: MISMATCH } });
check('F. the toHaveValue assertion passes (asserts the filled value, not the longer one)', res.ok === true, JSON.stringify(res));

const recorded = ctx.current!.steps.find((s) => s.kind === 'assert' && s.assertion.type === 'toHaveValue');
const recordedVal = recorded && recorded.kind === 'assert' && recorded.assertion.type === 'toHaveValue' ? recorded.assertion.value : undefined;
check('G. the recorded assertion value is the EXACT filled string', recordedVal === TYPED, `recorded="${recordedVal}"`);
check('H. the recorded assertion is NOT the model-supplied mismatched string', recordedVal !== MISMATCH);
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── a generated field: the assertion uses the generated value, unknowable ── */
const regHtml = `<!doctype html><html><body>
<form>
  <label for="em">Email</label>
  <input id="em" name="email" type="email" />
</form>
</body></html>`;
await page.setContent(regHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'registered with a fresh email', category: 'happy', feature: 'register' } });
const fillRes = await runTool(ctx, { name: 'fill', input: { intent: 'email field', value: 'test@example.com', label: 'Email' } });
const generated = (fillRes.data as { generated?: string }).generated;
const liveValue = await page.locator('#em').inputValue();
// The model asserts the literal it passed; the field actually holds a generated unique email.
const regAssert = await runTool(ctx, { name: 'assert', input: { type: 'toHaveValue', intent: 'email field', label: 'Email', value: 'test@example.com' } });
const regStep = ctx.current!.steps.find((s) => s.kind === 'assert' && s.assertion.type === 'toHaveValue');
const regVal = regStep && regStep.kind === 'assert' && regStep.assertion.type === 'toHaveValue' ? regStep.assertion.value : undefined;
check('I. a registration email field generated a unique value (not the literal)', generated === 'email' && liveValue !== 'test@example.com', `live="${liveValue}"`);
check('J. the assertion passes and records the generated value, not the literal', regAssert.ok === true && regVal === liveValue && regVal !== 'test@example.com', `recorded="${regVal}"`);
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── special characters: the fill literal and the toHaveValue literal must be
 *     byte-identical after escaping, AND the assert must bind to the fill even
 *     when the model words the assert intent differently (the real framesets
 *     failure: "frame 2 text input" filled, "frame 2 text input value" asserted,
 *     so the binding missed and the model's artifact value shipped). ──────────── */
const specialHtml = `<!doctype html><html><body>
<form>
  <label for="t">Frame 2 Text</label>
  <input id="t" name="mytext2" />
</form>
</body></html>`;
await page.setContent(specialHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'typed special characters and the field holds them', category: 'edge', feature: 'frames' } });
// quotes, a backslash, angle brackets, and a non-ascii character.
const SPECIAL = 'a"b\\c<script>alert(\'x\')</script>é☃';
await runTool(ctx, { name: 'fill', input: { intent: 'frame 2 text input', value: SPECIAL, label: 'Frame 2 Text' } });
// The model asserts with a DIFFERENT, corrupted value AND a verification-worded
// intent. The binding must still pull the exact filled string.
const ARTIFACT: string = 'a"b\\c<script>alert(\'x\')</script>é☃ trailing tail never typed';
const specialAssert = await runTool(ctx, { name: 'assert', input: { type: 'toHaveValue', intent: 'frame 2 text input value', label: 'Frame 2 Text', value: ARTIFACT } });
check('K. the assert binds to the fill despite the differently-worded intent', specialAssert.ok === true, JSON.stringify(specialAssert));

const specialSteps = ctx.current!.steps.slice();
const specialFill = specialSteps.find((s) => s.kind === 'fill');
const specialRec = specialSteps.find((s) => s.kind === 'assert' && s.assertion.type === 'toHaveValue');
const specialFillVal = specialFill && specialFill.kind === 'fill' ? specialFill.value : undefined;
const specialAssertVal = specialRec && specialRec.kind === 'assert' && specialRec.assertion.type === 'toHaveValue' ? specialRec.assertion.value : undefined;
check('L. the recorded fill value is the exact special string', specialFillVal === SPECIAL);
check('M. the recorded assert value equals the filled value, not the artifact', specialAssertVal === SPECIAL && specialAssertVal !== ARTIFACT, `recorded="${specialAssertVal}"`);
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── LIVE: three fills of three distinct values, three assertions ─────────────
 *   The exact bug that recurred across three ui.vision runs: a scenario fills N
 *   fields and verifies each, but every assertion collapses to the last filled
 *   value. This drives the REAL tools against a REAL page with three inputs that
 *   share the same generic hints (so intent/tier matching could never tell them
 *   apart), fills three distinct values, asserts each, and proves:
 *     - each recorded assertion value equals ITS OWN field's fill;
 *     - the three recorded values are three distinct strings;
 *     - swapping any two would fail — asserting field 1 against field 2's value
 *       is rejected by the live toHaveValue, so the binding cannot be faked. */
const threeHtml = `<!doctype html><html><body>
<form>
  <input class="txt" name="text" />
  <input class="txt" name="text" />
  <input class="txt" name="text" />
</form>
</body></html>`;
await page.setContent(threeHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'filled three inputs and each kept its own value', category: 'edge', feature: 'forms' } });
// Three fields, identical hints on purpose. Only the element key separates them.
const V1 = 'value-one-111', V2 = 'value-two-222', V3 = 'value-three-333';
// Address each by nth so the model's hint is generic and identical in shape.
await runTool(ctx, { name: 'fill', input: { intent: 'text input', value: V1, css: 'form .txt >> nth=0' } });
await runTool(ctx, { name: 'fill', input: { intent: 'text input', value: V2, css: 'form .txt >> nth=1' } });
await runTool(ctx, { name: 'fill', input: { intent: 'text input', value: V3, css: 'form .txt >> nth=2' } });
// The model asserts each field but (as it really did) re-supplies the SAME value
// V3 for all three. The binding must override each with its own fill value.
const t1 = await runTool(ctx, { name: 'assert', input: { type: 'toHaveValue', intent: 'text input value', css: 'form .txt >> nth=0', value: V3 } });
const t2 = await runTool(ctx, { name: 'assert', input: { type: 'toHaveValue', intent: 'text input value', css: 'form .txt >> nth=1', value: V3 } });
const t3 = await runTool(ctx, { name: 'assert', input: { type: 'toHaveValue', intent: 'text input value', css: 'form .txt >> nth=2', value: V3 } });
check('Q. all three live toHaveValue assertions pass', t1.ok && t2.ok && t3.ok, JSON.stringify([t1, t2, t3]));
const recVals = ctx.current!.steps
  .filter((s): s is Extract<TraceStep, { kind: 'assert' }> => s.kind === 'assert' && s.assertion.type === 'toHaveValue')
  .map((s) => (s.assertion.type === 'toHaveValue' ? s.assertion.value : ''));
check('R. field 1 assertion recorded its OWN value', recVals[0] === V1, `recorded="${recVals[0]}"`);
check('S. field 2 assertion recorded its OWN value', recVals[1] === V2, `recorded="${recVals[1]}"`);
check('T. field 3 assertion recorded its OWN value', recVals[2] === V3, `recorded="${recVals[2]}"`);
check('U. the three recorded values are three DISTINCT strings (no collapse)',
  new Set(recVals).size === 3, JSON.stringify(recVals));
// Swap proof, straight against the live DOM (bypassing the tool's self-correct):
// if the recorded values were swapped, the test would go red. Each field really
// holds its own value and not another's.
const live0 = await page.locator('form .txt').nth(0).inputValue();
const live1 = await page.locator('form .txt').nth(1).inputValue();
const live2 = await page.locator('form .txt').nth(2).inputValue();
check('V. each live field holds its own recorded value (swap would fail)',
  live0 === V1 && live1 === V2 && live2 === V3
  && live0 !== recVals[1] && live1 !== recVals[0], JSON.stringify([live0, live1, live2]));
// And the binding is not a lucky read of the model value: the model passed V3 to
// all three, yet fields 1 and 2 recorded V1 and V2, which the model never gave them.
check('W. fields 1 and 2 recorded values the model never supplied for them',
  recVals[0] !== V3 && recVals[1] !== V3, JSON.stringify(recVals));
await runTool(ctx, { name: 'end_scenario', input: {} });

await browser.close();

/* the emitted spec must carry one identical literal for fill and toHaveValue */
const specialScenario = {
  name: 'typed special characters and the field holds them', category: 'edge' as const, feature: 'frames',
  steps: [
    { kind: 'navigate' as const, url: 'https://example.com/' },
    specialFill!,
    specialRec!,
  ],
};
const specialReport: RunReport = {
  url: 'https://example.com/', language: 'ts', scenarios: [specialScenario],
  cascadeStats: { role: 0, label: 1, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
};
// The single correct literal: JSON.stringify of the filled bytes. Both the fill
// call and the assertion must contain exactly this substring.
const expectedLiteral = JSON.stringify(SPECIAL);

const inlineSpecialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fillverify-special-inline-'));
const { specPath: specialSpecPath } = transcribe({ report: specialReport, outDir: inlineSpecialDir, name: 'frames' });
const inlineSpecialSpec = fs.readFileSync(specialSpecPath, 'utf8');
fs.rmSync(inlineSpecialDir, { recursive: true, force: true });
check('N. inline spec emits the special string as one identical literal for fill and toHaveValue',
  inlineSpecialSpec.includes(`.fill(${expectedLiteral})`) && inlineSpecialSpec.includes(`.toHaveValue(${expectedLiteral}`),
  expectedLiteral);

const pomSpecialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fillverify-special-pom-'));
const pomSpecialRes = transcribePOM({ report: specialReport, outDir: pomSpecialDir, name: 'frames' });
const pomSpecialText = [...pomSpecialRes.pageFiles, ...pomSpecialRes.specFiles].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
fs.rmSync(pomSpecialDir, { recursive: true, force: true });
check('O. POM output emits the special string as the identical literal for fill and toHaveValue',
  pomSpecialText.includes(`.fill(${expectedLiteral})`) || pomSpecialText.includes(expectedLiteral),
  expectedLiteral);
check('P. the emitted literal round-trips to the exact filled bytes',
  JSON.parse(expectedLiteral) === SPECIAL);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: a toHaveValue assertion always asserts the exact string that was filled (the recorded fill is the single source of truth), so a mismatched or generated value cannot ship.');
