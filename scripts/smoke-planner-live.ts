/**
 * End-to-end verification: call the PRODUCTION plan() function against
 * saucedemo and confirm scenarios come back. This is the test that proves
 * the user-reported "0 scenarios planned" is actually fixed in real code.
 *
 * Cost: ~$0.001 in Haiku tokens.
 */
import 'dotenv/config';
import { plan } from '../src/agent/planner.js';

const result = await plan({ url: 'https://www.saucedemo.com/' });

console.log(`Scenarios returned: ${result.scenarios.length}`);
console.log(`Cost: $${result.costUsd.toFixed(4)}`);
console.log('');
for (const s of result.scenarios) {
  console.log(`  [${s.category}] ${s.name}`);
  console.log(`    rationale: ${s.rationale}`);
}

if (result.scenarios.length === 0) {
  console.error('\nFAIL: planner still returned 0 scenarios');
  process.exit(1);
}
console.log(`\nOK: planner returned ${result.scenarios.length} parsed scenarios (was 0 before the fix)`);
