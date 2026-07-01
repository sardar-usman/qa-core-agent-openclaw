/**
 * Locks in the URL-validation behaviour that stops /explore from ever
 * scaffolding a framework for invalid input.
 *
 * The bug we're guarding against:
 *   user typed `/explore -- (ts)` → gateway grabbed "--" as the URL →
 *   Planner failed → agent still wrote `output/site-automation-framework/`
 *   with 0 scenarios + 11 files + a downloadable zip + charged $0.0252.
 *
 * Two-layer fix locked in here:
 *   1. normalizeAndValidateUrl() rejects obvious non-URLs at the input
 *      boundary (gateway /explore parser + cli/explore.ts parseArgs).
 *   2. The scaffold call site refuses to write a framework when the report
 *      contains 0 scenarios (test isn't covered here — it's just a guard
 *      in the call site, since scaffold itself is allowed to handle empty
 *      reports for future use cases like /generate).
 *
 * Zero network, zero LLM.
 */
import { normalizeAndValidateUrl } from '../src/agent/scaffold.js';

interface Case {
  input: string;
  expectOk: boolean;
  expectNormalized?: boolean;
  expectedUrl?: string;
  /** A substring that must appear in the rejection reason. */
  reasonContains?: string;
}

const CASES: Case[] = [
  // ─── Invalid — these triggered the original bug ───────────────────────
  { input: '--', expectOk: false, reasonContains: 'URL' },
  { input: '(ts)', expectOk: false, reasonContains: "doesn't start" },
  { input: '', expectOk: false, reasonContains: 'empty' },
  { input: '   ', expectOk: false, reasonContains: 'empty' },
  { input: '-', expectOk: false, reasonContains: 'URL' },
  { input: '???', expectOk: false, reasonContains: 'URL' },
  { input: '...', expectOk: false, reasonContains: 'URL' },

  // ─── Invalid protocols ────────────────────────────────────────────────
  { input: 'ftp://shop.com', expectOk: false, reasonContains: 'doesn\'t start' },
  { input: 'javascript:alert(1)', expectOk: false, reasonContains: 'doesn\'t start' },
  { input: 'file:///etc/passwd', expectOk: false, reasonContains: 'doesn\'t start' },

  // ─── Looks like a URL but isn't usable ────────────────────────────────
  { input: 'https://', expectOk: false },
  { input: 'http://', expectOk: false },
  { input: 'https://foo', expectOk: false, reasonContains: 'hostname' },
  { input: 'not a url with spaces', expectOk: false },

  // ─── Valid — pass straight through ────────────────────────────────────
  { input: 'https://www.saucedemo.com/', expectOk: true, expectedUrl: 'https://www.saucedemo.com/' },
  { input: 'https://practicesoftwaretesting.com', expectOk: true, expectedUrl: 'https://practicesoftwaretesting.com/' },
  { input: 'http://localhost:3000', expectOk: true, expectedUrl: 'http://localhost:3000/' },
  { input: 'http://localhost:3000/path?q=1', expectOk: true },

  // ─── Valid but missing protocol — auto-normalised ────────────────────
  { input: 'shop.com', expectOk: true, expectNormalized: true, expectedUrl: 'https://shop.com/' },
  { input: 'www.saucedemo.com', expectOk: true, expectNormalized: true, expectedUrl: 'https://www.saucedemo.com/' },
  { input: 'the-internet.herokuapp.com/login', expectOk: true, expectNormalized: true },
];

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

for (const c of CASES) {
  const got = normalizeAndValidateUrl(c.input);

  if (c.expectOk) {
    check(`accepts: ${JSON.stringify(c.input)}`, got.ok === true, JSON.stringify(got));
    if (got.ok) {
      if (c.expectedUrl !== undefined) {
        check(`  → normalises to ${c.expectedUrl}`, got.url === c.expectedUrl, got.url);
      }
      if (c.expectNormalized !== undefined) {
        check(`  → normalized flag = ${c.expectNormalized}`, got.normalized === c.expectNormalized);
      }
    }
  } else {
    check(`rejects: ${JSON.stringify(c.input)}`, got.ok === false, JSON.stringify(got));
    if (!got.ok && c.reasonContains) {
      const ok = got.reason.toLowerCase().includes(c.reasonContains.toLowerCase());
      check(`  → reason mentions "${c.reasonContains}"`, ok, got.reason);
    }
  }
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: URL validator accepts real URLs and rejects garbage that would have produced empty frameworks.');
