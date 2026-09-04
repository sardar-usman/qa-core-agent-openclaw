/**
 * Locks the plan parser on the rule-citation bracket (src/agent/planner.ts).
 *
 * The rule-driven format adds an OPTIONAL third bracket after the category:
 *   "1. [login][negative][R3,R7] name — rationale"   → ruleIds ['R3','R7']
 *   "2. [login][edge][-] name — rationale"           → ruleIds [] (no matching rule)
 * Without a requirements map the Planner never emits the bracket, and the old
 * two-bracket and legacy formats must parse EXACTLY as before — same fields,
 * no ruleIds key at all. That is the no-SRS zero-behavior-change invariant.
 *
 * This drives the REAL exported parsePlan, not a mirror.
 */
import { parsePlan } from '../src/agent/planner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── A. three-bracket format with rule ids ────────────────────────────────── */
const withRules = parsePlan('<plan>\n1. [login][negative][R3,R7] rejected a 5-character password — fails if the length rule stops being enforced\n</plan>');
check('A1. line parses', withRules.length === 1);
const a = withRules[0]!;
check('A2. feature parsed', a.feature === 'login');
check('A3. category parsed', a.category === 'negative');
check('A4. ruleIds parsed in order', JSON.stringify(a.ruleIds) === '["R3","R7"]', JSON.stringify(a.ruleIds));
check('A5. name is clean (no bracket residue)', a.name === 'rejected a 5-character password', a.name);
check('A6. rationale parsed', a.rationale.startsWith('fails if the length rule'));

/* ─── B. lowercase / spaced ids normalize ──────────────────────────────────── */
const spaced = parsePlan('1. [cart][happy][r2, r10] added an item and the badge went up — fails if add-to-cart stops writing state');
check('B1. lowercase + spaced ids normalize to R2,R10', JSON.stringify(spaced[0]?.ruleIds) === '["R2","R10"]', JSON.stringify(spaced[0]?.ruleIds));

/* ─── C. [-] means planned with a map but no matching rule ─────────────────── */
const dash = parsePlan('2. [login][edge][-] password field masks input — fails if the field renders the password as plain text');
check('C1. [-] parses', dash.length === 1);
check('C2. [-] yields an EMPTY ruleIds array (present, not absent)', Array.isArray(dash[0]?.ruleIds) && dash[0]!.ruleIds!.length === 0, JSON.stringify(dash[0]));
check('C3. name is clean after [-]', dash[0]!.name === 'password field masks input', dash[0]!.name);

/* ─── D. the old two-bracket format parses unchanged: no ruleIds key at all ── */
const OLD_LINE = '1. [login][happy] logged in with valid credentials — fails if the success path stops landing on the inventory page';
const old = parsePlan(OLD_LINE);
check('D1. two-bracket line parses', old.length === 1);
const d = old[0]!;
check('D2. fields identical to the pre-SRS parse', d.feature === 'login' && d.category === 'happy' && d.name === 'logged in with valid credentials' && d.rationale.startsWith('fails if the success path'));
check('D3. ruleIds key is ABSENT (not empty, not undefined-assigned)', !('ruleIds' in d), JSON.stringify(d));

/* ─── E. legacy no-feature variants still parse, also without ruleIds ──────── */
const legacyVariants = [
  '1. [happy] logged in — fails if login breaks',
  '2. happy logged in — fails if login breaks',
  '3. happy — logged in — fails if login breaks',
  '4. happy: logged in — fails if login breaks',
];
for (const [i, line] of legacyVariants.entries()) {
  const p = parsePlan(line);
  check(`E${i + 1}. legacy variant ${i + 1} parses without ruleIds`, p.length === 1 && p[0]!.category === 'happy' && !('ruleIds' in p[0]!), line);
}

/* ─── F. a mixed plan block parses every format side by side ───────────────── */
const mixed = parsePlan(`<plan>
1. [login][negative][R3] rejected a wrong password — fails if a wrong password is accepted
2. [login][edge][-] password field masks input — fails if the password renders as plain text
3. [cart][happy] added item to cart — fails if the badge stops updating
</plan>`);
check('F1. all three lines parse', mixed.length === 3);
check('F2. rule-cited line has its ids', JSON.stringify(mixed[0]?.ruleIds) === '["R3"]');
check('F3. [-] line has empty ids', Array.isArray(mixed[1]?.ruleIds) && mixed[1]!.ruleIds!.length === 0);
check('F4. two-bracket line has no ruleIds key', !('ruleIds' in mixed[2]!));

/* ─── G. malformed rule brackets do not break the line ─────────────────────── */
const junk = parsePlan('1. [login][negative][R3;R7] rejected a wrong password — fails if a wrong password is accepted');
check('G1. an unparseable rule bracket falls through without crashing', junk.length === 1, JSON.stringify(junk));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the rule-citation bracket parses ids and [-], and the pre-SRS formats parse byte-identically with no ruleIds key.');
