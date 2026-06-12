import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { explore, type ReviewPaused } from '../agent/runtime.js';
import { transcribe } from '../agent/transcriber.js';
import { transcribePOM } from '../agent/pom.js';
import { readCsv } from '../agent/csv.js';
import type { PlannedScenario } from '../agent/planner.js';

/**
 * CLI:  npm run explore -- <url> [--lang ts|js] [--name <basename>] [--out <dir>]
 *
 * Drives the tool-use loop against <url>, then transcribes the verified trace
 * into a Playwright spec under output/<run-id>/.
 */

interface ParsedArgs {
  url?: string;
  lang: 'ts' | 'js';
  name?: string;
  outBase?: string;
  review: boolean;
  fromPlan?: string;
  /** Emit a Page Object Model framework instead of a single inline spec. Default: true. */
  pom: boolean;
  /** Run the reality-check replay pass after the Critic. Default: true. */
  replay: boolean;
  /** Run the stability iteration after replay. Default: true. */
  stability: boolean;
  /** Number of stability iterations per scenario. Default: 3. */
  stabilityIterations: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const parsed: ParsedArgs = {
    lang: 'ts',
    review: false,
    pom: true,
    replay: true,
    stability: true,
    stabilityIterations: 3,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--lang') { const v = args[++i]; parsed.lang = (v === 'js' ? 'js' : 'ts'); }
    else if (a === '--name') parsed.name = args[++i];
    else if (a === '--out') parsed.outBase = args[++i];
    else if (a === '--review') parsed.review = true;
    else if (a === '--from-plan') parsed.fromPlan = args[++i];
    else if (a === '--no-pom' || a === '--inline') parsed.pom = false;
    else if (a === '--pom') parsed.pom = true;
    else if (a === '--no-replay') parsed.replay = false;
    else if (a === '--replay') parsed.replay = true;
    else if (a === '--no-stability') parsed.stability = false;
    else if (a === '--stability') {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
        console.error(`✗ --stability expects a positive integer (got "${args[i]}")`);
        process.exit(1);
      }
      parsed.stabilityIterations = n;
    }
    else if (a && !parsed.url) parsed.url = a;
  }
  if (!parsed.url && !parsed.fromPlan) {
    console.error('Usage:');
    console.error('  npm run explore -- <url> [--lang ts|js] [--name foo] [--out dir] [--review] [--no-pom] [--no-replay] [--no-stability] [--stability N]');
    console.error('  npm run explore -- --from-plan <plan.csv> [--lang ts|js] [--name foo] [--no-pom] [--no-replay] [--no-stability] [--stability N]');
    process.exit(1);
  }
  return parsed;
}

interface ParsedPlanFile {
  url: string;
  scenarios: PlannedScenario[];
}

