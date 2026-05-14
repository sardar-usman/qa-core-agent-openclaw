import 'dotenv/config';
import { execSync } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { explore } from '../agent/runtime.js';
import { generateFromStory } from '../agent/generate.js';
import { heal } from '../agent/heal.js';
import { transcribe } from '../agent/transcriber.js';
import { transcribePOM } from '../agent/pom.js';

/**
 * QA-Core gateway.
 *
 * A thin WebSocket server that speaks the protocol [qa-core-ui.html] already
 * sends: `{type: "message", content, model, lang}`. The gateway parses the
 * slash command out of `content`, invokes the appropriate runtime function,
 * and streams progress + the final spec back to the UI as JSON messages of
 * the form `{text: "..."}`.
 *
 * This is the OpenClaw skill-bridge layer: OpenClaw routes a slash command
 * to this process, the process does the actual work via Claude, and the
 * results flow back through the same WebSocket the UI is already connected to.
 *
 * Run:  npm run gateway
 * Env:  QA_CORE_GATEWAY_PORT   (default 18789 — matches the UI's default)
 *       QA_CORE_GATEWAY_TOKEN  (optional; clients pass `?token=` query)
 */

const PORT = Number(process.env.QA_CORE_GATEWAY_PORT ?? 18789);
const HOST = process.env.QA_CORE_GATEWAY_HOST ?? '127.0.0.1';
const TOKEN = process.env.QA_CORE_GATEWAY_TOKEN ?? '';

interface IncomingMessage {
  /** 'message' for slash commands, 'list_runs' to request a sync of on-disk runs. */
  type?: string;
  content?: string;
  agent?: string;
  model?: string;
  lang?: 'ts' | 'js';
}

/** Compact record of a finished run, suitable for the UI's run-history list. */
interface DiskRun {
  id: string;
  timestamp: number;
  type: 'explore' | 'generate' | 'heal';
  target: string | null;
  host: string | null;
  scenarios: number;
  passRate: number | null;
  costUsd: number;
  spec: string;
  summary: string | null;
  verdicts: Array<{ verdict: string; scenario: string; reason: string }> | null;
}

function send(ws: WebSocket, payload: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function asLang(v: unknown): 'ts' | 'js' {
  return v === 'js' ? 'js' : 'ts';
}

function runId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function slugify(s: string, max = 40): string {
  return s.replace(/^https?:\/\//, '').replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max).toLowerCase() || 'run';
}

/**
 * Per-connection state. Each client gets its own busy flag so a single user
 * can't fire two long-running commands at the same time over the same socket.
 */
interface ConnectionState {
  busy: boolean;
}

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`✗ Port ${PORT} is already in use.`);
    console.error(`  Another gateway may already be running, or set QA_CORE_GATEWAY_PORT to a different port.`);
    process.exit(1);
  }
  console.error('Gateway error:', err);
  process.exit(1);
});

wss.on('connection', (ws, req) => {
  // Optional token gate. Token comes from the `#token=` URL fragment in the UI
  // → the UI passes it as a query string when constructing the WebSocket URL.
  if (TOKEN) {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (url.searchParams.get('token') !== TOKEN) {
      ws.close(1008, 'invalid token');
      return;
    }
  }

  const state: ConnectionState = { busy: false };
  send(ws, { text: 'Connected to QA-Core gateway. Try `/explore <url>`, `/generate "<story>"`, or `/heal <spec-path>`.' });

  ws.on('message', async (raw) => {
    let msg: IncomingMessage;
    try { msg = JSON.parse(raw.toString()) as IncomingMessage; } catch { return; }

    // Control messages (no content body). Used by the UI to sync state.
    if (msg.type === 'list_runs') {
      try {
        const runs = listRunsFromDisk();
        send(ws, { type: 'runs', runs } as object);
      } catch (err) {
        send(ws, { text: `✗ Could not read runs from disk: ${(err as Error).message}` });
      }
      return;
    }

    const content = (msg.content ?? '').trim();
    if (!content) return;

    if (state.busy) {
      send(ws, { text: '⏳ Already running a command on this connection. Wait for it to finish.' });
      return;
    }

    state.busy = true;
    try {
      await dispatch(content, msg, ws);
      // After any successful command, push fresh runs so the UI does not need to refresh manually.
      try {
        const runs = listRunsFromDisk();
        send(ws, { type: 'runs', runs } as object);
      } catch { /* best-effort */ }
    } catch (err) {
      send(ws, { text: `✗ ${(err as Error).message}` });
    } finally {
      state.busy = false;
    }
  });
});

