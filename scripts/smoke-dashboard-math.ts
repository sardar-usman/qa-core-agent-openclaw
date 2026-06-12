/**
 * Reproduces the EXACT dashboard math (both old and new) against the actual
 * runs on disk. Confirms the fix produces sensible numbers.
 *
 * The UI's renderDashboard() reads runs from localStorage that the gateway
 * populates from disk via listRunsFromDisk(). This script mimics the same
 * flow without involving the browser.
 */
import fs from 'node:fs';
import path from 'node:path';

interface DiskRun {
  host: string | null;
  passRate: number | null;
  scenarios: number;
  timestamp: number;
  source: string;
}

function walk(dir: string, out: DiskRun[], depth = 0): void {
  if (depth > 3 || !fs.existsSync(dir)) return;
  const reportPath = path.join(dir, 'run-report.json');
  if (fs.existsSync(reportPath)) {
    try {
      const r = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
      const url = String(r.url ?? '');
      let host: string | null = null;
      try { host = url ? new URL(url).host : null; } catch { /* keep null */ }
      let passRate: number | null = null;
      const pwPath = path.join(dir, 'pw-results.json');
      if (fs.existsSync(pwPath)) {
        try {
          const pw = JSON.parse(fs.readFileSync(pwPath, 'utf8')) as Record<string, unknown>;
          const stats = (pw.stats ?? {}) as Record<string, number>;
          const expected = stats.expected ?? 0;
          const unexpected = stats.unexpected ?? 0;
          const flaky = stats.flaky ?? 0;
          const total = expected + unexpected + flaky;
          if (total > 0) passRate = Math.round((expected / total) * 100);
        } catch { /* ignore */ }
      }
      const scenarios = Array.isArray(r.scenarios) ? r.scenarios.length : 0;
      const startedAt = String(r.startedAt ?? '');
      const ts = startedAt ? Date.parse(startedAt) : Date.now();
      out.push({ host, passRate, scenarios, timestamp: ts, source: path.relative(process.cwd(), dir) });
    } catch { /* skip malformed */ }
    return;
  }
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    try {
      if (fs.statSync(full).isDirectory()) walk(full, out, depth + 1);
    } catch { /* skip */ }
  }
}

const runs: DiskRun[] = [];
walk(path.resolve(process.cwd(), 'output'), runs);
walk(path.resolve(process.cwd(), 'eval-results'), runs);
runs.sort((a, b) => b.timestamp - a.timestamp);

console.log(`Found ${runs.length} run-report.json files on disk.\n`);

// Per-site aggregation — exactly the same shape the UI computes.
const sitesMap = new Map<string, { host: string; runs: number; runsWithPass: number; passes: number; tests: number }>();
for (const r of runs) {
  if (!r.host) continue;
  const cur = sitesMap.get(r.host) || { host: r.host, runs: 0, runsWithPass: 0, passes: 0, tests: 0 };
  cur.runs++;
  cur.tests += r.scenarios;
  if (typeof r.passRate === 'number') { cur.passes += r.passRate; cur.runsWithPass++; }
  sitesMap.set(r.host, cur);
}

const sites = [...sitesMap.values()].sort((a, b) => b.runs - a.runs);

console.log('Per-site dashboard math — OLD (buggy) vs NEW (fixed):\n');
console.log(
  'Site'.padEnd(36) +
  'Runs'.padStart(6) +
  'WithPass'.padStart(10) +
  'OLD avg'.padStart(10) +
  'NEW avg'.padStart(10),
);
console.log('-'.repeat(72));
for (const s of sites) {
  const oldAvg = s.runs ? Math.round(s.passes / s.runs) : null;
  const newAvg = s.runsWithPass ? Math.round(s.passes / s.runsWithPass) : null;
  const oldStr = oldAvg == null ? '—' : oldAvg + '%';
  const newStr = newAvg == null ? 'no data' : newAvg + '%';
  console.log(
    s.host.padEnd(36) +
    String(s.runs).padStart(6) +
    String(s.runsWithPass).padStart(10) +
    oldStr.padStart(10) +
    newStr.padStart(10),
  );
}

// Overall stat used by the TOTAL panel — this math was already correct.
const withPass = runs.filter(r => typeof r.passRate === 'number');
const overallAvg = withPass.length ? Math.round(withPass.reduce((a, r) => a + (r.passRate ?? 0), 0) / withPass.length) : null;
console.log('\nOverall (TOTAL panel) avg pass-rate:', overallAvg == null ? 'no data' : overallAvg + '%');
console.log(`  (computed over ${withPass.length} runs that have a passRate, out of ${runs.length} total)`);
