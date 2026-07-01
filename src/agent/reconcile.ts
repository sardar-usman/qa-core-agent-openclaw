import type { RunReport } from './trace.js';

/**
 * Reporting reconciliation.
 *
 * Every scenario the Planner planned must end up generated (shipped in the
 * emitted spec), dropped, incomplete, or a finding, each with a named reason.
 * Nothing vanishes silently.
 *
 *   planned === generated + dropped + incomplete + findings
 *
 * "incomplete" is a scenario the Explorer began but never finalized — usually
 * because the step budget ran out mid-scenario. It is neither shipped nor
 * dropped-by-a-stage; it never reached Replay. It is reported on its own line
 * so the funnel stays honest instead of looking like an unexplained shortfall.
 *
 * "findings" are scenarios where the expected outcome never occurred: the
 * Explorer asserted a success signal the page never produced and, after the
 * retry cap, recorded what actually happened. A finding is a real result (the
 * test would fail), so it is reported on its own line, never shipped green.
 *
 * Drops happen at four stages, in pipeline order:
 *   - gate      — RULE 1/3/4 violation, scenario rejected before Reality-Check
 *   - critic    — verdict rework/reject, not sent to Reality-Check
 *   - replay    — failed the single fresh-context re-run
 *   - stability — flaky or broken across the N iterations (broken includes the
 *                 scenarios the Stabilizer attempted and gave up on)
 *
 * The "stable" headline counts only scenarios that passed every iteration with
 * NO relaxed rule. Scenarios that needed the Stabilizer to pass (recovered) ship
 * but are reported separately, so a relaxed-rule survivor is never sold as a
 * clean pass.
 */

export interface DroppedScenario {
  name: string;
  stage: 'gate' | 'critic' | 'replay' | 'stability';
  reason: string;
}

export interface IncompleteScenario {
  name: string;
  reason: string;
}

export interface FindingScenario {
  name: string;
  /** What the scenario expected to observe (the assumed success signal). */
  expected: string;
  /** Where the page actually stayed. */
  url: string;
  /** Any visible alert / validation / status text at the time. */
  messages: string[];
}

export interface Reconciliation {
  /** Scenarios the Planner planned. Falls back to accountedFor when no plan. */
  planned: number;
  /** Scenarios in the emitted spec (stable + recovered). */
  generated: number;
  /** Every scenario that fell out, each named with stage and reason. */
  dropped: DroppedScenario[];
  /** Scenarios begun but never finalized (e.g. step budget exhausted), each named. */
  incomplete: IncompleteScenario[];
  /** Scenarios whose expected outcome never occurred, each with the real page state. */
  findings: FindingScenario[];
  /** generated + dropped.length + incomplete.length + findings.length. */
  accountedFor: number;
  /**
   * Scenarios the Explorer produced beyond the plan (accountedFor - planned,
   * floored at 0). The Explorer is allowed to add coverage — e.g. an a11y check
   * it found worth doing. These are still fully named in generated/dropped, so
   * they do not break the balance; they are reported as "+N added".
   */
  added: number;
  /**
   * True when nothing vanished unaccounted: accountedFor >= planned. A surplus
   * (Explorer added scenarios) still balances. Only a shortfall — fewer
   * scenarios accounted for than planned, with no incomplete reason for the gap
   * — is a real MISMATCH.
   */
  balanced: boolean;
  /** Shipped AND passed every iteration with no relaxed rule. Excludes recovered. */
  stable: number;
  /** Shipped only after a Stabilizer relaxed-rule fix. */
  recovered: number;
  /** Dropped flaky (passed then failed, not recovered, not a give-up). */
  flaky: number;
  /** Dropped broken, including scenarios the Stabilizer gave up on. */
  broken: number;
  /** True when no Planner plan was recorded and planned fell back to the total. */
  noPlan?: boolean;
  /** Explains the delta when planned !== accountedFor. */
  note?: string;
}

