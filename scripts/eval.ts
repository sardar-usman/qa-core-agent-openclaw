import 'dotenv/config';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { explore } from '../src/agent/runtime.js';
import { transcribe } from '../src/agent/transcriber.js';

/**
 * QA-Core eval harness.
 *
 * Runs /explore against a fixed set of public test sites, executes the
 * generated specs with `npx playwright test`, and writes:
 *
 *   eval-results/<timestamp>/
 *     results.json    — per-site metrics + summary
 *     summary.md      — markdown table for the README
 *
 * Metrics tracked per site:
 *   - scenarios:    number of scenarios the agent recorded
 *   - tests:        number of tests in the generated spec
 *   - passed/failed/flaky on first execution
 *   - cost USD + total tokens
 *   - cascade levels (role / label / testid / css) — higher levels = better
 *   - duration seconds
 *
 * Failures DO NOT stop the harness — the goal is to measure, not to gate CI.
 */

const TARGETS = [
  { name: 'saucedemo',        url: 'https://www.saucedemo.com/' },
  { name: 'the-internet',     url: 'https://the-internet.herokuapp.com/' },
  { name: 'practice-todo',    url: 'https://demo.playwright.dev/todomvc/' },
];

interface SiteResult {
  name: string;
  url: string;
  ok: boolean;
  scenarios: number;
  tests: number;
  passed: number;
  failed: number;
  flaky: number;
  durationSec: number;
  cost: { usd: number; tokens: number };
  cascade: Record<string, number>;
  /** Reality-check replay: scenarios that passed twice / scenarios attempted. */
  replay?: { passed: number; failed: number; durationMs: number };
  /** Stability iteration verdict: counts + flake_rate. */
  stability?: {
    iterations: number;
    passed: number;
    flaked: number;
    flaky: number;
    broken: number;
    flakeRate: number;
    durationMs: number;
  };
  error?: string;
}

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const root = process.cwd();
  const runDir = path.join(root, 'eval-results', ts());
  fs.mkdirSync(runDir, { recursive: true });

  const results: SiteResult[] = [];
  for (const target of TARGETS) {
    console.log(`\n=== ${target.name} (${target.url}) ===`);
    const startedAt = Date.now();
    const outDir = path.join(runDir, target.name);
    try {
      const result = await explore({
        url: target.url, language: 'ts', outDir,
        onEvent: (e) => {
          if (e.type === 'tool_call') process.stdout.write('.');
          else if (e.type === 'tool_result' && !e.ok) process.stdout.write('x');
        },
      });
      process.stdout.write('\n');
      // The eval harness never sets review mode; this guard satisfies the type checker.
      if (result.paused) throw new Error('Unexpected review pause in eval harness');
      const report = result;

      const transcribed = transcribe({ report, outDir, name: target.name });
      const testRun = runPlaywright(transcribed.specPath, target.url);

      results.push({
        name: target.name,
        url: target.url,
        ok: true,
        scenarios: report.scenarios.length,
        tests: testRun.total,
        passed: testRun.passed,
        failed: testRun.failed,
        flaky: testRun.flaky,
        durationSec: Math.round((Date.now() - startedAt) / 1000),
        cost: { usd: report.cost.usd, tokens: report.cost.inputTokens + report.cost.outputTokens },
        cascade: report.cascadeStats,
        replay: report.replay && !report.replay.skipped
          ? { passed: report.replay.passed, failed: report.replay.failed, durationMs: report.replay.durationMs }
          : undefined,
        stability: report.stability && !report.stability.skipped
          ? {
              iterations: report.stability.iterations,
              passed: report.stability.passed,
              flaked: report.stability.flaked,
              flaky: report.stability.flaky ?? 0,
              broken: report.stability.broken ?? 0,
              flakeRate: report.stability.flakeRate,
              durationMs: report.stability.durationMs,
            }
          : undefined,
      });
      console.log(`  ${testRun.passed}/${testRun.total} passed · ${(report.cost.usd).toFixed(4)} USD · ${Math.round((Date.now() - startedAt) / 1000)}s`);
    } catch (err) {
      results.push({
        name: target.name, url: target.url, ok: false,
        scenarios: 0, tests: 0, passed: 0, failed: 0, flaky: 0,
        durationSec: Math.round((Date.now() - startedAt) / 1000),
        cost: { usd: 0, tokens: 0 },
        cascade: { role: 0, label: 0, testid: 0, css: 0 },
        error: (err as Error).message,
      });
      console.log(`  ✗ ${(err as Error).message}`);
    }
  }

  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(runDir, 'summary.md'), renderMarkdown(results));
  console.log(`\n✓ Eval complete. Results at: ${path.relative(root, runDir)}/summary.md`);
}

