/**
 * Locks the Planner's iframe awareness (src/agent/planner.ts).
 *
 * The Planner used to snapshot only the top document, so on an iframe-centric
 * page (letcode.in/frame, demoqa.com/frames) it saw the navbar and theme toggle
 * but never the content INSIDE the frame, and never planned a scenario that
 * touches it. Now the snapshot enumerates content inside iframes (via the
 * Playwright frame API, the same access path frameLocator uses), and a
 * deterministic guarantee injects an inside-frame scenario when the model's plan
 * ignores a content-bearing frame.
 *
 * Checks:
 *   - snapshotPage enumerates content inside a single iframe (heading + input),
 *     with the right frame-selector chain;
 *   - a nested iframe is enumerated with a two-hop chain;
 *   - a content-bearing frame plus a plan that only covers page chrome yields at
 *     least one scenario targeting inside-frame content (the core requirement);
 *   - a plan that already covers the frame is left untouched (no duplicate);
 *   - no content-bearing frame means no injection;
 *   - frameHasContent / scenarioCoversFrame behave at their thresholds.
 *
 * Uses local file:// fixtures, no live site, no network, no API call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import {
  snapshotPage,
  settleForSnapshot,
  ensureIframeCoverage,
  frameHasContent,
  scenarioCoversFrame,
  type PlannedScenario,
} from '../src/agent/planner.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── local fixtures: a top page with a single frame and a nested frame ───── */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-planner-iframe-'));
const write = (name: string, html: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, html);
  return p;
};

write('child.html', `<!doctype html><html><body>
  <h1 id="sampleHeading">This is a sample page</h1>
  <input id="frameName" aria-label="Full Name" />
  <p>Some real paragraph text inside the frame so the text sample is meaningful.</p>
</body></html>`);
write('deep.html', `<!doctype html><html><body>
  <h1 id="deepHeading">Deep nested heading</h1>
</body></html>`);
write('mid.html', `<!doctype html><html><body>
  <iframe id="inner" src="deep.html"></iframe>
</body></html>`);
const topPath = write('top.html', `<!doctype html><html><body>
  <nav><button>Theme toggle</button><a href="#">Menu</a></nav>
  <h1 id="topHeading">Top level heading</h1>
  <iframe id="frame1" src="child.html"></iframe>
  <iframe id="outer" src="mid.html"></iframe>
</body></html>`);
const topUrl = pathToFileURL(topPath).href;

// A frame-only page: the top document is empty, all content lives in the frame.
// This is the ui.vision/frames shape that timed out the settle-poll.
const frameOnlyPath = write('frame-only.html', `<!doctype html><html><body>
  <iframe id="only" src="child.html"></iframe>
</body></html>`);
const frameOnlyUrl = pathToFileURL(frameOnlyPath).href;

// A truly empty page: no top content, no content-bearing frame. Must NOT settle.
const emptyPath = write('empty.html', `<!doctype html><html><body></body></html>`);
const emptyUrl = pathToFileURL(emptyPath).href;

const browser = await chromium.launch();
const context = await browser.newContext();
await installEvalShim(context);
const page = await context.newPage();
await page.goto(topUrl, { waitUntil: 'load' });
// Let the child frames load their documents before snapshotting.
await page.waitForLoadState('networkidle').catch(() => {});

const snap = await snapshotPage(page);

/* ─── A-B. the top document is still captured (no regression) ─────────────── */
check('A. top document headings captured', snap.headings.some((h) => h.label === 'Top level heading'));
check('B. snapshot carries a frames array', Array.isArray(snap.frames) && snap.frames.length >= 2,
  `frames=${snap.frames.length}`);

/* ─── C-F. the single content-bearing frame is enumerated ─────────────────── */
const single = snap.frames.find((f) => f.frameChain.length === 1 && f.frameChain[0] === 'iframe#frame1');
check('C. the single iframe is enumerated by its id-based chain', !!single,
  JSON.stringify(snap.frames.map((f) => f.frameChain)));
check('D. the frame heading inside the iframe is read', !!single && single.headings.some((h) => h.label === 'This is a sample page'));
check('E. the frame input inside the iframe is read', !!single && single.inputs.some((i) => i.label === 'Full Name'));
check('F. the frame text sample is captured (not the top doc text)', !!single && /sample page/i.test(single.textSample));

/* ─── G-H. the nested frame is enumerated with a two-hop chain ────────────── */
const nested = snap.frames.find((f) => f.frameChain.length === 2);
check('G. nested frame enumerated with a two-hop chain', !!nested,
  JSON.stringify(snap.frames.map((f) => f.frameChain)));