/** Build the reconciliation purely from a finished RunReport. */
export function reconcile(report: RunReport): Reconciliation {
  const generated = report.scenarios.length;
  const dropped: DroppedScenario[] = [];

  // 1. Gate — rejected before Reality-Check.
  for (const b of report.gate?.broken ?? []) {
    dropped.push({
      name: b.scenario,
      stage: 'gate',
      reason: `gate: ${b.reason} (after ${b.attempts} attempt${b.attempts === 1 ? '' : 's'})`,
    });
  }

  // 2. Critic — rework/reject verdicts are not sent to Reality-Check.
  for (const v of report.review?.verdicts ?? []) {
    if (v.verdict === 'pass') continue;
    const why = v.reasons.length > 0 ? `: ${v.reasons.join('; ')}` : '';
    dropped.push({ name: v.scenario, stage: 'critic', reason: `critic ${v.verdict}${why}` });
  }

  // 3. Replay — failed the single fresh-context re-run.
  if (report.replay && !report.replay.skipped) {
    for (const v of report.replay.verdicts) {
      if (v.passed) continue;
      const at = v.failedStep != null ? ` at step ${v.failedStep + 1}` : '';
      const kind = v.stepKind ? ` (${v.stepKind})` : '';
      dropped.push({
        name: v.name,
        stage: 'replay',
        reason: `replay failed${at}${kind}: ${v.error ?? 'unknown error'}`,
      });
    }
  }

  // 4. Stability — flaky or broken across the iterations.
  let stable = generated;
  let recovered = 0;
  let flaky = 0;
  let broken = 0;
  if (report.stability && !report.stability.skipped) {
    stable = 0;
    for (const v of report.stability.verdicts) {
      if (v.classification === 'stable') {
        if (v.relaxed) recovered++;
        else stable++;
        continue;
      }
      if (v.classification === 'broken') {
        broken++;
        const how = v.gaveUp ? 'Stabilizer gave up' : 'every iteration failed';
        dropped.push({
          name: v.name,
          stage: 'stability',
          reason: `broken — ${how} (pattern ${v.pattern})`,
        });
      } else {
        flaky++;
        dropped.push({
          name: v.name,
          stage: 'stability',
          reason: `flaky — passed then failed (pattern ${v.pattern})`,
        });
      }
    }
  }

  // 5. Incomplete — begun but never finalized (step budget exhausted, etc.).
  const incomplete: IncompleteScenario[] = (report.incomplete ?? []).map((i) => ({
    name: i.scenario,
    reason: i.reason,
  }));

  // 6. Findings: expected outcome never occurred (retry cap tripped).
  const findings: FindingScenario[] = (report.findings ?? []).map((f) => ({
    name: f.scenario,
    expected: f.expected,
    url: f.url,
    messages: f.messages,
  }));

  const accountedFor = generated + dropped.length + incomplete.length + findings.length;
  const planned = report.plan?.length ?? accountedFor;
  const noPlan = report.plan == null;
  const added = Math.max(0, accountedFor - planned);
  const shortfall = planned - accountedFor;
  // A surplus is fine — the Explorer added coverage and every extra scenario is
  // named in generated/dropped. Only a shortfall (scenarios unaccounted for) is
  // a real mismatch.
  const balanced = shortfall <= 0;
  let note: string | undefined;
  if (noPlan) {
    note = 'no Planner plan recorded — reconciled against the pipeline total';
  } else if (added > 0) {
    note = `Explorer added ${added} scenario(s) beyond the ${planned} planned (e.g. an a11y check). All ${accountedFor} are named below, so the run still balances.`;
  } else if (shortfall > 0) {
    note = `Explorer accounted for ${accountedFor} scenario(s) vs ${planned} planned (${shortfall} fewer). ${shortfall} planned scenario(s) vanished without a drop or incomplete reason.`;
  }

  return { planned, generated, dropped, incomplete, findings, accountedFor, added, balanced, stable, recovered, flaky, broken, noPlan, note };
}

/**
 * Render the reconciliation as plain text lines for the CLI and gateway.
 * Names every dropped scenario and its reason.
 */
export function renderReconciliation(rec: Reconciliation): string[] {
  const lines: string[] = [];
  const balanceMark = rec.balanced ? 'OK' : 'MISMATCH';
  // Only show the incomplete term when there is something incomplete, so clean
  // runs keep the familiar "generated + dropped" line.
  const incompleteTerm = rec.incomplete.length > 0 ? ` + incomplete ${rec.incomplete.length}` : '';
  const findingsTerm = rec.findings.length > 0 ? ` + findings ${rec.findings.length}` : '';
  // When the Explorer added scenarios beyond the plan, annotate the planned term
  // so the surplus is visible and the [OK] mark is not surprising.
  const plannedTerm = rec.added > 0 ? `planned ${rec.planned} (+${rec.added} added)` : `planned ${rec.planned}`;
  lines.push(
    `Reconciliation: ${plannedTerm} = generated ${rec.generated} + dropped ${rec.dropped.length}${incompleteTerm}${findingsTerm} [${balanceMark}]`,
  );
  lines.push(
    `  stable ${rec.stable} · recovered ${rec.recovered} · flaky ${rec.flaky} · broken ${rec.broken}` +
      (rec.recovered > 0 ? '   (stable excludes recovered — relaxed-rule survivors)' : ''),
  );
  if (rec.dropped.length > 0) {
    lines.push('  dropped:');
    for (const d of rec.dropped) {
      lines.push(`    • [${d.stage}] "${d.name}" — ${d.reason}`);
    }
  }
  if (rec.incomplete.length > 0) {
    lines.push('  incomplete:');
    for (const i of rec.incomplete) {
      lines.push(`    • "${i.name}" — ${i.reason}`);
    }
  }
  if (rec.findings.length > 0) {
    lines.push('  findings (expected outcome did not occur):');
    for (const f of rec.findings) {
      const msg = f.messages.length > 0 ? ` Page said: ${f.messages.join(' | ')}.` : ' No visible message.';
      lines.push(`    • "${f.name}" — expected ${f.expected}, page stayed at ${f.url}.${msg}`);
    }
  }
  if (rec.note) lines.push(`  note: ${rec.note}`);
  return lines;
}