function runPlaywright(specPath: string, baseUrl: string): { total: number; passed: number; failed: number; flaky: number } {
  const out = path.dirname(specPath);
  const reportPath = path.join(out, 'pw-results.json');
  try {
    execSync(
      // Pin --project=chromium so the auth setup project does not also run.
      `npx playwright test "${specPath}" --reporter=json --project=chromium`,
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          QA_CORE_BASE_URL: baseUrl,
          // Tell the Playwright config to discover tests in the spec's own dir.
          PLAYWRIGHT_TEST_DIR: out,
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    // playwright exits non-zero when any test fails. That is expected; we read the report.
  }
  if (!fs.existsSync(reportPath)) return { total: 0, passed: 0, failed: 0, flaky: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    return {
      total: data.stats?.expected + data.stats?.unexpected + data.stats?.flaky || 0,
      passed: data.stats?.expected || 0,
      failed: data.stats?.unexpected || 0,
      flaky: data.stats?.flaky || 0,
    };
  } catch {
    return { total: 0, passed: 0, failed: 0, flaky: 0 };
  }
}

function renderMarkdown(results: SiteResult[]): string {
  const lines: string[] = [];
  lines.push(`# QA-Core eval results`);
  lines.push('');
  lines.push(`_Generated ${new Date().toISOString()}_`);
  lines.push('');
  lines.push(`| Site | Scenarios | Tests | Passed | Failed | Flaky | Pass-rate | Cost (USD) | Tokens | Time |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const r of results) {
    const rate = r.tests > 0 ? `${Math.round((r.passed / r.tests) * 100)}%` : '—';
    lines.push(`| ${r.name} | ${r.scenarios} | ${r.tests} | ${r.passed} | ${r.failed} | ${r.flaky} | ${rate} | ${r.cost.usd.toFixed(4)} | ${r.cost.tokens} | ${r.durationSec}s |`);
  }
  lines.push('');

  // v2 columns: reality-check replay + stability iteration.
  lines.push(`## Reality-check replay & stability iteration`);
  lines.push('');
  lines.push(`| Site | Replay pass | Replay fail | Stable | Flaky | Broken | flake_rate |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const r of results) {
    const rp = r.replay;
    const st = r.stability;
    const fr = st ? `${(st.flakeRate * 100).toFixed(1)}%` : '—';
    lines.push(`| ${r.name} | ${rp?.passed ?? '—'} | ${rp?.failed ?? '—'} | ${st?.passed ?? '—'} | ${st?.flaky ?? '—'} | ${st?.broken ?? '—'} | ${fr} |`);
  }
  lines.push('');
  const totalTests = results.reduce((s, r) => s + r.tests, 0);
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalCost = results.reduce((s, r) => s + r.cost.usd, 0);
  const aggRate = totalTests > 0 ? Math.round((totalPassed / totalTests) * 100) : 0;
  lines.push(`**Aggregate:** ${totalPassed}/${totalTests} tests passed (${aggRate}%) · $${totalCost.toFixed(4)} total cost across ${results.length} sites.`);
  lines.push('');
  lines.push(`## Selector cascade distribution`);
  lines.push('');
  lines.push(`| Site | role | label | testid | css |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  for (const r of results) {
    lines.push(`| ${r.name} | ${r.cascade.role ?? 0} | ${r.cascade.label ?? 0} | ${r.cascade.testid ?? 0} | ${r.cascade.css ?? 0} |`);
  }
  return lines.join('\n');
}

main().catch((err) => {
  console.error('\n✗ Eval failed:', err.message);
  process.exit(1);
});
