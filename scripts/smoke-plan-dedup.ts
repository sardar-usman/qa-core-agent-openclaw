/**
 * Locks Planner-level de-duplication (planner.ts `dedupePlan`).
 *
 * The rule the user asked for: if two planned scenarios capture the same value
 * and assert the same relation after a near-identical action, keep one. A
 * different relation on the same value is NOT a duplicate. Non-capture
 * scenarios (login happy/negative) are never collapsed.
 */
import { dedupePlan } from '../src/agent/planner.js';
import type { PlannedScenario } from '../src/agent/planner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const sc = (feature: string, category: PlannedScenario['category'], name: string, rationale: string): PlannedScenario =>
  ({ feature, category, name, rationale });

/* ─── A. the dynamicid case: click-changed and reload-changed collapse ─────── */
const dynamicid: PlannedScenario[] = [
  sc('dynamic-id', 'happy', 'captured the button id, clicked it, the id changed on next render', 'fails if the id stops regenerating'),
  sc('dynamic-id', 'edge', 'captured the button id, reloaded the page, the id changed', 'fails if the id becomes a stable value'),
  sc('dynamic-id', 'negative', 'previously captured id no longer matches after reload', 'fails if a stale id selector keeps matching'),
];
const a = dedupePlan(dynamicid);
check('A1. one near-duplicate dropped (changed-id pair collapses to one)', a.dropped.length === 1, JSON.stringify(a.dropped.map((d) => d.scenario.name)));
check('A2. two scenarios kept', a.kept.length === 2);
check('A3. the FIRST changed-id scenario is the one kept', a.kept.some((s) => s.name.includes('clicked it')) && !a.kept.some((s) => s.name.includes('reloaded the page, the id changed')));
check('A4. the dropped one points at the kept one as its duplicate', a.dropped[0]?.duplicateOf.name.includes('clicked it') === true);
check('A5. the absent/negative scenario survives (different relation on same value)', a.kept.some((s) => s.name.includes('no longer matches')));

/* ─── B. different relation on the same value is NOT a duplicate ───────────── */
const sameValueDiffRelation: PlannedScenario[] = [
  sc('dynamic-id', 'happy', 'captured the id and proved it changed', 'fails if id freezes'),
  sc('dynamic-id', 'edge', 'captured the id and proved the old id is now absent', 'fails if stale id still resolves'),
];
const b = dedupePlan(sameValueDiffRelation);
check('B1. changed vs absent on the same value: both kept', b.kept.length === 2 && b.dropped.length === 0);

/* ─── C. same relation, different value, is NOT a duplicate ────────────────── */
const diffValue: PlannedScenario[] = [
  sc('cart', 'happy', 'captured the badge count and it increased after add', 'fails if add stops writing state'),
  sc('cart', 'happy', 'captured the total and it increased after add', 'fails if total stops summing'),
];
const c = dedupePlan(diffValue);
check('C1. increased-count vs increased-total: both kept (different value noun)', c.kept.length === 2 && c.dropped.length === 0);

/* ─── D. non-capture scenarios are never collapsed ────────────────────────── */
const plain: PlannedScenario[] = [
  sc('login', 'happy', 'logged in with valid credentials', 'fails if the success path stops landing on inventory'),
  sc('login', 'negative', 'rejected an invalid password', 'fails if a wrong password is accepted'),
];
const d = dedupePlan(plain);
check('D1. two plain login scenarios both survive (no capture signature)', d.kept.length === 2 && d.dropped.length === 0);

/* ─── E. same value+relation but DIFFERENT feature does not collapse ──────── */
const crossFeature: PlannedScenario[] = [
  sc('dynamic-id', 'happy', 'captured the id and it changed', 'fails if id freezes'),
  sc('token-rotation', 'happy', 'captured the id and it changed', 'fails if token freezes'),
];
const e = dedupePlan(crossFeature);
check('E1. same value+relation across different features: both kept', e.kept.length === 2 && e.dropped.length === 0);

/* ─── F. order is preserved among kept scenarios ──────────────────────────── */
check('F1. kept scenarios keep plan order', a.kept[0]?.name.includes('clicked it') === true && a.kept[1]?.name.includes('no longer matches') === true);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: Planner de-dup — same value + same relation + same feature collapses to one, everything else survives.');
