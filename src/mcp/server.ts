#!/usr/bin/env node
/**
 * QA-Core MCP server.
 *
 * Exposes QA-Core's three workflows as MCP tools so any MCP-aware client —
 * Claude Desktop, Cursor, Cline, Continue, Zed — can invoke them directly
 * without our gateway or web UI:
 *
 *   qa_explore   — drive a real browser, transcribe a Playwright spec
 *   qa_generate  — single-shot user-story → spec
 *   qa_heal      — re-resolve broken selectors on a live page
 *
 * Plus resources for the per-host memory and recent runs.
 *
 * Important to know:
 *  - Communicates over stdio. The host (Claude Desktop / Cursor) launches
 *    this process, sends JSON-RPC over stdin, reads responses from stdout.
 *  - All log output goes to stderr — never stdout — or the protocol breaks.
 *  - Tool calls can take 30-120s. MCP clients tolerate this; we do not stream
 *    progress in v1 (could be added with notifications/progress later).
 *  - ANTHROPIC_API_KEY must be set in the host's MCP config (the env block).
 *    We fail clean inside the tool call instead of crashing on launch.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { explore } from '../agent/runtime.js';
import { generateFromStory } from '../agent/generate.js';
import { heal } from '../agent/heal.js';
import { transcribe } from '../agent/transcriber.js';

/**
 * Where output gets written. Hosts run the MCP server from arbitrary cwds, so
 * the user sets QA_CORE_PROJECT_ROOT in their MCP config to point at the
 * project dir they want runs to land in. Falls back to cwd which is fine for
 * `npx`-style invocations.
 */
const PROJECT_ROOT = process.env.QA_CORE_PROJECT_ROOT ?? process.cwd();

function log(...parts: unknown[]): void {
  // CRITICAL: stderr only. stdout is reserved for the MCP wire protocol.
  process.stderr.write('[qa-core/mcp] ' + parts.map(String).join(' ') + '\n');
}

function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set in the MCP server env. Add it to your client config (e.g. claude_desktop_config.json → mcpServers.qa-core.env.ANTHROPIC_API_KEY).',
    );
  }
  return key;
}

