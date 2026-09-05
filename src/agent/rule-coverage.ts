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
}

/** The minimal scenario shape coverage needs: a name plus cited rule ids. */
interface CitingScenario {
  name: string;
  ruleIds?: string[];
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
  return lines;
}
