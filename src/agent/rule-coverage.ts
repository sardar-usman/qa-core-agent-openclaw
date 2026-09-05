import type { RequirementsMap } from './requirements.js';

/**
 * Rule coverage — the "considered, not automated" report.
 *
 * Given the requirements map, the planned scenarios (which cite rule ids),
 * and the scenarios that survived to the final report, classify every rule:
 *
 *   covered            — at least one surviving scenario cites the rule
 *   planned-but-dropped — a planned scenario cited the rule, but no citing
 *                         scenario survived the pipeline (gate / critic /
 *                         replay / stability / findings)
 *   not-planned        — no planned scenario cited the rule at all
 *
 * A run with a map ends with "X of Y rules covered" plus the named uncovered
 * rules, so a rule that was considered but not automated is reported, never
 * silently absent.
 */

export interface RuleCoverage {
  covered: Array<{ ruleId: string; scenarios: string[] }>;
  uncovered: Array<{ ruleId: string; text: string; reason: 'not-planned' | 'planned-but-dropped' }>;
  /** Per-feature checklist derivation record. Present on SRS runs. */
  derivation?: FeatureDerivation[];
}

/** The systematic derivation checklist the Planner walks per feature. */
export type DerivationCategory =
  | 'equivalence'
  | 'boundary'
  | 'required-omission'
  | 'format'
  | 'state-transition';

export const DERIVATION_CATEGORIES: DerivationCategory[] = [
  'equivalence',
  'boundary',
  'required-omission',
  'format',
  'state-transition',
];

export type DerivationSkipReason = 'no-matching-control' | 'budget' | 'not-applicable';

/**
 * Which checklist categories produced scenarios for one feature, and which
 * were skipped with a named reason. The "considered, not automated" record.
 */
export interface FeatureDerivation {
  feature: string;
  scenariosPlanned: number;
  /** Distinct stated rules cited by this feature's planned scenarios. */
  rulesCited: number;
  rulesTotal: number;
  produced: Array<{ category: DerivationCategory; scenarios: number }>;
  skipped: Array<{ category: DerivationCategory; reason: DerivationSkipReason }>;
}

/** The minimal scenario shape coverage needs: a name plus cited rule ids. */
export interface CitingScenario {
  name: string;
  ruleIds?: string[];
}

/**
 * Normalize a scenario name for matching: lowercase, punctuation stripped,
 * the articles the/a/an dropped, whitespace squashed. The same treatment
 * canonicalIntent gives selector intents, so a small rephrase by the Explorer
 * still keys to the planned name.
 */
const ARTICLES = new Set(['the', 'a', 'an']);
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !ARTICLES.has(w))
    .join(' ');
}

/**
 * Copy each planned scenario's rule citations onto the emitted scenario that
 * fulfilled it. Names are compared via nameKey, exact first, then containment
 * either way, because the Explorer occasionally rephrases a planned name
 * slightly. A scenario with no matching plan entry, or whose plan entry cited
 * no rules, is left untouched.
 */
export function attachRuleIds(scenarios: CitingScenario[], planned: CitingScenario[]): void {
  for (const s of scenarios) {
    const k = nameKey(s.name);
    if (!k) continue;
    const match =
      planned.find((p) => nameKey(p.name) === k) ??
      planned.find((p) => {
        const pk = nameKey(p.name);
        return pk.length > 0 && (k.includes(pk) || pk.includes(k));
      });
    if (match?.ruleIds && match.ruleIds.length > 0) s.ruleIds = [...match.ruleIds];
  }
}