function runId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function slug(s: string, max = 40): string {
  return s.replace(/^https?:\/\//, '').replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max).toLowerCase() || 'run';
}

function projectFile(...segs: string[]): string {
  return path.join(PROJECT_ROOT, ...segs);
}

const server = new McpServer(
  { name: 'qa-core', version: '0.3.0' },
  {
    capabilities: { tools: {}, resources: {} },
    instructions: [
      'QA-Core is an autonomous QA agent that generates Playwright test suites.',
      '',
      'Use qa_explore when the user gives you a URL and wants a verified test suite — the agent will drive a real browser through the page and transcribe the session.',
      'Use qa_generate when the user gives you a user story or Jira ticket and wants a spec derived from acceptance criteria (faster, but unverified until you run it).',
      'Use qa_heal when the user has an existing spec that broke after a UI change — it re-resolves selectors against the live page.',
      '',
      'Tool calls take 30-120 seconds. Tell the user so they understand the wait.',
      'Output is written under <project>/output/<run-id>/. The tool result includes the spec content directly so you can show or analyze it.',
    ].join('\n'),
  },
);

/* ─────────────────────── qa_explore ─────────────────────── */

server.tool(
  'qa_explore',
  'Drive a real Chromium browser through a URL and generate a Playwright test suite. The agent runs a 3-stage pipeline (Planner → Explorer → Critic), records every action live, and transcribes the verified session into a spec. Takes 30-120s. Returns: the generated spec content, run report, and the file path.',
  {
    url: z.string().describe('The URL to explore (must start with http:// or https://)'),
    language: z.enum(['ts', 'js']).default('ts').describe('Output language for the generated spec'),
    skipPlan: z.boolean().default(false).describe('Skip the Planner pre-step (Explorer wanders without a plan)'),
    skipCritic: z.boolean().default(false).describe('Skip the Critic post-step (no scenario verdicts)'),
  },
  async ({ url, language, skipPlan, skipCritic }) => {
    requireApiKey();
    const outDir = projectFile('output', `${runId()}-${slug(url)}`);
    log('explore', url, '→', outDir);

    const result = await explore({
      url, language: language ?? 'ts', outDir,
      skipPlan: skipPlan ?? false,
      skipCritic: skipCritic ?? false,
    });

    if (result.paused) {
      // Should not happen — we never pass review:true here — but be defensive.
      return {
        content: [{ type: 'text', text: `Unexpected pause. Plan at ${result.planPath}.` }],
        isError: true,
      };
    }

    const transcribed = transcribe({ report: result, outDir, name: slug(url) });
    const specContent = fs.readFileSync(transcribed.specPath, 'utf8');
    const totalUsd = result.cost.usd + (result.cost.plannerUsd ?? 0) + (result.cost.criticUsd ?? 0);

    const summary = [
      `✓ Generated ${transcribed.scenarios} scenarios for ${url}`,
      `  Spec:    ${path.relative(PROJECT_ROOT, transcribed.specPath)}`,
      `  Cost:    $${totalUsd.toFixed(4)} (planner $${(result.cost.plannerUsd ?? 0).toFixed(4)}, explorer $${result.cost.usd.toFixed(4)}, critic $${(result.cost.criticUsd ?? 0).toFixed(4)})`,
      `  Cascade: ${JSON.stringify(result.cascadeStats)}`,
      result.review?.summary ? `\nCritic summary: ${result.review.summary}` : '',
      '',
      '--- Generated spec ---',
      specContent,
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text', text: summary }] };
  },
);

/* ─────────────────────── qa_generate ─────────────────────── */

server.tool(
  'qa_generate',
  'Convert a user story or acceptance criteria into a Playwright spec via a single LLM call. Faster than qa_explore (no browser), but the spec is marked UNVERIFIED — run it with `npx playwright test` before trusting it.',
  {
    story: z.string().min(10).describe('The user story or acceptance criteria. Vague stories produce vague tests — be specific.'),
    language: z.enum(['ts', 'js']).default('ts'),
    baseUrl: z.string().optional().describe('Optional base URL to bake into the generated spec'),
  },
  async ({ story, language, baseUrl }) => {
    requireApiKey();
    log('generate', story.slice(0, 40), '…');

    const result = await generateFromStory({ story, language: language ?? 'ts', baseUrl });
    const outDir = projectFile('output', `${runId()}-generate`);
    fs.mkdirSync(outDir, { recursive: true });
    const file = `${slug(result.feature)}.spec.${language ?? 'ts'}`;
    const specPath = path.join(outDir, file);
    const header = '// UNVERIFIED — generated from a user story without browser execution.\n// Run `npx playwright test` against it before trusting the output.\n\n';
    fs.writeFileSync(specPath, header + result.spec + (result.spec.endsWith('\n') ? '' : '\n'));

    const summary = [
      `✓ ${result.scenarios} scenarios for "${result.feature}"`,
      `  Spec: ${path.relative(PROJECT_ROOT, specPath)}`,
      '  ⚠ UNVERIFIED — run before trusting.',
      '',
      '--- Generated spec ---',
      fs.readFileSync(specPath, 'utf8'),
    ].join('\n');

    return { content: [{ type: 'text', text: summary }] };
  },
);

/* ─────────────────────── qa_heal ─────────────────────── */

server.tool(
  'qa_heal',
  'Re-resolve broken selectors in an existing Playwright spec. Runs the spec to find failures, opens the URL in a fresh browser, asks Claude for replacements, validates each (must resolve to exactly one element), then writes <spec>.healed.<ext> with the patched calls.',
  {
    specPath: z.string().describe('Path to the spec file (relative to project root or absolute)'),
  },
  async ({ specPath }) => {
    requireApiKey();
    const fullPath = path.isAbsolute(specPath) ? specPath : projectFile(specPath);
    if (!fs.existsSync(fullPath)) {
      return {
        content: [{ type: 'text', text: `✗ Spec not found: ${specPath}` }],
        isError: true,
      };
    }
    log('heal', fullPath);

    const result = await heal({ specPath: fullPath });

    if (!result.healedPath) {
      return {
        content: [{ type: 'text', text: `Nothing to heal — ${result.total} failure(s) detected, none repairable. Logic failures (wrong text, wrong URL) need a human.` }],
      };
    }

    const healedContent = fs.readFileSync(result.healedPath, 'utf8');
    const summary = [
      `✓ ${result.healed}/${result.total} selectors healed`,
      `  Patched spec: ${path.relative(PROJECT_ROOT, result.healedPath)}`,
      '',
      '--- Patched spec ---',
      healedContent,
    ].join('\n');
    return { content: [{ type: 'text', text: summary }] };
  },
);

/* ─────────────────────── Resources ─────────────────────── */

server.resource(
  'qa-core-runs',
  'qa-core://runs',
  { description: 'List of recent /explore and /generate runs under this project' },
  async () => {
    const outDir = projectFile('output');
    const runs = fs.existsSync(outDir)
      ? fs.readdirSync(outDir).filter((d) => fs.statSync(path.join(outDir, d)).isDirectory()).sort().reverse().slice(0, 20)
      : [];
    const body = runs.length === 0 ? 'No runs yet.' : runs.map((r) => `- ${r}`).join('\n');
    return {
      contents: [{
        uri: 'qa-core://runs',
        mimeType: 'text/plain',
        text: body,
      }],
    };
  },
);

server.resource(
  'qa-core-memory',
  'qa-core://memory',
  { description: 'Per-host memory cache (site fingerprints, observed intents, cascade stats)' },
  async () => {
    const memDir = projectFile('.qa-core', 'sites');
    if (!fs.existsSync(memDir)) {
      return {
        contents: [{ uri: 'qa-core://memory', mimeType: 'text/plain', text: 'No site memory yet — run /explore against a URL first.' }],
      };
    }
    const files = fs.readdirSync(memDir).filter((f) => f.endsWith('.json'));
    const parts = files.map((f) => {
      const data = fs.readFileSync(path.join(memDir, f), 'utf8');
      return `# ${f}\n${data}`;
    });
    return {
      contents: [{
        uri: 'qa-core://memory',
        mimeType: 'application/json',
        text: parts.join('\n\n---\n\n'),
      }],
    };
  },
);

/* ─────────────────────── Connect ─────────────────────── */

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`QA-Core MCP server v0.3.0 ready (project root: ${PROJECT_ROOT})`);
}

main().catch((err) => {
  log('Fatal:', (err as Error).message);
  process.exit(1);
});