console.log(`QA-Core gateway listening on ws://${HOST}:${PORT}`);
console.log(TOKEN ? '  (token required via ?token=…)' : '  (no token — local use only)');
console.log('');
console.log('Open qa-core-ui.html in your browser, click Connect.');

/* ─────────────────── Disk scan (UI sync) ─────────────────── */

/**
 * Walk output/ and eval-results/ for run-report.json files and return compact
 * run records ready for the UI's run-history list.
 *
 * Newest first. Capped at 50 to keep the payload small.
 */
function listRunsFromDisk(): DiskRun[] {
  const found: DiskRun[] = [];
  const roots = [
    path.join(process.cwd(), 'output'),
    path.join(process.cwd(), 'eval-results'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    walk(root, found, /* depth */ 0);
  }
  // Newest first
  found.sort((a, b) => b.timestamp - a.timestamp);
  return found.slice(0, 50);
}

function walk(dir: string, out: DiskRun[], depth: number): void {
  if (depth > 3) return;
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return; }

  // If this directory contains a run-report.json, parse it.
  const reportPath = path.join(dir, 'run-report.json');
  if (fs.existsSync(reportPath)) {
    const run = parseRunReport(dir, reportPath);
    if (run) out.push(run);
    return; // do not recurse further once we found a report
  }

  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      if (fs.statSync(full).isDirectory()) walk(full, out, depth + 1);
    } catch { /* skip unreadable */ }
  }
}

function parseRunReport(dir: string, reportPath: string): DiskRun | null {
  try {
    const r = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    const cost = (r.cost ?? {}) as Record<string, number>;
    const usd = (cost.usd ?? 0) + (cost.plannerUsd ?? 0) + (cost.criticUsd ?? 0);
    const url = String(r.url ?? '');
    const startedAt = String(r.startedAt ?? '');
    const ts = startedAt ? Date.parse(startedAt) : Date.now();
    // Look for the generated spec alongside the report.
    let spec = '';
    let lang = String(r.language ?? 'ts');
    try {
      const dirEntries = fs.readdirSync(dir);
      const specName = dirEntries.find((f) => f.endsWith('.spec.ts') || f.endsWith('.spec.js')) ?? '';
      if (specName) {
        spec = fs.readFileSync(path.join(dir, specName), 'utf8');
        lang = specName.endsWith('.js') ? 'js' : 'ts';
      }
    } catch { /* spec is best-effort */ }
    // Try to pair with a Playwright JSON report if present (eval harness produces this).
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
    const review = (r.review ?? null) as { verdicts?: Array<{ verdict: string; scenario: string; reason: string }>; summary?: string } | null;
    let host: string | null = null;
    try { host = url ? new URL(url).host : null; } catch { /* keep null */ }

    return {
      id: 'disk_' + path.basename(dir),
      timestamp: ts,
      type: 'explore',
      target: url ? `/explore ${url}` : null,
      host,
      scenarios: Array.isArray(r.scenarios) ? r.scenarios.length : 0,
      passRate,
      costUsd: usd,
      spec,
      summary: review?.summary ?? null,
      verdicts: review?.verdicts ?? null,
    };
  } catch {
    return null;
  }
}

/* ─────────────────── Dispatch ─────────────────── */

async function dispatch(content: string, msg: IncomingMessage, ws: WebSocket): Promise<void> {
  const lang = asLang(msg.lang);

  if (content.startsWith('/explore ')) {
    const url = content.slice('/explore '.length).trim();
    if (!url) {
      send(ws, { text: 'Usage: `/explore <url>`' });
      return;
    }
    await handleExplore(url, lang, msg.model, ws);
    return;
  }

  if (content.startsWith('/generate ')) {
    const story = content.slice('/generate '.length).trim();
    if (!story) {
      send(ws, { text: 'Usage: `/generate <user story>`' });
      return;
    }
    await handleGenerate(story, lang, msg.model, ws);
    return;
  }

  if (content.startsWith('/heal ')) {
    const spec = content.slice('/heal '.length).trim();
    if (!spec) {
      send(ws, { text: 'Usage: `/heal <spec-path>`' });
      return;
    }
    await handleHeal(spec, msg.model, ws);
    return;
  }

  if (content === '/eval' || content.startsWith('/eval ')) {
    const rest = content.slice('/eval'.length).trim();
    const usePom = !/(^|\s)--no-pom(\s|$)/.test(rest);
    await handleEval(ws, usePom);
    return;
  }

  send(ws, {
    text:
      "I didn't recognise that command. I respond to:\n" +
      "  • `/explore <url>` to drive the browser and transcribe a spec\n" +
      "  • `/generate <story>` to turn a user story into a spec\n" +
      "  • `/heal <spec-path>` to re-resolve broken selectors\n" +
      "  • `/eval` to run the benchmark against 3 public sites",
  });
}

