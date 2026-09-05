/**
 * Locks the Critic verdict parse (src/agent/critic.ts):
 *   - the verdict array is extracted with a bracket-depth scan, so the nested
 *     reasons/required_fixes arrays inside each verdict object no longer
 *     truncate the match at the first "]" (the bug that made every run report
 *     0 verdicts while the summary paragraph parsed fine)
 *   - fenced ```json responses parse
 *   - brackets inside quoted strings and inside the <summary> prose do not
 *     confuse the scan
 *   - a malformed or truncated response returns [] without throwing
 *   - gateByVerdicts drops rework/reject scenarios and keeps pass scenarios
 *
 * Pure in-code fixtures. No network. No LLM. No browser.
 */
import { parseVerdicts, gateByVerdicts } from '../src/agent/critic.js';
import { attachRuleIds, computeRuleCoverage } from '../src/agent/rule-coverage.js';
import type { RequirementsMap } from '../src/agent/requirements.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── A. canonical response: nested arrays + summary ───────────────────────── */
// This is the exact shape the SYSTEM prompt mandates. The old lazy regex
// matched from the array opener to the first "]", the close of the first
// object's reasons array, so JSON.parse always threw and 0 verdicts came back.
const canonical = `[
  { "scenario": "rejected empty username with error message", "verdict": "pass", "reasons": ["asserts the visible error text"], "required_fixes": [] },
  { "scenario": "logged in with valid credentials", "verdict": "rework", "reasons": ["outcome assertion missing"], "required_fixes": ["assert the inventory list is visible after login"] }
]

<summary>
The overall spec quality is good.
</summary>`;

const a = parseVerdicts(canonical);
check('A1. canonical response yields every verdict, not zero', a.length === 2, `got ${a.length}`);
check('A2. first verdict carries scenario, verdict, and reasons intact',
  a[0]?.scenario === 'rejected empty username with error message' && a[0]?.verdict === 'pass' && a[0]?.reasons[0] === 'asserts the visible error text');
check('A3. required_fixes array survives on the rework verdict',
  a[1]?.verdict === 'rework' && a[1]?.required_fixes[0] === 'assert the inventory list is visible after login');

/* ─── B. fenced variant ────────────────────────────────────────────────────── */
const fenced = 'Here is my review.\n```json\n' + canonical.split('<summary>')[0] + '\n```\n<summary>Fine.</summary>';
const b = parseVerdicts(fenced);
check('B1. fenced ```json response parses the same', b.length === 2 && b[0]?.verdict === 'pass' && b[1]?.verdict === 'rework');

/* ─── C. malformed responses return [] without throwing ───────────────────── */
check('C1. plain prose with no array returns []', parseVerdicts('No JSON here at all.').length === 0);
check('C2. truncated JSON (max_tokens cut mid-array) returns []',
  parseVerdicts('[\n  { "scenario": "s1", "verdict": "pass", "reasons": ["r').length === 0);
check('C3. broken JSON inside a balanced array returns []',
  parseVerdicts('[ { scenario: unquoted } ]').length === 0);
check('C4. empty response returns []', parseVerdicts('').length === 0);

/* ─── D. real saved-run shape (saucedemo run-report fixture) ───────────────── */
// Names from output/saucedemo-automation-framework/run-report.json. The rework
// reason quotes "[no-timeout]" and the summary cites rule ids in brackets;
// neither bracket may end the scan early.
const real = `Here are my verdicts for the five scenarios:

[
  { "scenario": "logged in with valid credentials and landed on inventory page", "verdict": "pass", "reasons": ["asserts the post-login inventory container"], "required_fixes": [] },
  { "scenario": "rejected empty username with error message", "verdict": "pass", "reasons": ["specific error text assertion"], "required_fixes": [] },
  { "scenario": "rejected password-only submission with error message", "verdict": "pass", "reasons": ["specific error text assertion"], "required_fixes": [] },
  { "scenario": "rejected mismatched credentials with error message", "verdict": "rework", "reasons": ["error assertion has [no-timeout] on an async banner"], "required_fixes": ["use a timeout of at least 10000ms"] },
  { "scenario": "locked out user sees account locked error", "verdict": "pass", "reasons": ["asserts the lockout message"], "required_fixes": [] }
]

<summary>
The overall spec quality is high. All five scenarios [R2, R4, R5, R6, R7] cover distinct paths through the login flow.
</summary>`;

