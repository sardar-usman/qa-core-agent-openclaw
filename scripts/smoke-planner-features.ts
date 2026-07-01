/**
 * Live smoke that proves the Planner actually responds to the `features`
 * option — i.e. `--features login,cart` actually changes WHAT the agent
 * tests, not just what's mentioned in the README.
 *
 * Strategy: call plan() twice against the same URL.
 *   Run A: no features → Planner infers from homepage (could be anything)
 *   Run B: features: ['login'] → Planner MUST only propose login scenarios
 *
 * We assert that Run B's scenarios are all related to "login" — measured by
 * a regex over scenario names + rationales. A drift (e.g. cart scenarios
 * sneaking in) signals the steering text isn't being followed.
 *
 * Cost: ~$0.003 in Haiku tokens (two plan calls).
 */
import 'dotenv/config';
import { plan } from '../src/agent/planner.js';

const URL = 'https://the-internet.herokuapp.com/login';

function fmt(s: { name: string; category: string }): string {
  return `[${s.category}] ${s.name}`;
}

function looksLoginRelated(s: { name: string; rationale: string }): boolean {
  return /\b(login|log in|logged|log-in|sign in|signed in|credential|password|username|authenticat|secure|logout|log out)\b/i.test(
    s.name + ' ' + s.rationale,
  );
}

let pass = 0;
let fail = 0;
let totalCost = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

// Run A — inferred
console.log('=== Run A: no features (inferred from homepage) ===');
const inferred = await plan({ url: URL });
totalCost += inferred.costUsd;
for (const s of inferred.scenarios) console.log('  ' + fmt(s));
check('A. Run A returned at least 1 scenario', inferred.scenarios.length > 0);
console.log(`  cost: $${inferred.costUsd.toFixed(5)}\n`);

// Run B — steered to login
console.log('=== Run B: --features login ===');
const steered = await plan({ url: URL, features: ['login'] });
totalCost += steered.costUsd;
for (const s of steered.scenarios) console.log('  ' + fmt(s));
console.log(`  cost: $${steered.costUsd.toFixed(5)}\n`);

check('B. Run B returned at least 1 scenario', steered.scenarios.length > 0);

// The steering rule: every scenario in Run B must be login-related.
const loginRelated = steered.scenarios.filter(looksLoginRelated);
const offTopic = steered.scenarios.filter((s) => !looksLoginRelated(s));
check(
  `C. Every Run B scenario is login-related (${loginRelated.length}/${steered.scenarios.length})`,
  offTopic.length === 0,
  offTopic.length > 0 ? `off-topic scenarios: ${offTopic.map(fmt).join('; ')}` : undefined,
);

// Sanity — Run B should not propose more than the global cap of 6 scenarios.
check('D. Run B respects the 3-6 scenarios overall cap', steered.scenarios.length <= 6);

// Run C — multiple features
console.log('=== Run C: --features login,registration ===');
const multi = await plan({ url: URL, features: ['login', 'registration'] });
totalCost += multi.costUsd;
for (const s of multi.scenarios) console.log('  ' + fmt(s));
console.log(`  cost: $${multi.costUsd.toFixed(5)}\n`);

check('E. Run C returned at least 1 scenario', multi.scenarios.length > 0);
// Less strict — at least ONE login-related scenario should appear.
// (the-internet.herokuapp.com/login has no registration form, so the Planner
// may legitimately produce only login scenarios for the second feature.)
const someLogin = multi.scenarios.some(looksLoginRelated);
check('F. Run C includes at least one login-related scenario', someLogin);

console.log(`\n${pass}/${pass + fail} checks passed.`);
console.log(`Total Haiku spend across 3 plan calls: $${totalCost.toFixed(5)}`);
if (fail > 0) process.exit(1);
console.log('OK: Planner steering by feature works.');