/* ─────────────────── /explore ─────────────────── */

async function handleExplore(url: string, lang: 'ts' | 'js', model: string | undefined, ws: WebSocket): Promise<void> {
  const outDir = path.join(process.cwd(), 'output', `${runId()}-${slugify(url)}`);
  send(ws, { text: `▸ Exploring ${url} (${lang})\n  output: ${path.relative(process.cwd(), outDir)}` });

  const result = await explore({
    url, language: lang, outDir, model,
    onEvent: (e) => {
      switch (e.type) {
        case 'plan_started':
          send(ws, { text: '**[1/3] Planner**' });
          break;
        case 'plan_done': {
          const lines = e.scenarios.map((s) => `  • [${s.category}] ${s.name}`).join('\n');
          send(ws, { text: `${e.scenarios.length} scenarios planned · $${e.usd.toFixed(4)}\n${lines}\n\n**[2/3] Explorer**` });
          break;
        }
        case 'tool_call':
          // keep noise low — only surface high-signal calls
          if (e.name === 'begin_scenario' || e.name === 'navigate' || e.name === 'finish') {
            send(ws, { text: `→ ${e.name}(${trimJson(e.input)})` });
          }
          break;
        case 'tool_result':
          if (!e.ok) send(ws, { text: `  ✗ ${e.error}` });
          break;
        case 'message':
          if (e.text.trim().length > 0 && e.text.length < 240) send(ws, { text: e.text.trim() });
          break;
        case 'critic_started':
          send(ws, { text: '**[3/3] Critic**' });
          break;
        case 'critic_done': {
          const lines = e.verdicts.map((v) => {
            const mark = v.verdict === 'ship' ? '✓' : v.verdict === 'weak' ? '!' : '✗';
            return `  ${mark} ${v.scenario} — ${v.reason}`;
          }).join('\n');
          send(ws, { text: `${e.verdicts.length} verdicts · $${e.usd.toFixed(4)}\n${lines}` });
          break;
        }
      }
    },
  });

  // The WS gateway never runs in review mode (no human at the terminal to edit
  // the CSV), so this branch is defensive — if review somehow gets enabled
  // we send the plan path and stop instead of crashing.
  if (result.paused) {
    send(ws, { text: `Plan written to \`${path.relative(process.cwd(), result.planPath)}\`. Resume via CLI: \`npm run explore -- --from-plan ${path.relative(process.cwd(), result.planPath)}\`` });
    return;
  }
  const report = result;

  const specName = slugify(url);
  const { specPath, scenarios } = transcribe({ report, outDir, name: specName });
  const totalUsd = report.cost.usd + (report.cost.plannerUsd ?? 0) + (report.cost.criticUsd ?? 0);

  // Summary message.
  send(ws, {
    text:
      `**Done.** Wrote \`${path.relative(process.cwd(), specPath)}\` (${scenarios} scenarios).\n` +
      `Cost: $${totalUsd.toFixed(4)} total ` +
      `(planner $${(report.cost.plannerUsd ?? 0).toFixed(4)}, explorer $${report.cost.usd.toFixed(4)}, critic $${(report.cost.criticUsd ?? 0).toFixed(4)})\n` +
      `Cascade: ${JSON.stringify(report.cascadeStats)}` +
      (report.review?.summary ? `\n\n**Critic summary:** ${report.review.summary}` : ''),
  });

  // The UI auto-detects test code patterns and renders the message as a copy/save-able block.
  // Send the spec content as its own message so it lands in the right shape.
  send(ws, { text: fs.readFileSync(specPath, 'utf8') });
}

/* ─────────────────── /generate ─────────────────── */

async function handleGenerate(story: string, lang: 'ts' | 'js', model: string | undefined, ws: WebSocket): Promise<void> {
  send(ws, { text: `▸ Generating spec from story (${lang})` });

  const result = await generateFromStory({ story, language: lang, model });
  const outDir = path.join(process.cwd(), 'output', `${runId()}-generate`);
  fs.mkdirSync(outDir, { recursive: true });
  const file = `${slugify(result.feature)}.spec.${lang}`;
  const specPath = path.join(outDir, file);
  const header = '// UNVERIFIED — generated from a user story without browser execution.\n// Run `npx playwright test` against it before trusting the output.\n\n';
  fs.writeFileSync(specPath, header + result.spec + (result.spec.endsWith('\n') ? '' : '\n'));

  send(ws, {
    text: `**Done.** ${result.scenarios} scenarios · wrote \`${path.relative(process.cwd(), specPath)}\`.\nThis spec is **UNVERIFIED** — run it before trusting it.`,
  });
  send(ws, { text: fs.readFileSync(specPath, 'utf8') });
}