const d = parseVerdicts(real);
check('D1. all 5 verdicts parse from the real response shape', d.length === 5, `got ${d.length}`);
check('D2. a bracket inside a quoted reason does not end the array',
  d[3]?.verdict === 'rework' && d[3]?.reasons[0]?.includes('[no-timeout]') === true, JSON.stringify(d[3]));
check('D3. brackets in the summary prose do not confuse the scan',
  d[4]?.scenario === 'locked out user sees account locked error');
check('D4. input order is preserved',
  d.map((v) => v.scenario.split(' ')[0]).join(',') === 'logged,rejected,rejected,rejected,locked');

/* ─── E. hostile preamble and odd shapes ───────────────────────────────────── */
check('E1. a bracketed fragment in the preamble is skipped',
  parseVerdicts('Scenario [login] looks solid. Ratings [1] out of scope.\n' + canonical).length === 2);
check('E2. an unknown verdict value coerces to rework',
  parseVerdicts('[{ "scenario": "s", "verdict": "ship", "reasons": ["r"], "required_fixes": [] }]')[0]?.verdict === 'rework');
check('E3. non-object array elements are filtered out',
  parseVerdicts('[{ "scenario": "s", "verdict": "pass", "reasons": ["r"], "required_fixes": [] }, 42, null]').length === 1);
check('E4. a string reasons field coerces to a one-element array',
  JSON.stringify(parseVerdicts('[{ "scenario": "s", "verdict": "pass", "reasons": "solid", "required_fixes": [] }]')[0]?.reasons) === '["solid"]');

/* ─── F. gateByVerdicts drops rework/reject, keeps pass ────────────────────── */
const scenarios = [
  { name: 'logged in with valid credentials and landed on inventory page' },
  { name: 'rejected empty username with error message' },
  { name: 'rejected password-only submission with error message' },
  { name: 'rejected mismatched credentials with error message' },
  { name: 'locked out user sees account locked error' },
];
const gated = gateByVerdicts(scenarios, d);
check('F1. the rework scenario is dropped before Reality-Check',
  gated.dropped.length === 1 && gated.dropped[0] === 'rejected mismatched credentials with error message');
check('F2. the 4 pass scenarios are kept in order',
  gated.kept.length === 4 && gated.kept.every((s) => s.name !== gated.dropped[0]));
check('F3. a verdict naming an unknown scenario drops nothing',
  gateByVerdicts(scenarios, [{ scenario: 'no such scenario', verdict: 'reject', reasons: [], required_fixes: [] }]).kept.length === 5);
check('F4. zero verdicts keeps every scenario (the gate is inert, never destructive)',
  gateByVerdicts(scenarios, []).kept.length === 5);

/* ─── G. end to end: a critic-gated scenario's rule is planned-but-dropped ── */
// parse -> gate -> attachRuleIds -> computeRuleCoverage, the same chain the
// runtime walks. The gated rework scenario cited R5; its rule must come out
// planned-but-dropped, while the surviving scenario's R6 stays covered.
const map: RequirementsMap = {
  features: [{
    name: 'login',
    description: 'Users sign in with username and password.',
    rules: [
      { id: 'R5', text: 'Mismatched credentials show an error.', type: 'validation' },
      { id: 'R6', text: 'Valid credentials land on the inventory page.', type: 'navigation' },
    ],
  }],
  roles: [],
  truncated: false,
};
const planned = [
  { name: 'rejected mismatched credentials with error message', ruleIds: ['R5'] },
  { name: 'logged in with valid credentials and landed on inventory page', ruleIds: ['R6'] },
];
const survivors: Array<{ name: string; ruleIds?: string[] }> = gated.kept.map((s) => ({ name: s.name }));
attachRuleIds(survivors, planned);
const coverage = computeRuleCoverage({ map, planned, scenarios: survivors });
check('G1. the surviving scenario keeps its rule covered',
  coverage.covered.length === 1 && coverage.covered[0]?.ruleId === 'R6');
check('G2. the critic-gated scenario\'s rule classifies planned-but-dropped',
  coverage.uncovered.length === 1 && coverage.uncovered[0]?.ruleId === 'R5' && coverage.uncovered[0]?.reason === 'planned-but-dropped',
  JSON.stringify(coverage.uncovered));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the Critic verdict array parses fully via the bracket-depth scan, malformed responses fail soft, and the gate drops rework/reject scenarios.');
