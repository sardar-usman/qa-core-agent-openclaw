import 'dotenv/config';
import { execSync } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { explore } from '../agent/runtime.js';
import { generateFromStory } from '../agent/generate.js';
import { heal } from '../cli/heal.js';
import { transcribe } from '../agent/transcriber.js';
import { transcribePOM } from '../agent/pom.js';
import { scaffold, frameworkDirName, normalizeAndValidateUrl } from '../agent/scaffold.js';
import { stripNpmStyleLeadingDashes, detectPastedCliCommand } from '../agent/parse-hints.js';
import { zipFrameworkToBuffer } from '../agent/zip-framework.js';
import { parseFeatures } from '../agent/parse-features.js';
import { renderReconciliation } from '../agent/reconcile.js';

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
  verdicts: Array<{ verdict: string; scenario: string; reasons: string[]; required_fixes: string[] }> | null;
  /**
   * Unique feature tags across this run's scenarios, in first-encountered
   * order. The UI uses this to disambiguate multiple runs of the same site
   * in the recent-runs panel (e.g. "saucedemo · login, cart"). Empty or
   * absent when scenarios were not feature-tagged (legacy reports).
   */
  features: string[] | null;
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
    const review = (r.review ?? null) as { verdicts?: Array<{ verdict: string; scenario: string; reasons: string[]; required_fixes: string[] }>; summary?: string } | null;
    let host: string | null = null;
    try { host = url ? new URL(url).host : null; } catch { /* keep null */ }

    // Collect unique feature tags across scenarios in first-encountered order.
    // The UI uses these to disambiguate same-site runs in the recent-runs list.
    let features: string[] | null = null;
    if (Array.isArray(r.scenarios)) {
      const seen = new Set<string>();
      const ordered: string[] = [];
      for (const sc of r.scenarios as Array<Record<string, unknown>>) {
        const f = typeof sc?.feature === 'string' ? sc.feature.trim() : '';
        if (f && !seen.has(f)) { seen.add(f); ordered.push(f); }
      }
      features = ordered.length > 0 ? ordered : null;
    }

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
      features,
    };
  } catch {
    return null;
  }
}

/* ─────────────────── Dispatch ─────────────────── */