/* ─────────────────── /heal ─────────────────── */

async function handleHeal(specArg: string, model: string | undefined, ws: WebSocket): Promise<void> {
  const specPath = path.resolve(process.cwd(), specArg);
  if (!fs.existsSync(specPath)) {
    send(ws, { text: `✗ Spec not found: ${specArg}` });
    return;
  }
  send(ws, { text: `▸ Healing ${path.relative(process.cwd(), specPath)}` });

  const result = await heal({
    specPath, model,
    onEvent: (e) => {
      switch (e.type) {
        case 'running_spec':
          send(ws, { text: 'Running spec to find failures…' });
          break;
        case 'failures_found':
          send(ws, { text: `${e.count} selector-style failure(s) detected` });
          break;
        case 'healing':
          send(ws, { text: `→ healing \`${e.selector}\`` });
          break;
        case 'healed':
          send(ws, { text: `✓ \`${e.old}\`\n    → \`${e.new}\` (level=${e.level}, confidence=${e.confidence.toFixed(2)})` });
          break;
        case 'unhealed':
          send(ws, { text: `✗ \`${e.selector}\` — ${e.reason}` });
          break;
      }
    },
  });

  if (!result.healedPath) {
    send(ws, { text: '**Done.** Nothing to heal.' });
    return;
  }
  send(ws, { text: `**Done.** ${result.healed}/${result.total} healed → \`${path.relative(process.cwd(), result.healedPath)}\`` });
  send(ws, { text: fs.readFileSync(result.healedPath, 'utf8') });
}

/* ─────────────────── /eval ─────────────────── */

interface EvalRow {
  site: string;
  url: string;
  scenarios: number;
  tests: number;
  passed: number;
  failed: number;
  flaky: number;
  passRate: number | null;
  costUsd: number;
  durationSec: number;
  ok: boolean;
  error?: string;
}

const EVAL_TARGETS: Array<{ name: string; url: string }> = [
  { name: 'saucedemo',     url: 'https://www.saucedemo.com/' },
  { name: 'the-internet',  url: 'https://the-internet.herokuapp.com/' },
  { name: 'practice-todo', url: 'https://demo.playwright.dev/todomvc/' },
];

async function handleEval(ws: WebSocket, usePom: boolean): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(process.cwd(), 'eval-results', ts);
  fs.mkdirSync(runDir, { recursive: true });

  send(ws, {
    text:
      `Starting eval against ${EVAL_TARGETS.length} public sites. ` +
      `Mode: ${usePom ? 'POM (default)' : 'inline (legacy)'}. ` +
      `Estimated cost: ~$0.75. Estimated duration: 5 to 7 minutes.`,
  });

  const results: EvalRow[] = [];

  for (let i = 0; i < EVAL_TARGETS.length; i++) {
    const target = EVAL_TARGETS[i]!;
    const startedAt = Date.now();
    const siteOutDir = path.join(runDir, target.name);

    send(ws, { text: `**[${i + 1}/${EVAL_TARGETS.length}] ${target.name}**\nExploring \`${target.url}\`...` });

    try {
      const result = await explore({
        url: target.url,
        language: 'ts',
        outDir: siteOutDir,
        onEvent: (e) => {
          if (e.type === 'plan_done') {
            send(ws, { text: `  ${e.scenarios.length} scenarios planned · $${e.usd.toFixed(4)}` });
          } else if (e.type === 'critic_done') {
            send(ws, { text: `  ${e.verdicts.length} verdicts · $${e.usd.toFixed(4)}` });
          }
        },
      });

      if (result.paused) {
        results.push(emptyRow(target, 0, 'Run unexpectedly paused.'));
        continue;
      }

      let specPath: string;
      if (usePom) {
        const t = transcribePOM({ report: result, outDir: siteOutDir, name: target.name });
        specPath = t.specFile;
      } else {
        const t = transcribe({ report: result, outDir: siteOutDir, name: target.name });
        specPath = t.specPath;
      }

      const pw = runPlaywrightInline(specPath, target.url);
      const totalCost = result.cost.usd + (result.cost.plannerUsd ?? 0) + (result.cost.criticUsd ?? 0);
      const durationSec = Math.round((Date.now() - startedAt) / 1000);
      const passRate = pw.total > 0 ? Math.round((pw.passed / pw.total) * 100) : null;

      const row: EvalRow = {
        site: target.name, url: target.url,
        scenarios: result.scenarios.length,
        tests: pw.total, passed: pw.passed, failed: pw.failed, flaky: pw.flaky,
        passRate, costUsd: totalCost, durationSec, ok: true,
      };
      results.push(row);

      send(ws, {
        text:
          `  ${pw.passed}/${pw.total} passed (${passRate ?? 0}%) · ` +
          `$${totalCost.toFixed(4)} · ${durationSec}s`,
      });
    } catch (err) {
      const msg = (err as Error).message;
      results.push(emptyRow(target, Math.round((Date.now() - startedAt) / 1000), msg));
      send(ws, { text: `  ✗ ${msg}` });
    }
  }

  // Aggregate + write outputs.
  const totalTests  = results.reduce((s, r) => s + r.tests, 0);
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalCost   = results.reduce((s, r) => s + r.costUsd, 0);
  const aggregate   = totalTests > 0 ? Math.round((totalPassed / totalTests) * 100) : 0;

  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));
  const summaryMd = buildEvalSummary(results, totalTests, totalPassed, aggregate, totalCost, usePom);
  fs.writeFileSync(path.join(runDir, 'summary.md'), summaryMd);

  // Final report to chat.
  send(ws, {
    text:
      `**Aggregate.** ${totalPassed}/${totalTests} tests passed (${aggregate}%) at $${totalCost.toFixed(4)} total cost.\n\n` +
      buildEvalTable(results) +
      `\n\nWritten to \`${path.relative(process.cwd(), path.join(runDir, 'summary.md'))}\`.`,
  });

  // Push fresh runs so the dashboard reflects the new eval immediately.
  try {
    const runs = listRunsFromDisk();
    send(ws, { type: 'runs', runs } as object);
  } catch { /* best-effort */ }
}