check('H. nested chain is outer then inner', !!nested && nested.frameChain[0] === 'iframe#outer' && nested.frameChain[1] === 'iframe#inner',
  JSON.stringify(nested?.frameChain));

/* ─── R-T. the settle-poll treats a frame-only page as settled ────────────── */
const frameOnlyPage = await context.newPage();
await frameOnlyPage.goto(frameOnlyUrl, { waitUntil: 'load' });
const frameOnlySettle = await settleForSnapshot(frameOnlyPage, 6000);
check('R. a frame-only page (empty top doc) is treated as settled, not empty',
  frameOnlySettle.settled, JSON.stringify(frameOnlySettle));
check('S. the settle count comes from the frame content (non-zero)', frameOnlySettle.count > 0);
// And it actually proceeds to a usable snapshot with the frame enumerated.
const frameOnlySnap = await snapshotPage(frameOnlyPage);
check('T. a frame-only page snapshots with its frame content read',
  frameOnlySnap.frames.some((f) => f.headings.some((h) => h.label === 'This is a sample page')));
await frameOnlyPage.close();

/* ─── U. a truly empty page still fails to settle (the signal is real) ────── */
const emptyPage = await context.newPage();
await emptyPage.goto(emptyUrl, { waitUntil: 'load' });
const emptySettle = await settleForSnapshot(emptyPage, 1000);
check('U. a page with no content and no content frame does NOT settle',
  !emptySettle.settled && emptySettle.count === 0, JSON.stringify(emptySettle));
await emptyPage.close();

await browser.close();

/* ─── I. the core requirement: a chrome-only plan gains an inside-frame one ─ */
const chromeOnly: PlannedScenario[] = [
  { feature: 'theme', category: 'happy', name: 'toggled the theme and the palette changed', rationale: 'fails if the theme toggle stops working' },
  { feature: 'nav', category: 'happy', name: 'opened the dropdown menu', rationale: 'fails if the menu stops opening' },
];
const after = ensureIframeCoverage(chromeOnly, snap.frames);
check('I. a content-bearing iframe forces at least one inside-frame scenario',
  after.scenarios.some(scenarioCoversFrame));
check('J. the injected scenario is reported (not silent)', !!after.injected && scenarioCoversFrame(after.injected));
check('K. the injected scenario targets real frame content',
  !!after.injected && /full name|sample page|content/i.test(after.injected.name));
check('L. the original chrome scenarios are kept too', after.scenarios.length === chromeOnly.length + 1);

/* ─── M. a plan that already covers the frame is not duplicated ───────────── */
const alreadyCovers: PlannedScenario[] = [
  { feature: 'iframe', category: 'happy', name: 'read the heading inside the iframe', rationale: 'fails if the frame content cannot be read' },
  { feature: 'theme', category: 'happy', name: 'toggled the theme', rationale: 'fails if toggle breaks' },
];
const after2 = ensureIframeCoverage(alreadyCovers, snap.frames);
check('M. an existing inside-frame scenario is left untouched (no duplicate)',
  after2.injected === null && after2.scenarios.length === alreadyCovers.length);

/* ─── N. no content frame → no injection ──────────────────────────────────── */
const after3 = ensureIframeCoverage(chromeOnly, []);
check('N. no content-bearing frame means no injection',
  after3.injected === null && after3.scenarios.length === chromeOnly.length);

/* ─── O-P. the content / coverage helpers behave at their thresholds ──────── */
check('O. an empty frame is not content-bearing',
  !frameHasContent({ headings: [], inputs: [], buttons: [], editable: 0, textSample: '   ' }));
check('P. a frame with only a heading IS content-bearing',
  frameHasContent({ headings: [{ tag: 'h1', label: 'x' }], inputs: [], buttons: [], editable: 0, textSample: '' }));
check('Q. scenarioCoversFrame matches "iframe" and "frame", not unrelated text',
  scenarioCoversFrame({ feature: 'x', category: 'happy', name: 'read inside the frame', rationale: '' })
  && scenarioCoversFrame({ feature: 'x', category: 'happy', name: 'reads the iframe content', rationale: '' })
  && !scenarioCoversFrame({ feature: 'x', category: 'happy', name: 'logged in with valid credentials', rationale: 'fails if login breaks' }));

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the Planner sees inside iframes and always plans at least one inside-frame scenario on a content-bearing iframe page.');