async function dispatch(content: string, msg: IncomingMessage, ws: WebSocket): Promise<void> {
  const lang = asLang(msg.lang);

  // Catch users who pasted `npm run <cmd> -- <args>` into the chat. This is
  // the #1 mistake we see: terminal syntax doesn't work in the chat, and the
  // generic "command not recognised" reply doesn't tell them WHY.
  const pasteHint = detectPastedCliCommand(content);
  if (pasteHint) {
    send(ws, {
      text:
        "Looks like you pasted a terminal command. In the dashboard, drop the " +
        "`npm run ... --` prefix and use the slash command directly:\n\n" +
        `  \`${pasteHint.suggestion}\``,
    });
    return;
  }

  if (content.startsWith('/explore ')) {
    const initialRest = content.slice('/explore '.length).trim();
    if (!initialRest) {
      send(ws, { text: 'Usage: `/explore <url> [--features login,cart] [--no-stabilize] [or natural-language hint after the URL]`' });
      return;
    }
    // Strip leading `--` if the user carried over npm-style syntax. We only
    // strip when what follows actually looks like a URL — otherwise let the
    // validator produce its normal "doesn't look like a URL" error so the
    // user knows the input was genuinely malformed.
    const dashFix = stripNpmStyleLeadingDashes(initialRest);
    if (dashFix.stripped) {
      send(ws, {
        text:
          "Note: I removed the leading `--` for you — that's only needed when " +
          "running the command through npm in your terminal.",
      });
    }
    let rest = dashFix.cleaned;

    // Parse --stabilize-attempts N from anywhere in the body, then strip
    // it so the rest of the parsing doesn't see it as part of the URL or
    // natural-language hint.
    let maxStabilizeAttempts: number | undefined;
    const attemptsMatch = rest.match(/(^|\s)--stabilize-attempts\s+(\d+)(?=\s|$)/);
    if (attemptsMatch) {
      const n = Number(attemptsMatch[2]);
      if (Number.isFinite(n) && n >= 1 && Number.isInteger(n)) {
        maxStabilizeAttempts = n;
      }
      rest = rest.replace(/(^|\s)--stabilize-attempts\s+\d+(?=\s|$)/g, '').trim();
    }
    // Accept three forms (per the v3 design):
    //   1. /explore https://shop.com                                  → no features, Planner infers
    //   2. /explore https://shop.com --features login,cart            → comma-flag
    //   3. /explore https://shop.com test login and cart              → natural language
    // Plus modifier flags that can appear anywhere after the URL:
    //   --no-stabilize    skip Stage 5b (no LLM flake recovery)
    // Strip modifier flags before URL/features parsing so they don't
    // contaminate the natural-language hint or get mistaken for the URL.
    const stabilize = !/(^|\s)--no-stabilize(\s|$)/.test(rest);
    const restWithoutModifiers = rest.replace(/(^|\s)--no-stabilize(?=\s|$)/g, '').trim();
    const featuresMatch = restWithoutModifiers.match(/--features\s+(\S+)/);
    let url: string;
    let flagInput: string | undefined;
    let naturalInput: string | undefined;
    if (featuresMatch) {
      flagInput = featuresMatch[1];
      const remainder = restWithoutModifiers.replace(/--features\s+\S+/, '').trim().split(/\s+/);
      url = remainder[0] ?? '';
    } else {
      const parts = restWithoutModifiers.split(/\s+/);
      url = parts[0] ?? '';
      if (parts.length > 1) naturalInput = parts.slice(1).join(' ');
    }
    if (!url) {
      send(ws, { text: 'Usage: `/explore <url> [--features login,cart] [--no-stabilize] [or natural-language hint after the URL]`' });
      return;
    }
    // Validate the URL BEFORE spinning up the agent. Without this, an invalid
    // URL ("--", "(ts)", "shop") would pass through to the Planner, the
    // Planner would fail to navigate, and the agent would still scaffold an
    // empty framework + charge the user. Fail fast instead.
    const urlCheck = normalizeAndValidateUrl(url);
    if (!urlCheck.ok) {
      send(ws, {
        text:
          `✗ Couldn't run /explore: ${urlCheck.reason}.\n\n` +
          'Try a full URL like:  `/explore https://www.saucedemo.com/`',
      });
      return;
    }
    if (urlCheck.normalized) {
      send(ws, { text: `Note: I added https:// for you — using \`${urlCheck.url}\`.` });
    }
    const validUrl = urlCheck.url;
    const parsed = await parseFeatures({ flagInput, naturalInput });
    if (!stabilize) {
      send(ws, { text: 'Note: Stabilizer (Stage 5b) is OFF — flaky scenarios will be dropped without an LLM recovery attempt.' });
    }
    if (maxStabilizeAttempts) {
      send(ws, { text: `Note: Stabilizer will try up to ${maxStabilizeAttempts} fix attempt${maxStabilizeAttempts === 1 ? '' : 's'} per flaky scenario.` });
    }
    await handleExplore({
      url: validUrl, lang, model: msg.model, features: parsed.features,
      stabilize, maxStabilizeAttempts, ws,
    });
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

interface HandleExploreOptions {
  url: string;
  lang: 'ts' | 'js';
  model: string | undefined;
  /** Empty array if user didn't specify features — Planner then infers from homepage. */
  features: string[];
  /** Run Stage 5b (Stabilizer). Defaults to true; false when user passes --no-stabilize. */
  stabilize?: boolean;
  /** Max Stabilizer attempts per flaky scenario. Defaults to 3 when undefined. */
  maxStabilizeAttempts?: number;
  ws: WebSocket;
}

async function handleExplore(opts: HandleExploreOptions): Promise<void> {
  const { url, lang, model, features, stabilize, maxStabilizeAttempts, ws } = opts;
  // New v3 output naming — site-named, no timestamp. Re-runs overwrite the
  // previous framework (chosen design option). Wipe first so stale files
  // (e.g. a page object from a previous run with different features) don't
  // linger.
  // v3.1 naming — "saucedemo-automation-framework" (brand slug, no www, no TLD).
  const frameworkSlug = frameworkDirName(url);
  const outDir = path.join(process.cwd(), 'output', frameworkSlug);
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  const featuresLine = features.length > 0
    ? `\n  features: ${features.join(', ')}`
    : '\n  features: (none specified — Planner will infer from homepage)';
  send(ws, { text: `▸ Exploring ${url} (${lang})${featuresLine}\n  output: ${path.relative(process.cwd(), outDir)}` });

  const result = await explore({
    url, language: lang, outDir, model,
    features,
    stabilize,
    maxStabilizeAttempts,
    onEvent: (e) => {
      switch (e.type) {
        case 'plan_started':
          send(ws, { text: '**[1/5] Planner**' });
          break;
        case 'plan_done': {
          const lines = e.scenarios.map((s) => `  • [${s.category}] ${s.name}`).join('\n');
          send(ws, { text: `${e.scenarios.length} scenarios planned · $${e.usd.toFixed(4)}\n${lines}\n\n**[2/5] Explorer**` });
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
          // Cap at 600 chars so a single noisy LLM message can't flood the
          // chat, but high enough to allow multi-attempt Stabilizer events
          // (e.g. "Stabilizer gave up ... tried: wait 4000ms → wait 12000ms
          // → wait 15000ms" is ~150 chars; with longer scenario names it
          // can push past the previous 240 cap and get silently dropped).
          if (e.text.trim().length > 0 && e.text.length < 600) send(ws, { text: e.text.trim() });
          break;
        case 'critic_started':
          send(ws, { text: '**[3/5] Critic**' });
          break;
        case 'critic_done': {
          const lines = e.verdicts.map((v) => {
            const mark = v.verdict === 'pass' ? '✓' : v.verdict === 'rework' ? '!' : '✗';
            return `  ${mark} ${v.scenario}: ${v.reasons.join('; ')}`;
          }).join('\n');
          send(ws, { text: `${e.verdicts.length} verdicts · $${e.usd.toFixed(4)}\n${lines}` });
          break;
        }
        case 'replay_started':
          send(ws, { text: `**[4/5] Reality check** — replaying ${e.total} scenario(s) headlessly` });
          break;
        case 'replay_scenario_passed':
          send(ws, { text: `  ✓ ${e.name} (${e.durationMs}ms)` });
          break;
        case 'replay_scenario_failed':
          send(ws, { text: `  ✗ ${e.name} — step ${e.failedStep + 1} (${e.stepKind}): ${e.error}` });
          break;
        case 'replay_done':
          send(ws, { text: `${e.passed} passed twice · ${e.failed} dropped · ${(e.durationMs / 1000).toFixed(1)}s` });
          break;
        case 'stability_started':
          send(ws, { text: `**[5/5] Stability** — running ${e.iterations}× re-runs on ${e.total} replay survivor(s)` });
          break;
        case 'stability_iteration_failed':
          // Iteration passes are noisy (3 per scenario); surface only the failures.
          send(ws, { text: `  ✗ ${e.name} (iter ${e.iteration}) — step ${e.failedStep + 1} (${e.stepKind}): ${e.error}` });
          break;
        case 'stability_done': {
          const pct = (e.flakeRate * 100).toFixed(1);
          send(ws, {
            text: `${e.stable} stable · ${e.flaked} flaked across ${e.iterations}× re-runs · flake_rate ${pct}% · ${(e.durationMs / 1000).toFixed(1)}s`,
          });
          break;
        }
        case 'gate_injection':
          send(ws, { text: `  [gate] timeout:15000ms injected on ${e.assertionType} in "${e.scenario}"` });
          break;
        case 'gate_broken':
          send(ws, { text: `  [gate] BROKEN "${e.scenario}" after ${e.attempts} attempt(s): ${e.reason}` });
          break;
        case 'heal':
          send(ws, { text: `  ↺ healed: ${e.from} re-resolved to ${e.to} (${e.intent})` });
          break;
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

  // Empty-framework guard. If the run produced zero scenarios — typically
  // because the Planner couldn't reach the page or the Explorer ran out of
  // useful actions — DO NOT scaffold a placeholder framework. That's how we
  // ended up writing "0 scenarios, 11 files" to disk and charging for an
  // empty zip on a bad URL. Surface a clear error to the user instead.
  if (!report.scenarios || report.scenarios.length === 0) {
    const totalUsd = report.cost.usd + (report.cost.plannerUsd ?? 0) + (report.cost.criticUsd ?? 0);
    try { if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* noop */ }
    const gateBroken = report.gate?.broken ?? [];
    let msg = `✗ Couldn't generate a framework — 0 scenarios came back from this run.\n\n`;
    if (gateBroken.length > 0) {
      msg += `Gate dropped ${gateBroken.length} scenario(s) before Reality-Check:\n`;
      for (const b of gateBroken) {
        msg += `  • "${b.scenario}" — ${b.reason} (after ${b.attempts} attempt(s))\n`;
      }
      msg += `\nFix the Explorer to avoid hard sleeps and fragile CSS selectors on animated elements.\n\n`;
    } else {
      msg += `Most common reason: the Planner couldn't reach \`${url}\` (page unreachable, ` +
        `wrong protocol, behind auth). Confirm the URL loads in your own browser, ` +
        `then try again.\n\n`;
    }
    msg += `Cost so far: $${totalUsd.toFixed(4)} (planner $${(report.cost.plannerUsd ?? 0).toFixed(4)}, ` +
      `explorer $${report.cost.usd.toFixed(4)}, critic $${(report.cost.criticUsd ?? 0).toFixed(4)})`;
    send(ws, { text: msg });
    return;
  }

  // v3: emit the full framework (not a single spec) + ship as a zip the UI
  // can download. scaffold() calls pom.ts internally for the pages/tests/a11y
  // tree and adds package.json, configs, README, .gitignore, fixtures, helpers.
  const scaffoldResult = scaffold({
    report,
    outDir,
    siteName: hostnameOf(url),
    features,
  });
  const scenarios = scaffoldResult.pomResult.scenarios;
  const totalUsd = report.cost.usd + (report.cost.plannerUsd ?? 0) + (report.cost.criticUsd ?? 0);

  // Summary message (unchanged shape — just refers to the framework dir now).
  let replayLine = '';
  if (report.replay && !report.replay.skipped) {
    const total = report.replay.passed + report.replay.failed;
    const pct = total > 0 ? Math.round((report.replay.passed / total) * 100) : 0;
    replayLine = `\nReality check: ${report.replay.passed}/${total} passed twice (${pct}%)`;
  }
  let stabilityLine = '';
  if (report.stability && !report.stability.skipped) {
    const flakePct = (report.stability.flakeRate * 100).toFixed(1);
    const recovered = report.reconciliation?.recovered ?? report.stability.recovered ?? 0;
    const recoveredChip = recovered > 0 ? ` · **${recovered} recovered by Stabilizer**` : '';
    const stabilizerCost = report.stability.stabilizerCostUsd ?? 0;
    const stabilizerCostChip = stabilizerCost > 0 ? ` · stabilizer $${stabilizerCost.toFixed(4)}` : '';
    // Strict stable (excludes recovered) when reconciliation is present.
    const strictStable = report.reconciliation ? report.reconciliation.stable : report.stability.passed;
    const flakyCount = report.reconciliation?.flaky ?? report.stability.flaky ?? 0;
    const brokenCount = report.reconciliation?.broken ?? report.stability.broken ?? 0;
    stabilityLine =
      `\nStability: ${strictStable} stable${recoveredChip} · ${flakyCount} flaky · ` +
      `${brokenCount} broken across ${report.stability.iterations}× re-runs · flake_rate ${flakePct}%` +
      stabilizerCostChip;
  }
  const reconciliationLine = report.reconciliation
    ? '\n\n' + renderReconciliation(report.reconciliation).join('\n')
    : '';
  send(ws, {
    text:
      `**Done.** Wrote framework to \`${path.relative(process.cwd(), outDir)}\` (${scenarios} scenarios, ${scaffoldResult.fileCount} files).\n` +
      `Cost: $${totalUsd.toFixed(4)} total ` +
      `(planner $${(report.cost.plannerUsd ?? 0).toFixed(4)}, explorer $${report.cost.usd.toFixed(4)}, critic $${(report.cost.criticUsd ?? 0).toFixed(4)})\n` +
      `Cascade: ${JSON.stringify(report.cascadeStats)}` +
      replayLine +
      stabilityLine +
      reconciliationLine +
      (report.review?.summary ? `\n\n**Critic summary:** ${report.review.summary}` : ''),
  });

  // Zip the framework dir and ship to the UI via a structured message.
  // The UI's handleAgentMessage dispatches on `type` and renders a download
  // button when it sees `framework_zip`. Base64 payload is fine for typical
  // framework sizes (~10-50 KB raw, ~14-67 KB after base64).
  //
  // After zipping succeeds, we slim the on-disk directory to JUST
  // run-report.json. The zip is the deliverable; the directory becomes a
  // tombstone so the dashboard's listRunsFromDisk scan still recognises
  // this run. The zip itself is written alongside (not the gateway's job
  // historically — but now we write it so the user has a portable copy on
  // disk too, matching the CLI behaviour).
  try {
    const zipBuf = zipFrameworkToBuffer(outDir);
    const filename = `${frameworkSlug}.zip`;
    const sidecarZipPath = path.join(path.dirname(outDir), filename);

    send(ws, {
      type: 'framework_zip',
      filename,
      base64: zipBuf.toString('base64'),
      sizeBytes: zipBuf.length,
      fileCount: scaffoldResult.fileCount,
      scenarios,
      runReportPath: path.relative(process.cwd(), path.join(outDir, 'run-report.json')),
    } as object);

    // Persist a sidecar copy of the zip so users who skip the UI download
    // (e.g., running headless or via API) still get a portable artifact.
    fs.writeFileSync(sidecarZipPath, zipBuf);

    // Slim the directory: keep only run-report.json on disk. Everything
    // else (pages/, tests/, package.json, etc.) only lives in the zip from
    // here on. Reduces disk footprint and avoids two-paths-of-truth confusion.
    slimFrameworkDir(outDir);
  } catch (err) {
    // Don't fail the whole run if zip failed — framework is still on disk.
    send(ws, { text: `Could not zip framework (\`${(err as Error).message}\`). The framework directory is still at \`${path.relative(process.cwd(), outDir)}\` — use it from there.` });
  }
}

/** Hostname of a URL, falling back to the raw URL if parsing fails. Used for siteName in scaffold. */
function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/**
 * After the zip is produced, replace the on-disk framework directory with a
 * stub that contains only `run-report.json`. The zip is the canonical
 * deliverable; the directory remains as a tombstone so the dashboard's
 * `listRunsFromDisk` walk continues to find this run and surface its metadata
 * (cost, scenarios, replay/stability stats). All bulky generated files
 * (`pages/`, `tests/`, `a11y/`, `node_modules/`, etc.) are removed.
 *
 * Safe-rewrite pattern: read the report contents, blow the directory away,
 * re-create the directory, write the report back. Idempotent and robust
 * to the report file being absent (rare — only if scaffold failed earlier).
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
    specPath,
    onEvent: (e) => {
      switch (e.type) {
        case 'scanned':
          send(ws, { text: `Scanned ${e.total} locator(s) across ${e.files} file(s)` });
          break;
        case 'opened_page':
          send(ws, { text: `Opened ${e.url}` });
          break;
        case 'healing':
          send(ws, { text: `→ broken \`${e.selector}\`` });
          break;
        case 'healed':
          send(ws, { text: `✓ healed → \`${e.new}\` (level=${e.level})` });
          break;
        case 'unhealed':
          send(ws, { text: `✗ unhealable \`${e.selector}\` — ${e.reason}` });
          break;
      }
    },
  });

  send(ws, {
    text: `**Done.** ${result.intact} intact · ${result.healed.length} healed · ${result.unhealable.length} unhealable (of ${result.scanned}).`,
  });
  if (result.healedPath) {
    send(ws, { text: fs.readFileSync(result.healedPath, 'utf8') });
  }
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