export function computeRuleCoverage(opts: {
  map: RequirementsMap;
  /** The plan as the Planner produced it (rule citations live here). */
  planned: CitingScenario[];
  /** Scenarios that survived to the final report. */
  scenarios: CitingScenario[];
}): RuleCoverage {
  const covered: RuleCoverage['covered'] = [];
  const uncovered: RuleCoverage['uncovered'] = [];
  for (const feature of opts.map.features) {
    for (const rule of feature.rules) {
      const surviving = opts.scenarios.filter((s) => (s.ruleIds ?? []).includes(rule.id));
      if (surviving.length > 0) {
        covered.push({ ruleId: rule.id, scenarios: surviving.map((s) => s.name) });
        continue;
      }
      const wasPlanned = opts.planned.some((p) => (p.ruleIds ?? []).includes(rule.id));
      uncovered.push({
        ruleId: rule.id,
        text: rule.text,
        reason: wasPlanned ? 'planned-but-dropped' : 'not-planned',
      });
    }
  }
  return { covered, uncovered };
}

/** Console lines for the end-of-run coverage summary. */
export function renderRuleCoverage(coverage: RuleCoverage): string[] {
  const total = coverage.covered.length + coverage.uncovered.length;
  const lines: string[] = [`Rule coverage: ${coverage.covered.length} of ${total} rules covered`];
  if (coverage.uncovered.length > 0) {
    lines.push('  considered, not automated:');
    for (const u of coverage.uncovered) {
      lines.push(`    • ${u.ruleId} (${u.reason}) — ${u.text}`);
    }
  }
  if (coverage.derivation && coverage.derivation.length > 0) {
    lines.push('  derivation (checklist per feature):');
    for (const line of renderDerivation(coverage.derivation)) lines.push(`    ${line}`);
  }
  return lines;
}

/* ── Checklist derivation ─────────────────────────────────────────────────── */

/** The planned-scenario shape derivation needs. */
interface DerivableScenario {
  name: string;
  rationale?: string;
  feature?: string;
  ruleIds?: string[];
}

const BOUNDARY_RE = /\b\d+[- ]?(character|char|digit|item|day)s?\b|\bboundary\b|\bmin(imum)?\b|\bmax(imum)?\b|\btoo (short|long|small|large)\b|\bexceed\w*\b|\bat (least|most)\b|\bexactly\b|\blimit\b|\bedge of\b|\bjust (under|over|below|above)\b/i;
// "without" alone is too broad ("an email without an @" is a FORMAT case), so
// it only counts here when followed by a field noun.
const REQUIRED_OMISSION_RE = /\b(empty|blank|missing|omitt?ed|left (out|empty|blank)|no value|unfilled)\b|\bwithout (a |an |the )?(username|password|email|name|value|phone|address|field|input)\b|\brequired\b.*\b(error|message|empty|blank)|\b(empty|blank)\b.*\brequired\b/i;
const FORMAT_RE = /\bformat\w*\b|\bmalformed\b|\bnot a valid\b|\binvalid (email|phone|url|address|date|zip|postcode)\b|\bmissing (@|at sign|domain)\b|\bpattern\b|\bwell-formed\b/i;
// A plain login/logout flow is NOT a transition scenario; the markers here are
// the state changes the checklist names: lockout, expiry, session end, a cart
// emptied, an account disabled.
const STATE_TRANSITION_RE = /\block(ed|s|out| out|-out)\b|\blogged out\b|\bsession\b|\bexpir\w*\b|\bdisabled account\b|\bempt(y|ied) (the )?cart\b|\bcart\b.*\bempty\b|\btransition\w*\b|\bafter (removing|deleting|clearing)\b/i;
const EQUIVALENCE_RE = /\b(valid|invalid|wrong|incorrect|correct|accepted|rejected|mismatched|unknown)\b/i;

/**
 * Classify one planned scenario into the checklist category it derives from,
 * or null when it matches none (a plain flow scenario). Order matters: the
 * specific shapes win before the broad valid/invalid equivalence catch-all.
 * Exported so smoke-derivation-report locks the classifications.
 */
