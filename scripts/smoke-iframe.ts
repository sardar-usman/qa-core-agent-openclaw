/**
 * Locks iframe support in the resolver (src/agent/selectors.ts) and the emitted
 * spec (pom.ts + transcriber.ts).
 *
 * The Explorer used to fail on any element inside an iframe: it tried a ">>>"
 * piercing selector (which Playwright does not support for frames), gave up,
 * and recorded the scenario as a finding. Now the resolver, when nothing
 * resolves in the main frame, scans iframes (and nested iframes) and re-runs
 * the SAME cascade inside each via page.frameLocator(<iframe>). A hit records
 * the iframe-selector chain so replay and the emitted spec scope into the frame.
 *
 * Checks:
 *   - an element inside an iframe resolves via frameLocator (chain set), NOT a
 *     piercing selector and NOT the top page, and the locator reads the real
 *     in-frame value;
 *   - a nested-frame element chains two frameLocators;
 *   - a ">>>" piercing selector is converted to a frame chain (not left as-is);
 *   - the emitted spec (inline + POM) contains a frameLocator call and no ">>>";
 *   - a top-page element still resolves with no frame chain (no regression).
 *
 * Uses local file:// fixtures, no live site, no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { resolve, parsePiercingSelector } from '../src/agent/selectors.js';
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

/* ─── local fixtures: a top page with a single frame and a nested frame ───── */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-iframe-'));
const write = (name: string, html: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, html);
  return p;
};

write('child.html', `<!doctype html><html><body>
  <h1 id="sampleHeading">This is a sample page</h1>
  <input id="frameName" aria-label="Full Name" />
</body></html>`);
write('deep.html', `<!doctype html><html><body>
  <h1 id="deepHeading">Deep nested heading</h1>
</body></html>`);
write('mid.html', `<!doctype html><html><body>
  <iframe id="inner" src="deep.html"></iframe>
</body></html>`);
const topPath = write('top.html', `<!doctype html><html><body>
  <h1 id="topHeading">Top level heading</h1>
  <iframe id="frame1" src="child.html"></iframe>
  <iframe id="outer" src="mid.html"></iframe>
</body></html>`);
const topUrl = pathToFileURL(topPath).href;

/* ─── parsePiercingSelector is a pure split, test it without a browser ────── */
check('A. parsePiercingSelector returns null without ">>>"',
  parsePiercingSelector('#sampleHeading') === null);
const pierced = parsePiercingSelector('iframe#frame1 >>> #sampleHeading');
check('B. ">>>" splits into [frame] + inner element',
  !!pierced && pierced.frameChain.length === 1 && pierced.frameChain[0] === 'iframe#frame1' && pierced.innerCss === '#sampleHeading');
const piercedNested = parsePiercingSelector('iframe#outer >>> iframe#inner >>> #deepHeading');
check('C. nested ">>>" splits into two frames + inner element',
  !!piercedNested && piercedNested.frameChain.length === 2 && piercedNested.innerCss === '#deepHeading');

const browser = await chromium.launch();
const context = await browser.newContext();
await installEvalShim(context);
const page = await context.newPage();
await page.goto(topUrl);

/* ─── D. an element inside a single iframe resolves via frameLocator ──────── */
const inFrame = await resolve(page, { intent: 'sample heading', text: 'This is a sample page' });
check('D. element inside an iframe resolves', !!inFrame);
check('E. it records a frame chain (it is NOT the top page)',
  !!inFrame?.frameChain && inFrame.frameChain.length === 1, JSON.stringify(inFrame?.frameChain));
check('F. the frame chain is the iframe selector (id-based)',
  inFrame?.frameChain?.[0] === 'iframe#frame1', JSON.stringify(inFrame?.frameChain));
check('G. the resolved locator reads the real in-frame text (not the top doc)',
  (await inFrame!.locator.textContent())?.trim() === 'This is a sample page');

/* an input inside the frame also resolves (cascade runs inside the frame) */
const frameInput = await resolve(page, { intent: 'full name', label: 'Full Name' });
check('H. an input inside the frame resolves via the cascade inside the frame',
  !!frameInput?.frameChain && frameInput.frameChain[0] === 'iframe#frame1');

/* ─── I. a nested-frame element chains two frameLocators ──────────────────── */
const nested = await resolve(page, { intent: 'deep heading', text: 'Deep nested heading' });
check('I. nested-frame element resolves', !!nested);
check('J. the nested chain has two frame selectors (outer then inner)',
  !!nested?.frameChain && nested.frameChain.length === 2
  && nested.frameChain[0] === 'iframe#outer' && nested.frameChain[1] === 'iframe#inner',
  JSON.stringify(nested?.frameChain));
check('K. the nested locator reads the real deep-frame text',
  (await nested!.locator.textContent())?.trim() === 'Deep nested heading');

/* ─── L. a piercing selector is converted, the element resolves in-frame ──── */
const viaPiercing = await resolve(page, { intent: 'sample heading', css: 'iframe#frame1 >>> #sampleHeading' });
check('L. a ">>>" piercing selector resolves to the in-frame element',
  !!viaPiercing && viaPiercing.frameChain?.[0] === 'iframe#frame1'
  && (await viaPiercing.locator.textContent())?.trim() === 'This is a sample page');

/* ─── M. a top-page element still resolves with NO frame chain ───────────── */
const top = await resolve(page, { intent: 'top heading', text: 'Top level heading' });
check('M. a top-page element resolves with no frame chain (no regression)',
  !!top && (!top.frameChain || top.frameChain.length === 0));

await browser.close();

/* ─── N/O. the emitted spec scopes into the frame via frameLocator ───────── */
const frameRecord: SelectorRecord = {
  level: inFrame!.level,
  arg: inFrame!.arg,
  intent: 'sample heading',
  ambiguous: inFrame!.ambiguous || undefined,
  frameChain: inFrame!.frameChain,
};
const nav: TraceStep = { kind: 'navigate', url: topUrl };
const assertVisible: TraceStep = { kind: 'assert', name: 'sample heading is visible', assertion: { type: 'toBeVisible', target: frameRecord } };
const scenario: Scenario = {
  name: 'reads a heading inside an iframe', category: 'happy', feature: 'frames',
  steps: [nav, assertVisible],
};
const report: RunReport = {
  url: topUrl, language: 'ts', scenarios: [scenario],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
};

const inlineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-iframe-inline-'));
const { specPath } = transcribe({ report, outDir: inlineDir, name: 'frames' });
const inlineSpec = fs.readFileSync(specPath, 'utf8');
fs.rmSync(inlineDir, { recursive: true, force: true });
check('N. inline spec scopes into the frame with frameLocator("iframe#frame1")',
  /\.frameLocator\(["']iframe#frame1["']\)/.test(inlineSpec));
check('O. inline spec never emits a ">>>" piercing selector', !inlineSpec.includes('>>>'));

const pomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-iframe-pom-'));
const pomRes = transcribePOM({ report, outDir: pomDir, name: 'frames' });
const pomText = [...pomRes.pageFiles, ...pomRes.specFiles].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
fs.rmSync(pomDir, { recursive: true, force: true });
check('P. POM output scopes into the frame with frameLocator', /\.frameLocator\(["']iframe#frame1["']\)/.test(pomText));
check('Q. POM output never emits a ">>>" piercing selector', !pomText.includes('>>>'));

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: iframe elements resolve via frameLocator (single and nested), piercing selectors are converted, and the emitted spec scopes into the frame.');
