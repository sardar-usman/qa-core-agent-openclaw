/**
 * Locks the polling after-action read for assert_compare
 * (runStep in src/agent/replay.ts, transcribePOM in pom.ts, transcribe in
 * transcriber.ts).
 *
 * A sort, a re-render, or any async state change settles after the click that
 * triggered it. A single immediate getAttribute/textContent read races that
 * settle and flakes (the tables "last name ascending" sort flaked F-F-F at
 * stability). assert_compare must re-read until the relation holds or the
 * timeout expires, the same web-first wait the completion assertions use for
 * aria-valuenow.
 *
 * Part 1 drives the real replay runStep with a fake page that only settles to
 * the new value on a later read, proving the engine polls instead of reading
 * once. Part 2 checks the emitted spec (POM + inline) uses expect.poll, not a
 * one-shot const read. Zero network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStep } from '../src/agent/replay.js';
import { transcribe } from '../src/agent/transcriber.js';
import { transcribePOM } from '../src/agent/pom.js';
import type { Page } from 'playwright';
import type { RunReport, Scenario, SelectorRecord, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── a fake page whose read settles only on a later call ─────────────────── */
// `reads` is the sequence of values the locator returns, one per read call.
// After the list is exhausted it keeps returning the last value. `count()`
// tracks how many times the page was read so we can prove it re-read.
function fakePage(reads: string[]): { page: Page; count: () => number } {
  let i = 0;
  const next = (): string => {
    const v = reads[Math.min(i, reads.length - 1)] ?? '';
    i++;
    return v;
  };
  const locator = (): unknown => ({
    first() { return this; },
    async textContent() { return next(); },
    async getAttribute() { return next(); },
    async count() { return Number(next()); },
  });
  const page = {
    locator,
    getByRole: locator, getByLabel: locator, getByPlaceholder: locator,
    getByText: locator, getByAltText: locator, getByTitle: locator, getByTestId: locator,
  };
  return { page: page as unknown as Page, count: () => i };
}

const target: SelectorRecord = { level: 'css', arg: '#cell', intent: 'first cell' };
const compareChanged: TraceStep = {
  kind: 'assert_compare', varName: 'v', relation: 'changed', source: 'text',
  target, intent: 'first cell', readVar: 'vNow',
};

/* ─── Part 1: the replay engine re-reads until the value settles ──────────── */

// The value is still the old "Apple" on the first two reads, then settles to
// "Banana". A single read would have seen "Apple" and failed the changed check.
{
  const { page, count } = fakePage(['Apple', 'Apple', 'Banana']);
  const captures = new Map([['v', 'Apple']]);
  let threw = false;
  try {
    await runStep(page, compareChanged, 5000, captures);
  } catch {
    threw = true;
  }
  check('A. assert_compare(changed) passes once the value settles on a later read', !threw);
  check('B. the engine re-read the page more than once (it polled, not single read)', count() > 1, `reads=${count()}`);
}

// The value never changes. A polling read must keep trying, then fail at the
// timeout (not pass, and not give up after one read).
{
  const { page, count } = fakePage(['Apple']);
  const captures = new Map([['v', 'Apple']]);
  let threw = false;
  try {
    await runStep(page, compareChanged, 600, captures);
  } catch {
    threw = true;
  }
  check('C. assert_compare(changed) still fails when the value never settles', threw);
  check('D. the engine polled several times before giving up (not a single read)', count() > 1, `reads=${count()}`);
}

/* ─── Part 2: the emitted spec polls the after-action read ────────────────── */

const navTables: TraceStep = { kind: 'navigate', url: 'http://example.com/tables' };
const clickSort: TraceStep = {
  kind: 'click',
  target: { level: 'role', arg: { role: 'columnheader', name: 'Last Name' }, intent: 'last name header' },
};
const captureCell: TraceStep = {
  kind: 'capture', varName: 'cap_cell', source: 'text', target, intent: 'first cell',
};
const sortScenario: Scenario = {
  name: 'sort changes the first cell', category: 'happy', feature: 'tables',
  steps: [navTables, captureCell, clickSort, compareChangedSpec()],
};
function compareChangedSpec(): TraceStep {
  return { kind: 'assert_compare', varName: 'cap_cell', relation: 'changed', source: 'text', target, intent: 'first cell', readVar: 'cap_cellNow' };
}

const report: RunReport = {
  url: 'http://example.com/tables', language: 'ts',
  scenarios: [sortScenario],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
};

// inline transcriber
const inlineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cmp-inline-'));
const { specPath } = transcribe({ report, outDir: inlineDir, name: 'tables' });
const inlineSpec = fs.readFileSync(specPath, 'utf8');
fs.rmSync(inlineDir, { recursive: true, force: true });

check('E. inline spec polls the after-action read with expect.poll',
  /await expect\.poll\(async \(\) => .+, \{ timeout: \d+ \}\)\.not\.toBe\(cap_cell\)/.test(inlineSpec));
check('F. inline spec does NOT use a one-shot const read + single expect for the compare',
  !/expect\(cap_cellNow\)\.not\.toBe/.test(inlineSpec));
check('G. inline spec still captures the value first into a const',
  /const cap_cell = .+textContent\(\)/.test(inlineSpec));

// POM transcriber
const pomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cmp-pom-'));
const pomRes = transcribePOM({ report, outDir: pomDir, name: 'tables' });
const pomSpec = fs.readFileSync(pomRes.specFiles[0]!, 'utf8');
fs.rmSync(pomDir, { recursive: true, force: true });

check('H. POM spec polls the after-action read with expect.poll',
  /await expect\.poll\(async \(\) => .+, \{ timeout: \d+ \}\)\.not\.toBe\(cap_cell\)/.test(pomSpec));
check('I. POM spec does NOT use a one-shot const read + single expect for the compare',
  !/expect\(cap_cellNow\)\.not\.toBe/.test(pomSpec));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: assert_compare re-reads (polls) after an action until the relation holds; the emitted spec uses expect.poll, not a single immediate read.');