export function classifyDerivationCategory(s: DerivableScenario): DerivationCategory | null {
  const hay = `${s.name} ${s.rationale ?? ''}`.toLowerCase();
  if (REQUIRED_OMISSION_RE.test(hay)) return 'required-omission';
  if (BOUNDARY_RE.test(hay)) return 'boundary';
  if (FORMAT_RE.test(hay)) return 'format';
  if (STATE_TRANSITION_RE.test(hay)) return 'state-transition';
  if (EQUIVALENCE_RE.test(hay)) return 'equivalence';
  return null;
}

/** Is a checklist category applicable to a feature, judged from its stated rules? */
export function categoryApplicable(feature: { rules: Array<{ text: string; type: string }> }, category: DerivationCategory): boolean {
  const validation = feature.rules.filter((r) => r.type === 'validation');
  switch (category) {
    case 'equivalence':
      return validation.length > 0;
    case 'boundary':
      return validation.some((r) => /\b\d+\b|\blength\b|\bmin\b|\bmax\b|\brange\b|\bbetween\b|\bat least\b|\bat most\b/i.test(r.text));
    case 'required-omission':
      return feature.rules.some((r) => /\brequired\b|\bmandatory\b|\bmust (be )?(provide|enter|fill|not be empty|be present)\b/i.test(r.text));
    case 'format':
      return feature.rules.some((r) => /\bformat\b|\bemail\b|\bphone\b|\burl\b|\bpattern\b|\bvalid \w+ address\b/i.test(r.text));
    case 'state-transition':
      return feature.rules.some((r) => /\block\w*\b|\blog ?(in|out)\b|\bsession\b|\bexpir\w*\b|\bempty\b|\bstate\b|\bafter\b/i.test(r.text));
  }
}

/**
 * Build the per-feature derivation record: which checklist categories produced
 * scenarios, and which applicable categories were skipped with a reason.
 *   - not-applicable      — the feature's rules give the category no basis
 *   - budget              — applicable, nothing produced, and the run hit a
 *                           scenario cap (per-page or global)
 *   - no-matching-control — applicable, nothing produced, no cap hit; the page
 *                           most likely lacks the control the category needs
 */
export function computeDerivation(opts: {
  map: RequirementsMap;
  planned: DerivableScenario[];
  /** True when planning stopped at a scenario cap. Turns skips into 'budget'. */
  budgetHit?: boolean;
}): FeatureDerivation[] {
  const out: FeatureDerivation[] = [];
  for (const feature of opts.map.features) {
    const mine = opts.planned.filter((s) => s.feature === feature.name);
    const cited = new Set<string>();
    for (const s of mine) for (const id of s.ruleIds ?? []) cited.add(id);
    const produced: FeatureDerivation['produced'] = [];
    const skipped: FeatureDerivation['skipped'] = [];
    for (const category of DERIVATION_CATEGORIES) {
      const count = mine.filter((s) => classifyDerivationCategory(s) === category).length;
      if (count > 0) {
        produced.push({ category, scenarios: count });
        continue;
      }
      if (!categoryApplicable(feature, category)) {
        skipped.push({ category, reason: 'not-applicable' });
      } else {
        skipped.push({ category, reason: opts.budgetHit ? 'budget' : 'no-matching-control' });
      }
    }
    out.push({
      feature: feature.name,
      scenariosPlanned: mine.length,
      rulesCited: cited.size,
      rulesTotal: feature.rules.length,
      produced,
      skipped,
    });
  }
  return out;
}

/** One console line per feature: scenarios, rules cited, categories skipped. */
export function renderDerivation(derivation: FeatureDerivation[]): string[] {
  return derivation.map((d) => {
    const skippedText = d.skipped.length > 0
      ? d.skipped.map((s) => `${s.category} (${s.reason})`).join(', ')
      : 'none';
    return `${d.feature}: ${d.scenariosPlanned} scenario(s) planned · ${d.rulesCited}/${d.rulesTotal} rules cited · skipped: ${skippedText}`;
  });
}
