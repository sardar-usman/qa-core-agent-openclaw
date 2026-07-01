/**
 * Locks the two fixes from the ui.vision frames run:
 *
 *   BUG 1 — asserting a typed input value. Typed text lives on the value
 *   PROPERTY, not the value attribute, so toHaveAttribute("value", ...) reads
 *   empty. The tool now supports toHaveValue, which both emitters render as
 *   expect(locator).toHaveValue(expected) and replay reads via inputValue().
 *
 *   BUG 2 — entering a frameset <frame>. ui.vision uses <frameset>/<frame>,
 *   not <iframe>. The resolver used to enumerate only "iframe", so it found
 *   nothing inside a frameset, fell back to a ">>>" piercing selector, and on
 *   failure the Explorer gave up and navigated to the frame URL as a top-level
 *   page. The resolver now enumerates <frame> too and reaches it via
 *   frameLocator, recording a "frame..." chain. A ">>>" selector (even with the
 *   wrong tag guessed) is converted and resolved in-frame, never passed through.
 *
 * Uses local file:// fixtures, no live site, no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { resolve } from '../src/agent/selectors.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { transcribe } from '../src/agent/transcriber.js';
import { transcribePOM } from '../src/agent/pom.js';
import type { RunReport, Scenario, SelectorRecord, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── BUG 1: a filled-input value assertion emits toHaveValue ──────────────── */
// Build a scenario that fills a field then asserts its current value. Both
// emitters must render toHaveValue, NOT toHaveAttribute("value", ...).
const fieldRecord: SelectorRecord = { level: 'label', arg: 'Full Name', intent: 'full name field' };
const fillStep: TraceStep = { kind: 'fill', target: fieldRecord, value: 'Ada Lovelace' };
const valueAssert: TraceStep = {
  kind: 'assert',
  name: 'full name field holds the typed value',
  assertion: { type: 'toHaveValue', target: fieldRecord, value: 'Ada Lovelace' },
};
const valueScenario: Scenario = {
  name: 'typed a name and the field holds it', category: 'happy', feature: 'forms',
  steps: [{ kind: 'navigate', url: 'https://example.com/' }, fillStep, valueAssert],
};
const valueReport: RunReport = {
  url: 'https://example.com/', language: 'ts', scenarios: [valueScenario],
  cascadeStats: { role: 0, label: 1, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
};

const inlineValDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-frameval-inline-'));
const { specPath: valSpecPath } = transcribe({ report: valueReport, outDir: inlineValDir, name: 'forms' });
const inlineValSpec = fs.readFileSync(valSpecPath, 'utf8');
fs.rmSync(inlineValDir, { recursive: true, force: true });
check('A. inline spec emits toHaveValue for the field value assertion',
  /\.toHaveValue\(["']Ada Lovelace["']\)/.test(inlineValSpec));
check('B. inline spec does NOT assert the value via toHaveAttribute',
  !/toHaveAttribute\(["']value["']/.test(inlineValSpec));

const pomValDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-frameval-pom-'));
const pomValRes = transcribePOM({ report: valueReport, outDir: pomValDir, name: 'forms' });
const pomValText = [...pomValRes.pageFiles, ...pomValRes.specFiles].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
fs.rmSync(pomValDir, { recursive: true, force: true });
check('C. POM spec emits toHaveValue for the field value assertion',
  /\.toHaveValue\(["']Ada Lovelace["']\)/.test(pomValText));
check('D. POM spec does NOT assert the value via toHaveAttribute',
  !/toHaveAttribute\(["']value["']/.test(pomValText));

/* ─── BUG 2: a frameset <frame> is entered via frameLocator ────────────────── */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-frameset-'));
const write = (name: string, html: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, html);
  return p;
};
// A frameset page, exactly the ui.vision shape: NO <iframe>, only <frame>, and
// the frames carry only a src (the first also gets an id/name so the chain can
// prefer a stable selector).
write('f1.html', `<!doctype html><html><body>
  <h1 id="frameHeading">Frame one content</h1>
  <input name="mytext1" aria-label="My Text" />
</body></html>`);
write('f2.html', `<!doctype html><html><body><p>second frame</p></body></html>`);
const framesetPath = write('frameset.html', `<!doctype html><html>
  <frameset cols="50%,50%">
    <frame id="frame1" name="left" src="f1.html">
    <frame src="f2.html">
  </frameset>
</html>`);
const framesetUrl = pathToFileURL(framesetPath).href;

const browser = await chromium.launch();
const context = await browser.newContext();
await installEvalShim(context);
const page = await context.newPage();
await page.goto(framesetUrl);

/* the input inside the frameset frame resolves via the cascade inside the frame */
const frameInput = await resolve(page, { intent: 'my text', label: 'My Text' });
check('E. an input inside a frameset <frame> resolves (not null)', !!frameInput,
  'the resolver must enumerate <frame>, not only <iframe>');
check('F. it records a frame chain so the Explorer scopes into the frame',
  !!frameInput?.frameChain && frameInput.frameChain.length === 1, JSON.stringify(frameInput?.frameChain));
check('G. the chain uses a "frame" selector (id-based), never "iframe"',
  frameInput?.frameChain?.[0] === 'frame#frame1', JSON.stringify(frameInput?.frameChain));

/* filling and reading back through frameLocator proves the frame is driven */
if (frameInput) {
  await frameInput.locator.fill('Hello Frame');
  const readBack = await frameInput.locator.inputValue();
  check('H. the in-frame input is filled and read back via frameLocator', readBack === 'Hello Frame', readBack);
} else {
  check('H. the in-frame input is filled and read back via frameLocator', false, 'no locator');
}

/* a heading inside the frame also resolves, with the same frame chain */
const frameHeading = await resolve(page, { intent: 'frame heading', text: 'Frame one content' });
check('I. a heading inside the frameset frame resolves with the frame chain',
  !!frameHeading?.frameChain && frameHeading.frameChain[0] === 'frame#frame1'
  && (await frameHeading.locator.textContent())?.trim() === 'Frame one content');

/* a ">>>" piercing selector (correct frame tag) is converted and resolved in-frame */
const viaPiercing = await resolve(page, { intent: 'my text', css: 'frame#frame1 >>> input[name="mytext1"]' });
check('J. a ">>>" selector for a frameset frame resolves in-frame, not passed through',
  !!viaPiercing && viaPiercing.frameChain?.[0] === 'frame#frame1');

/* the model's WRONG tag guess (iframe for a frameset frame) still resolves via
 * the generic scan fallback, because resolve() strips the frame part and re-scans */
const viaWrongTag = await resolve(page, { intent: 'my text', css: 'iframe#frame1 >>> input[name="mytext1"]' });
check('K. a wrong-tag ">>>" guess still resolves via the frame scan fallback',
  !!viaWrongTag && !!viaWrongTag.frameChain && viaWrongTag.frameChain[0] === 'frame#frame1',
  JSON.stringify(viaWrongTag?.frameChain));

await browser.close();

/* ─── the emitted spec scopes into the frameset frame, never with ">>>" ────── */
const frameRecord: SelectorRecord = {
  level: frameInput!.level, arg: frameInput!.arg, intent: 'my text',
  ambiguous: frameInput!.ambiguous || undefined, frameChain: frameInput!.frameChain,
};
const frameScenario: Scenario = {
  name: 'reads an input inside a frameset frame', category: 'happy', feature: 'frames',
  steps: [
    { kind: 'navigate', url: framesetUrl },
    { kind: 'fill', target: frameRecord, value: 'Hello Frame' },
    { kind: 'assert', name: 'frame input holds the value', assertion: { type: 'toHaveValue', target: frameRecord, value: 'Hello Frame' } },
  ],
};
const frameReport: RunReport = {
  url: framesetUrl, language: 'ts', scenarios: [frameScenario],
  cascadeStats: { role: 0, label: 1, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
};
const frameInlineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-frameset-inline-'));
const { specPath: frameSpecPath } = transcribe({ report: frameReport, outDir: frameInlineDir, name: 'frames' });
const frameInlineSpec = fs.readFileSync(frameSpecPath, 'utf8');
fs.rmSync(frameInlineDir, { recursive: true, force: true });
check('L. inline spec scopes into the frameset frame with frameLocator("frame#frame1")',
  /\.frameLocator\(["']frame#frame1["']\)/.test(frameInlineSpec));
check('M. inline spec never emits a ">>>" piercing selector', !frameInlineSpec.includes('>>>'));
check('N. inline spec verifies the in-frame value with toHaveValue',
  /\.toHaveValue\(["']Hello Frame["']\)/.test(frameInlineSpec));

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: toHaveValue asserts a typed/selected form value, and a frameset <frame> is entered via frameLocator (never ">>>", never a top-level navigate).');
