/**
 * Exercises the Haiku-backed natural-language path in parse-features.ts.
 * Live API call — ~$0.001 per run. Don't ship to CI without an env-gated skip.
 *
 * Use this when you want to verify the LLM path still works after tweaking
 * the SYSTEM prompt or the model fallback. The pure-logic cases live in
 * smoke-parse-features.ts and don't need an API key.
 */
import 'dotenv/config';
import { parseFeatures } from '../src/agent/parse-features.js';

interface Case {
  label: string;
  natural: string;
  expectContainsAll?: string[];
  expectEmpty?: boolean;
}

const cases: Case[] = [
  {
    label: 'A. classic "test X and Y and Z" form',
    natural: 'test login and cart and checkout',
    expectContainsAll: ['login', 'cart', 'checkout'],
  },
  {
    label: 'B. messy sentence with extra context',
    natural: 'I want tests for the search feature, the product listing page, and the wishlist button',
    expectContainsAll: ['search'],
  },
  {
    label: 'C. unrelated request → empty',
    natural: 'just explore the site',
    expectEmpty: true,
  },
  {
    label: 'D. gibberish → empty',
    natural: 'test stuff',
    expectEmpty: true,
  },
];

let pass = 0;
let fail = 0;
let totalCost = 0;

for (const c of cases) {
  const got = await parseFeatures({ naturalInput: c.natural });
  totalCost += got.costUsd ?? 0;
  let ok = got.method === 'natural';
  if (c.expectEmpty) ok = ok && got.features.length === 0;
  if (c.expectContainsAll) {
    for (const expected of c.expectContainsAll) {
      if (!got.features.includes(expected)) {
        ok = false;
        break;
      }
    }
  }
  if (ok) {
    pass++;
    console.log(`OK  ${c.label} → [${got.features.join(', ')}]`);
  } else {
    fail++;
    console.log(`FAIL ${c.label}`);
    console.log(`     expected${c.expectEmpty ? ' empty' : ' to include all of'}: ${JSON.stringify(c.expectContainsAll ?? [])}`);
    console.log(`     got: features=${JSON.stringify(got.features)} method=${got.method}`);
  }
}

console.log(`\n${pass}/${pass + fail} cases passed.`);
console.log(`Total Haiku spend: $${totalCost.toFixed(5)}`);
if (fail > 0) process.exit(1);
console.log('OK: parse-features Haiku path.');