function emptyRow(target: { name: string; url: string }, durationSec: number, error?: string): EvalRow {
  return {
    site: target.name, url: target.url, scenarios: 0, tests: 0,
    passed: 0, failed: 0, flaky: 0, passRate: null,
    costUsd: 0, durationSec, ok: false, error,
  };
}

function buildEvalTable(rows: EvalRow[]): string {
  const lines = [
    '| Site | Scenarios | Tests | Passed | Failed | Pass-rate | Cost (USD) | Time |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const r of rows) {
    const rate = r.passRate == null ? 'no data' : r.passRate + '%';
    lines.push(`| ${r.site} | ${r.scenarios} | ${r.tests} | ${r.passed} | ${r.failed} | ${rate} | ${r.costUsd.toFixed(4)} | ${r.durationSec}s |`);
  }
  return lines.join('\n');
}

function buildEvalSummary(
  rows: EvalRow[],
  totalTests: number,
  totalPassed: number,
  aggregate: number,
  totalCost: number,
  usePom: boolean,
): string {
  return [
    '# QA-Core eval results',
    '',
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    `Mode: **${usePom ? 'POM (default)' : 'inline (legacy)'}**`,
    '',
    'First-run, unfiltered. The agent generated each spec from scratch (Planner + Explorer + Critic), then Playwright executed it.',
    '',
    buildEvalTable(rows),
    '',
    `**Aggregate.** ${totalPassed}/${totalTests} tests passed (${aggregate}%) at $${totalCost.toFixed(4)} total cost.`,
    '',
  ].join('\n');
}

function runPlaywrightInline(specPath: string, baseUrl: string): { total: number; passed: number; failed: number; flaky: number } {
  const out = path.dirname(specPath);
  const reportPath = path.join(out, 'pw-results.json');
  try {
    execSync(
      `npx playwright test "${specPath}" --reporter=json --project=chromium`,
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          QA_CORE_BASE_URL: baseUrl,
          PLAYWRIGHT_TEST_DIR: out,
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    // Playwright exits non-zero on test failures. Expected; we read the report.
  }
  if (!fs.existsSync(reportPath)) return { total: 0, passed: 0, failed: 0, flaky: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { stats?: Record<string, number> };
    const stats = data.stats ?? {};
    const expected = stats.expected ?? 0;
    const unexpected = stats.unexpected ?? 0;
    const flaky = stats.flaky ?? 0;
    return {
      total: expected + unexpected + flaky,
      passed: expected,
      failed: unexpected,
      flaky,
    };
  } catch {
    return { total: 0, passed: 0, failed: 0, flaky: 0 };
  }
}

/* ─────────────────── helpers ─────────────────── */

function trimJson(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 100 ? s.slice(0, 97) + '…' : s;
}

function shutdown(): void {
  console.log('\nShutting down…');
  for (const client of wss.clients) client.close(1001, 'gateway shutting down');
  wss.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