function readPlanFile(planPath: string): ParsedPlanFile {
  if (!fs.existsSync(planPath)) {
    console.error(`✗ Plan file not found: ${planPath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(planPath, 'utf8');

  // Pull the URL from the comment header the writer emits.
  const urlMatch = raw.match(/^#\s*QA-Core review plan for\s+(\S+)/m);
  const url = urlMatch?.[1] ?? '';
  if (!url) {
    console.error(`✗ Could not read the original URL from ${planPath}.`);
    console.error(`  The file's header should start with: # QA-Core review plan for <url>`);
    process.exit(1);
  }

  // Strip comment lines so the CSV reader only sees data.
  const csvText = raw.split('\n').filter((l) => !l.startsWith('#')).join('\n');
  const rows = readCsv(csvText);
  const approved = rows
    .filter((r) => /^(y|yes|true|1)$/i.test((r['Approve'] ?? '').trim()))
    .map((r): PlannedScenario => ({
      name: r['Scenario'] ?? '',
      category: (r['Category'] as PlannedScenario['category']) ?? 'happy',
      rationale: r['Rationale'] ?? '',
    }))
    .filter((s) => s.name.length > 0);

  if (approved.length === 0) {
    console.error(`✗ No scenarios approved in ${planPath}. Set Approve=yes on at least one row.`);
    process.exit(1);
  }
  return { url, scenarios: approved };
}

function runId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function slug(s: string): string {
  return s.replace(/^https?:\/\//, '').replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const base = args.outBase ?? path.join(process.cwd(), 'output');

  // Resolve URL + scenarios depending on mode (review-resume vs fresh).
  let url: string;
  let fromPlan: PlannedScenario[] | undefined;
  let outDir: string;
  if (args.fromPlan) {
    const parsed = readPlanFile(args.fromPlan);
    url = parsed.url;
    fromPlan = parsed.scenarios;
    // Keep the run alongside the plan file so the spec and the plan stay together.
    outDir = path.dirname(path.resolve(args.fromPlan));
    console.log(`▸ Resuming from plan: ${path.relative(process.cwd(), args.fromPlan)}`);
    console.log(`  ${parsed.scenarios.length} approved scenarios for ${url}`);
  } else {
    url = args.url!;
    outDir = path.join(base, `${runId()}-${slug(url)}`);
    console.log(`▸ Exploring ${url}`);
    if (args.review) console.log('  mode: review (pause after Planner)');
  }
  console.log(`  language: ${args.lang}`);
  console.log(`  output:   ${path.relative(process.cwd(), outDir)}`);
  console.log('');

  const specName = args.name ?? slug(url);
  const lang = args.lang;

  const totalStages = 3 + (args.replay ? 1 : 0) + (args.stability ? 1 : 0);
  const result = await explore({
    url, language: lang, outDir,
    review: args.review,
    fromPlan,
    skipReplay: !args.replay,
    skipStability: !args.stability,
    stabilityIterations: args.stabilityIterations,
    onEvent: (e) => {
      switch (e.type) {
        case 'plan_started':
          console.log(`\n[1/${totalStages}] Planner …`); break;
        case 'plan_done':
          console.log(`      ${e.scenarios.length} scenarios planned · $${e.usd.toFixed(4)}`);
          for (const s of e.scenarios) {
            console.log(`        · [${s.category}] ${s.name}`);
          }
          console.log(`\n[2/${totalStages}] Explorer …`);
          break;
        case 'thinking_started':
          process.stdout.write('      · thinking…\r'); break;
        case 'tool_call':
          console.log(`      → ${e.name}(${trimJson(e.input)})`); break;
        case 'tool_result':
          if (!e.ok) console.log(`        ✗ ${e.error}`); break;
        case 'message':
          if (e.text.length < 240) console.log(`      ${e.text.trim()}`); break;
        case 'usage':
          process.stdout.write(`      $${e.usd.toFixed(4)} · ${e.tokens} tok\r`); break;
        case 'critic_started':
          console.log(`\n[3/${totalStages}] Critic …`); break;
        case 'critic_done':
          console.log(`      ${e.verdicts.length} verdicts · $${e.usd.toFixed(4)}`);
          for (const v of e.verdicts) {
            const mark = v.verdict === 'ship' ? '✓' : v.verdict === 'weak' ? '!' : '✗';
            console.log(`        ${mark} ${v.scenario} — ${v.reason}`);
          }
          break;
        case 'replay_started':
          console.log(`\n[4/${totalStages}] Reality check · replaying ${e.total} scenario(s) headlessly …`); break;
        case 'replay_scenario_passed':
          console.log(`      ✓ ${e.name}  (${e.durationMs}ms)`); break;
        case 'replay_scenario_failed':
          console.log(`      ✗ ${e.name}  (step ${e.failedStep + 1} ${e.stepKind}: ${truncate(e.error, 120)})`); break;
        case 'replay_done':
          console.log(`      ${e.passed} passed · ${e.failed} dropped · ${(e.durationMs / 1000).toFixed(1)}s`); break;
        case 'stability_started': {
          const stage = args.replay ? 5 : 4;
          console.log(`\n[${stage}/${totalStages}] Stability · ${e.iterations}× re-run on ${e.total} survivor(s) …`);
          break;
        }
        case 'stability_iteration_passed':
          console.log(`      ✓ ${e.name}  iter ${e.iteration}  (${e.durationMs}ms)`); break;
        case 'stability_iteration_failed':
          console.log(`      ✗ ${e.name}  iter ${e.iteration} (step ${e.failedStep + 1} ${e.stepKind}: ${truncate(e.error, 120)})`); break;
        case 'stability_done':
          console.log(`      ${e.stable} stable · ${e.flaked} flaked · flake_rate=${(e.flakeRate * 100).toFixed(1)}% · ${(e.durationMs / 1000).toFixed(1)}s`); break;
        case 'review_paused':
          console.log(`\n■ Paused for review.`); break;
        case 'done':
          console.log(`\n✓ ${e.scenarios} scenario(s) emitted`); break;
      }
    },
  });

  // Review mode: Explorer never ran. Print resume instructions and stop.
  if (isPaused(result)) {
    console.log('');
    console.log(`Wrote ${path.relative(process.cwd(), result.planPath)} (${result.scenarios.length} scenarios)`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Open the CSV in Excel / Numbers / Sheets / a text editor.');
    console.log('  2. Set Approve=no on any scenarios you want to skip.');
    console.log('  3. Resume:');
    console.log(`       npm run explore -- --from-plan ${path.relative(process.cwd(), result.planPath)}`);
    return;
  }

  let primaryPath: string;
  let scenarios: number;
  if (args.pom) {
    const pom = transcribePOM({ report: result, outDir, name: specName });
    primaryPath = pom.specFile;
    scenarios = pom.scenarios;
    console.log(`\nWrote POM framework under ${path.relative(process.cwd(), pom.rootDir)}/`);
    console.log(`  pages/        ${pom.pageFiles.length} page object class(es)`);
    console.log(`  tests/        ${path.basename(pom.specFile)}`);
    console.log(`  a11y/         ${path.basename(pom.a11yFile)}`);
    console.log(`  scenarios:    ${scenarios}`);
  } else {
    const r = transcribe({ report: result, outDir, name: specName });
    primaryPath = r.specPath;
    scenarios = r.scenarios;
    console.log(`\nWrote ${path.relative(process.cwd(), r.specPath)} (${scenarios} scenarios)`);
  }
  const totalUsd = result.cost.usd + (result.cost.plannerUsd ?? 0) + (result.cost.criticUsd ?? 0);
  console.log(`Cost: $${totalUsd.toFixed(4)} total ` +
    `(planner $${(result.cost.plannerUsd ?? 0).toFixed(4)}, ` +
    `explorer $${result.cost.usd.toFixed(4)}, ` +
    `critic $${(result.cost.criticUsd ?? 0).toFixed(4)}) · ` +
    `cache_read=${result.cost.cacheReadTokens}`);
  console.log(`Cascade: ${JSON.stringify(result.cascadeStats)}`);
  if (result.review?.summary) {
    console.log(`\nCritic: ${result.review.summary}`);
  }
  if (result.replay && !result.replay.skipped) {
    const total = result.replay.passed + result.replay.failed;
    const pct = total > 0 ? Math.round((result.replay.passed / total) * 100) : 0;
    console.log(`Reality check: ${result.replay.passed}/${total} passed twice (${pct}%) · ${(result.replay.durationMs / 1000).toFixed(1)}s`);
  } else if (result.replay?.skipped) {
    console.log('Reality check: skipped (--no-replay)');
  }
  if (result.stability && !result.stability.skipped) {
    const total = result.stability.passed + result.stability.flaked;
    const pct = (result.stability.flakeRate * 100).toFixed(1);
    console.log(`Stability:     ${result.stability.passed}/${total} stable across ${result.stability.iterations}× · flake_rate=${pct}% · ${(result.stability.durationMs / 1000).toFixed(1)}s`);
  } else if (result.stability?.skipped) {
    console.log('Stability:     skipped (--no-stability)');
  }
  console.log('\nRun: npx playwright test ' + path.relative(process.cwd(), primaryPath));
}

function isPaused(r: { paused?: boolean }): r is ReviewPaused {
  return r.paused === true;
}

function trimJson(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

main().catch((err) => {
  console.error('\n✗ Exploration failed:', err.message);
  process.exit(1);
});
