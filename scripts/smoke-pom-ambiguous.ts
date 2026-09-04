/**
 * Regression test for the POM emitter's ambiguous-locator handling.
 *
 * buildPageClass used to drop the `ambiguous` flag when collapsing selector
 * usage into class fields, so a locator that required .first() during
 * exploration was emitted as a bare class field and tripped Playwright strict
 * mode at runtime. Locks:
 *   - A field built from an ambiguous SelectorRecord emits .first().
 *   - If the same canonical intent was ambiguous in ANY occurrence, the shared
 *     field is ambiguous (ambiguity is sticky across occurrences).
 *   - A field built only from unambiguous records does NOT emit .first().
 *   - toHaveCount never goes through a .first()-wrapped field: it bypasses an
 *     ambiguous field and asserts on the multi-match locator inline.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { transcribePOM } from '../src/agent/pom.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-pom-ambig-'));

const report: RunReport = {
  url: 'https://example.com/',
  language: 'ts',
  scenarios: [
    {
      name: 'clicks the first add to cart button', category: 'happy', feature: 'cart',
      steps: [
        { kind: 'navigate', url: 'https://example.com/' },
        // Ambiguous: several "Add to cart" buttons matched during exploration.
        { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Add to cart', exact: false }, intent: 'add to cart button', ambiguous: true } },
        // Unambiguous locator on the same page.
        { kind: 'click', target: { level: 'role', arg: { role: 'link', name: 'Checkout', exact: true }, intent: 'checkout link' } },
        { kind: 'assert', name: 'badge shows 1', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.badge', intent: 'cart badge' }, text: '1' } },
      ],
    },
    {
      name: 'counts the add to cart buttons', category: 'edge', feature: 'cart',
      steps: [
        { kind: 'navigate', url: 'https://example.com/' },
        // Same canonical intent, recorded WITHOUT ambiguous (toHaveCount strips
        // it). The field must still be ambiguous, and the count assertion must
        // NOT go through the .first()-wrapped field.
        { kind: 'assert', name: 'six buttons', assertion: { type: 'toHaveCount', target: { level: 'role', arg: { role: 'button', name: 'Add to cart', exact: false }, intent: 'add to cart button' }, count: 6 } },
      ],
    },
  ],
  cascadeStats: { role: 3, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 1, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 6,
  startedAt: '2026-09-04T12:00:00Z',
  finishedAt: '2026-09-04T12:00:30Z',
};

transcribePOM({ report, outDir: tmpRoot, name: 'example' });

const pageSource = fs.readFileSync(path.join(tmpRoot, 'pages', 'cart-page.ts'), 'utf8');
const fieldLines = pageSource.split('\n').filter((l) => l.includes('this.'));

const ambiguousField = fieldLines.find((l) => l.includes('Add to cart'));
const cleanField = fieldLines.find((l) => l.includes('Checkout'));

check('A. ambiguous field line exists', ambiguousField !== undefined);
check('B. ambiguous field ends with .first()', /\.first\(\);$/.test(ambiguousField ?? ''), ambiguousField);
check('C. unambiguous field does NOT emit .first()', cleanField !== undefined && !cleanField.includes('.first()'), cleanField);

const spec = fs.readFileSync(path.join(tmpRoot, 'tests', 'cart', 'cart.spec.ts'), 'utf8');
const countLine = spec.split('\n').find((l) => l.includes('toHaveCount'));
check('D. toHaveCount line exists', countLine !== undefined);
check('E. toHaveCount does not assert through a .first() locator', countLine !== undefined && !countLine.includes('.first()'), countLine);
check('F. toHaveCount uses the multi-match locator inline', countLine !== undefined && countLine.includes('getByRole'), countLine);

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: ambiguous selector records carry through to POM class fields.');
