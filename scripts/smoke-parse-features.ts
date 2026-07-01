/**
 * Lock in the feature-list parser behavior:
 *   - comma-separated form (flag input)
 *   - normalization (whitespace → hyphens, lowercase, trim)
 *   - dedup + cap
 *   - precedence (flag wins over natural)
 *   - no-input case
 *
 * The natural-language Haiku path is exercised by a separate live smoke
 * (smoke-parse-features-live.ts) so this file stays free (no network).
 */
import {
  parseCommaSeparated,
  parseFeatures,
} from '../src/agent/parse-features.js';

interface Case {
  label: string;
  input: { flagInput?: string; naturalInput?: string };
  expectFeatures: string[];
  expectMethod: 'none' | 'comma' | 'natural';
}

const cases: Case[] = [
  {
    label: 'A. plain comma list',
    input: { flagInput: 'login,cart,checkout' },
    expectFeatures: ['login', 'cart', 'checkout'],
    expectMethod: 'comma',
  },
  {
    label: 'B. comma list with whitespace + empty entries',
    input: { flagInput: ' login , , cart ,  ' },
    expectFeatures: ['login', 'cart'],
    expectMethod: 'comma',
  },
  {
    label: 'C. mixed case + internal spaces (becomes hyphens)',
    input: { flagInput: 'User Profile, ADD-TO-CART, search bar' },
    expectFeatures: ['user-profile', 'add-to-cart', 'search-bar'],
    expectMethod: 'comma',
  },
  {
    label: 'D. duplicates removed (case-insensitive)',
    input: { flagInput: 'login,Login,LOGIN,cart' },
    expectFeatures: ['login', 'cart'],
    expectMethod: 'comma',
  },
  {
    label: 'E. cap at MAX_FEATURES (8)',
    input: { flagInput: 'a,b,c,d,e,f,g,h,i,j,k' },
    expectFeatures: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    expectMethod: 'comma',
  },
  {
    label: 'F. quotes around individual items are stripped',
    input: { flagInput: '"login",\'cart\',`checkout`' },
    expectFeatures: ['login', 'cart', 'checkout'],
    expectMethod: 'comma',
  },
  {
    label: 'G. flag wins over natural when both provided',
    input: { flagInput: 'login,cart', naturalInput: 'test the search feature' },
    expectFeatures: ['login', 'cart'],
    expectMethod: 'comma',
  },
  {
    label: 'H. empty flag, no natural → method=none',
    input: { flagInput: '' },
    expectFeatures: [],
    expectMethod: 'none',
  },
  {
    label: 'I. no input at all → method=none',
    input: {},
    expectFeatures: [],
    expectMethod: 'none',
  },
  {
    label: 'J. internal hyphens preserved (kebab-case is the wire format)',
    input: { flagInput: 'forgot-password,sign-up' },
    expectFeatures: ['forgot-password', 'sign-up'],
    expectMethod: 'comma',
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const got = await parseFeatures(c.input);
  const featuresOk = JSON.stringify(got.features) === JSON.stringify(c.expectFeatures);
  const methodOk = got.method === c.expectMethod;
  const ok = featuresOk && methodOk;
  if (ok) {
    pass++;
    console.log(`OK  ${c.label}`);
  } else {
    fail++;
    console.log(`FAIL ${c.label}`);
    console.log(`     expected: features=${JSON.stringify(c.expectFeatures)} method=${c.expectMethod}`);
    console.log(`     got:      features=${JSON.stringify(got.features)} method=${got.method}`);
  }
}

// Sanity check on the lower-level helper too.
const directComma = parseCommaSeparated('  login ,Cart, search bar  ');
const directOk = JSON.stringify(directComma) === JSON.stringify(['login', 'cart', 'search-bar']);
if (directOk) {
  pass++;
  console.log('OK  K. parseCommaSeparated direct invocation');
} else {
  fail++;
  console.log(`FAIL K. parseCommaSeparated direct invocation: ${JSON.stringify(directComma)}`);
}

console.log(`\n${pass}/${pass + fail} cases passed.`);
if (fail > 0) process.exit(1);
console.log('OK: parse-features deterministic paths.');
