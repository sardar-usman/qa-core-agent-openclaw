import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { explore, type ReviewPaused } from '../agent/runtime.js';
import { transcribe } from '../agent/transcriber.js';
import { scaffold, frameworkDirName, normalizeAndValidateUrl } from '../agent/scaffold.js';
import { zipFrameworkToFile } from '../agent/zip-framework.js';
import { parseCommaSeparated } from '../agent/parse-features.js';
import { readCsv } from '../agent/csv.js';
import { renderReconciliation } from '../agent/reconcile.js';
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
  /**
   * Run Stage 5b — the Stabilizer LLM that proposes a wait or selector swap
   * when a scenario is flaky. Default: true. Set false to keep stability
   * fully deterministic + offline (no Sonnet call on flake).
   */
  stabilize: boolean;
  /**
   * Max Stabilizer fix attempts per flaky scenario. Default: 3. Higher values
   * give the LLM more tries to find a strategy that works (each attempt sees
   * the history of what didn't); cap is for cost containment.
   */
  stabilizeAttempts: number;
  /**
   * Feature names from --features X,Y,Z. Currently surfaced in the README
   * and the README's "Features covered" section. Planner steering by feature
   * is a separate piece of work (deferred).
   */
  features: string[];
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
    stabilize: true,
    stabilizeAttempts: 3,
    features: [],
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
    else if (a === '--no-stabilize') parsed.stabilize = false;
    else if (a === '--stabilize') parsed.stabilize = true;
    else if (a === '--stabilize-attempts') {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
        console.error(`✗ --stabilize-attempts expects a positive integer (got "${args[i]}")`);
        process.exit(1);
      }
      parsed.stabilizeAttempts = n;
    }
    else if (a === '--features') {
      const v = args[++i];
      if (!v) {
        console.error('✗ --features expects a comma-separated value (e.g. --features login,cart,checkout)');
        process.exit(1);
      }
      parsed.features = parseCommaSeparated(v);
    }
    else if (a && !parsed.url) parsed.url = a;
  }
  if (!parsed.url && !parsed.fromPlan) {
    console.error('Usage:');
    console.error('  npm run explore -- <url> [--lang ts|js] [--name foo] [--out dir] [--review]');
    console.error('                          [--features login,cart] [--no-pom] [--no-replay]');
    console.error('                          [--no-stability] [--stability N] [--no-stabilize]');
    console.error('                          [--stabilize-attempts N]');
    console.error('  npm run explore -- --from-plan <plan.csv> [--lang ts|js] [--name foo] [--no-pom]');
    console.error('                                            [--no-replay] [--no-stability] [--stability N]');
    console.error('                                            [--no-stabilize] [--stabilize-attempts N]');
    console.error('');
    console.error('  --no-stabilize          Skip Stage 5b. Flaky scenarios always drop.');
    console.error('  --stabilize-attempts N  Max Stabilizer fix attempts per flaky scenario (default 3).');
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
    // Validate the URL BEFORE doing anything else. Stops "--", "(ts)" and
    // similar garbage from reaching the Planner, where they'd produce an
    // empty framework + a real bill.
    const urlCheck = normalizeAndValidateUrl(args.url!);
    if (!urlCheck.ok) {
      console.error(`✗ Couldn't run /explore: ${urlCheck.reason}.`);
      console.error('  Try a full URL like: npm run explore -- https://www.saucedemo.com/');
      process.exit(1);
    }
    if (urlCheck.normalized) {
      console.log(`  Note: added https:// for you — using ${urlCheck.url}`);
    }
    url = urlCheck.url;
    const baseName = args.name ?? slug(url);
    // v3.1 naming for the scaffold path: <brand>-automation-framework/. Stable
    // across re-runs (overwrites previous). The --name flag (if provided) takes
    // precedence so power users can override. Inline mode (--no-pom) keeps the
    // old timestamped naming so power users don't accidentally lose history.
    const dirName = args.pom
      ? (args.name ? `${baseName}-automation-framework` : frameworkDirName(url))
      : `${runId()}-${baseName}`;
    outDir = path.join(base, dirName);
    // Wipe the framework dir before re-running so stale POM files (e.g. a
    // page object from a previous run with different features) don't linger.
    if (args.pom && fs.existsSync(outDir)) {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    console.log(`▸ Exploring ${url}`);
    if (args.features.length > 0) {
      console.log(`  features: ${args.features.join(', ')}`);
    } else {
      console.log(`  features: (none specified — Planner will infer from homepage)`);
    }
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
    stabilize: args.stabilize,
    maxStabilizeAttempts: args.stabilizeAttempts,
    features: args.features,
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
            const mark = v.verdict === 'pass' ? '✓' : v.verdict === 'rework' ? '!' : '✗';
            console.log(`        ${mark} ${v.scenario}: ${v.reasons.join('; ')}`);
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
        case 'stability_done': {
          const recovered = e.recovered ?? 0;
          const recoveredChip = recovered > 0 ? ` · ${recovered} recovered by Stabilizer` : '';
          const stabilizerCost = e.stabilizerCostUsd ?? 0;
          const stabilizerCostChip = stabilizerCost > 0 ? ` · stabilizer $${stabilizerCost.toFixed(4)}` : '';
          console.log(
            `      ${e.stable} stable${recoveredChip} · ${e.flaked} flaked · flake_rate=${(e.flakeRate * 100).toFixed(1)}% · ` +
            `${(e.durationMs / 1000).toFixed(1)}s${stabilizerCostChip}`,
          );
          break;
        }
        case 'gate_injection':
          console.log(`      [gate] ${e.detail} in "${e.scenario}"`); break;
        case 'gate_broken':
          console.log(`      [gate] BROKEN "${e.scenario}" after ${e.attempts} attempt(s): ${e.reason}`); break;
        case 'heal':
          console.log(`      ↺ healed: ${e.from} re-resolved to ${e.to} (${e.intent})`); break;
        case 'review_paused':
          console.log(`\n■ Paused for review.`); break;
        case 'done':
          // This is the Explorer's count. The final emitted (generated) count
          // and the planned = generated + dropped reconciliation print below.
          console.log(`\n✓ ${e.scenarios} scenario(s) explored`); break;
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

  // Empty-framework guard. If 0 scenarios came back (Planner couldn't reach
  // the page, Explorer ran out of useful actions, etc.), don't scaffold a
  // placeholder framework — that's how we ended up writing "0 scenarios, 11
  // files" to disk on a bad URL. Bail with a clear message.
  if (!result.scenarios || result.scenarios.length === 0) {
    const totalUsd = result.cost.usd + (result.cost.plannerUsd ?? 0) + (result.cost.criticUsd ?? 0);
    try { if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* noop */ }
    console.error('');
    console.error('✗ No framework was written — 0 scenarios produced.');
    const gateBroken = result.gate?.broken ?? [];
    if (gateBroken.length > 0) {
      console.error(`  Gate dropped ${gateBroken.length} scenario(s) before Reality-Check:`);
      for (const b of gateBroken) {
        console.error(`    • "${b.scenario}" — ${b.reason} (after ${b.attempts} attempt(s))`);
      }
      console.error('  Fix: avoid hard sleeps and fragile CSS selectors on animated elements.');
    } else {
      console.error(`  Most common cause: the Planner couldn't reach ${url} (page unreachable, wrong protocol, behind auth).`);
      console.error(`  Confirm the URL loads in your own browser, then try again.`);
    }
    console.error(`  Cost so far: $${totalUsd.toFixed(4)}`);
    process.exit(2);
  }

  let primaryPath: string;
  let scenarios: number;
  let frameworkZipPath: string | undefined;
  if (args.pom) {
    // v3: scaffold emits the full project (package.json, configs, README, etc.)
    // and calls pom.ts internally for pages/tests/a11y. Then we zip it.
    const scaffoldResult = scaffold({
      report: result,
      outDir,
      siteName: hostnameOf(url),
      features: args.features,
    });
    primaryPath = scaffoldResult.pomResult.specFile;
    scenarios = scaffoldResult.pomResult.scenarios;
    const features = scaffoldResult.pomResult.features;
    const specCount = scaffoldResult.pomResult.specFiles.length;
    console.log(`\nWrote complete framework to ${path.relative(process.cwd(), outDir)}/`);
    console.log(`  pages/        ${scaffoldResult.pomResult.pageFiles.length} page object class(es) (one per feature + BasePage)`);
    if (features.length > 0) {
      console.log(`  tests/        ${specCount} spec file(s) across feature folder(s): ${features.map((f) => `tests/${f}/`).join(', ')}`);
    } else {
      console.log(`  tests/        ${specCount} spec file(s)`);
    }
    console.log(`                ${scenarios} scenarios total`);
    console.log(`  tests/a11y/   ${path.basename(scaffoldResult.pomResult.a11yFile)}`);
    console.log(`  scaffold:     package.json, playwright.config.ts, tsconfig.json, README.md, .gitignore, .env.example`);
    console.log(`  fixtures:     credentials.ts`);
    console.log(`  helpers:      assertions.ts`);
    // Zip the framework alongside the directory for easy distribution.
    // After the zip is in place, slim the directory to just run-report.json
    // so the on-disk footprint is the zip (the deliverable) plus a tiny
    // tombstone that keeps the dashboard's run-history scan working.
    try {
      const zipPath = `${outDir}.zip`;
      const { sizeBytes } = zipFrameworkToFile(outDir, zipPath);
      frameworkZipPath = zipPath;
      console.log(`  zip:          ${path.relative(process.cwd(), zipPath)} (${(sizeBytes / 1024).toFixed(1)} KB)`);
      // Slim the dir — keep only run-report.json on disk.
      slimFrameworkDir(outDir);
      console.log(`  (framework files live in the zip; only run-report.json remains on disk)`);
    } catch (err) {
      console.log(`  zip:          skipped — ${(err as Error).message}`);
    }
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
    // Headline uses strict stable (excludes recovered) when reconciliation is
    // present, so a relaxed-rule survivor is never counted as a clean pass.
    const strictStable = result.reconciliation ? result.reconciliation.stable : result.stability.passed;
    const recovered = result.reconciliation?.recovered ?? result.stability.recovered ?? 0;
    const recoveredNote = recovered > 0 ? ` (+${recovered} recovered)` : '';
    console.log(`Stability:     ${strictStable}/${total} stable across ${result.stability.iterations}×${recoveredNote} · flake_rate=${pct}% · ${(result.stability.durationMs / 1000).toFixed(1)}s`);
  } else if (result.stability?.skipped) {
    console.log('Stability:     skipped (--no-stability)');
  }
  if (result.reconciliation) {
    console.log('');
    for (const line of renderReconciliation(result.reconciliation)) console.log(line);
  }
  // v3: the new framework workflow is "cd into it and use it as a project".
  // For backward compat with --no-pom, still show the single-file command.
  if (args.pom) {
    console.log('\nRun the framework:');
    console.log('  cd ' + path.relative(process.cwd(), outDir));
    console.log('  npm install');
    console.log('  npx playwright test');
    if (frameworkZipPath) {
      console.log(`\nOr share the zip: ${path.relative(process.cwd(), frameworkZipPath)}`);
    }
  } else {
    console.log('\nRun: npx playwright test ' + path.relative(process.cwd(), primaryPath));
  }
}

/** Hostname of a URL, falling back to the raw URL if parsing fails. */
function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/**
 * After the zip is written, replace the on-disk framework directory with a
 * stub that contains only `run-report.json`. The zip is the deliverable;
 * the dir stays as a tombstone so the dashboard's run-history scan still
 * recognises this run.
 */
function slimFrameworkDir(dir: string): void {
  const reportPath = path.join(dir, 'run-report.json');
  let reportContent: string | null = null;
  if (fs.existsSync(reportPath)) {
    try { reportContent = fs.readFileSync(reportPath, 'utf8'); } catch { /* leave null */ }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (reportContent !== null) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(reportPath, reportContent);
  }
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
