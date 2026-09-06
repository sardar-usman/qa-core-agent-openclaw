/**
 * Locks the checklist-derivation section of the coverage report
 * (src/agent/rule-coverage.ts):
 *   - classifyDerivationCategory maps planned scenarios onto the checklist
 *     (equivalence, boundary, required-omission, format, state-transition)
 *   - computeDerivation records which categories produced scenarios per
 *     feature and which were skipped with the right reason
 *     (not-applicable / budget / no-matching-control)
 *   - renderDerivation prints one line per feature with scenarios planned,
 *     rules cited, and the skipped categories
 *   - renderRuleCoverage includes the derivation block on SRS runs
 *
 * Pure in-code fixtures. No network. No LLM. No browser.
 */
import {
  classifyDerivationCategory,
  categoryApplicable,
  computeDerivation,
  renderDerivation,
  renderRuleCoverage,
  computeRuleCoverage,
} from '../src/agent/rule-coverage.js';
import type { RequirementsMap } from '../src/agent/requirements.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── A. scenario classification ───────────────────────────────────────────── */
const cls = (name: string, rationale = ''): string | null => classifyDerivationCategory({ name, rationale });
check('A1. empty required field -> required-omission', cls('rejected an empty username with the required-field error') === 'required-omission');
check('A2. length edge -> boundary', cls('rejected a 7-character password at the minimum length edge') === 'boundary');
check('A3. malformed email -> format', cls('rejected an email without an @ as not a valid format') === 'format');
check('A4. lockout -> state-transition', cls('locked out the account after repeated failures') === 'state-transition');
check('A5. wrong password -> equivalence (invalid class)', cls('rejected a wrong password with an error message') === 'equivalence');
check('A6. a plain flow scenario classifies as none', cls('added an item to the cart and the badge went up') === null);
check('A7. required-omission wins over the equivalence catch-all', cls('rejected an invalid submission with a blank email field') === 'required-omission');

/* ─── B. applicability from rule text ──────────────────────────────────────── */
const loginFeature = {
  rules: [
    { text: 'The password must be at least 8 characters.', type: 'validation' },
    { text: 'The username is required.', type: 'validation' },
    { text: 'After 3 failed attempts the account is locked out.', type: 'behavior' },
  ],
};
check('B1. numeric length rule makes boundary applicable', categoryApplicable(loginFeature, 'boundary'));
check('B2. required rule makes required-omission applicable', categoryApplicable(loginFeature, 'required-omission'));
check('B3. lockout rule makes state-transition applicable', categoryApplicable(loginFeature, 'state-transition'));
check('B4. no format rule -> format not applicable', !categoryApplicable(loginFeature, 'format'));
check('B5. validation rules make equivalence applicable', categoryApplicable(loginFeature, 'equivalence'));

/* ─── C. computeDerivation ─────────────────────────────────────────────────── */
const map: RequirementsMap = {
  features: [
    {
      name: 'login',
      description: 'sign in',
      rules: [
        { id: 'R1', text: 'The password must be at least 8 characters.', type: 'validation' },
        { id: 'R2', text: 'The username is required, an inline error is shown when empty.', type: 'validation' },
        { id: 'R3', text: 'After 3 failed attempts the account is locked out.', type: 'behavior' },
      ],
    },
    {
      name: 'contact',
      description: 'contact form',
      rules: [
        { id: 'R4', text: 'The email must be a valid email format.', type: 'validation' },
      ],
    },
  ],
  roles: [],
  truncated: false,
};

const planned = [
  { name: 'rejected a 7-character password at the minimum boundary', feature: 'login', ruleIds: ['R1'] },
  { name: 'rejected an empty username with the required error', feature: 'login', ruleIds: ['R2'] },
  { name: 'logged in with valid credentials', feature: 'login', ruleIds: [] },
  // contact planned nothing (its page never got planned)
];

const derivation = computeDerivation({ map, planned, budgetHit: false });
const login = derivation.find((d) => d.feature === 'login');
const contact = derivation.find((d) => d.feature === 'contact');

check('C1. one record per map feature', derivation.length === 2);
check('C2. login counts its scenarios and cited rules', login?.scenariosPlanned === 3 && login?.rulesCited === 2 && login?.rulesTotal === 3, JSON.stringify(login));
check('C3. boundary and required-omission produced', JSON.stringify(login?.produced.map((p) => p.category).sort()) === '["boundary","equivalence","required-omission"]', JSON.stringify(login?.produced));
check('C4. state-transition skipped as no-matching-control (applicable, no budget hit)', login?.skipped.some((s) => s.category === 'state-transition' && s.reason === 'no-matching-control') === true, JSON.stringify(login?.skipped));
check('C5. format skipped as not-applicable for login', login?.skipped.some((s) => s.category === 'format' && s.reason === 'not-applicable') === true);
check('C6. contact with no scenarios skips format as no-matching-control', contact?.scenariosPlanned === 0 && contact?.skipped.some((s) => s.category === 'format' && s.reason === 'no-matching-control') === true, JSON.stringify(contact));

const budgeted = computeDerivation({ map, planned, budgetHit: true });
const budgetedLogin = budgeted.find((d) => d.feature === 'login');
check('C7. with a budget hit, applicable skips classify as budget', budgetedLogin?.skipped.some((s) => s.category === 'state-transition' && s.reason === 'budget') === true, JSON.stringify(budgetedLogin?.skipped));
check('C8. not-applicable stays not-applicable even with a budget hit', budgetedLogin?.skipped.some((s) => s.category === 'format' && s.reason === 'not-applicable') === true);

/* ─── D. rendering ─────────────────────────────────────────────────────────── */
const lines = renderDerivation(derivation);
check('D1. one line per feature', lines.length === 2);
check('D2. the login line carries scenarios, rules cited, and skips',
  lines[0] === 'login: 3 scenario(s) planned · 2/3 rules cited · skipped: format (not-applicable), state-transition (no-matching-control)',
  lines[0]);
check('D3. a feature with nothing planned still prints', lines[1]?.startsWith('contact: 0 scenario(s) planned') === true, lines[1]);

const coverage = {
  ...computeRuleCoverage({ map, planned, scenarios: planned }),
  derivation,
};
const full = renderRuleCoverage(coverage);
check('D4. renderRuleCoverage includes the derivation block', full.some((l) => l.includes('derivation (checklist per feature)')) && full.some((l) => l.includes('login: 3 scenario(s) planned')), JSON.stringify(full));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: derivation classifies checklist categories per feature, names skip reasons, and renders the per-feature considered-not-automated line.');
