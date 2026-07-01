import fs from 'node:fs';
import path from 'node:path';
import type { CascadeLevel } from './selectors.js';

/**
 * Per-codebase memory.
 *
 * Two layers:
 *
 *  1. Site fingerprints — one JSON per origin (host) under .qa-core/sites/.
 *     Captures element conventions, common selectors, auth strategy hints.
 *     Read at the start of a run, refreshed at the end. Shared across runs.
 *
 *  2. Project memory — .qa-core/memory.json at the repo root.
 *     Captures recent runs (which URLs, which scenarios, which model), the
 *     prevailing cascade distribution (do we hit role most of the time? CSS?),
 *     and any explicit overrides the user has pinned.
 *
 * Memory is injected into the agent's system prompt as a cacheable block,
 * so prompt caching kicks in on repeat runs against the same host.
 */

export interface SiteFingerprint {
  host: string;
  /** Last URL we explored on this host. */
  lastUrl: string;
  /** Last time this fingerprint was updated, ISO 8601. */
  updatedAt: string;
  /** Counts of how often the cascade resolved at each level on this host. */
  cascadeStats: Record<CascadeLevel, number>;
  /** Common element intents we've already seen — gives the agent a head start. */
  knownIntents: KnownIntent[];
  /** Authentication hint, if observed. */
  authHint?: {
    /** URL where the login form lived. */
    loginUrl: string;
    /** Username / email field intent (e.g. "username input"). */
    userField: string;
    /** Password field intent. */
    passField: string;
    /** Submit button intent. */
    submitButton: string;
  };
  /** Past run summaries — capped to the last N for context size. */
  recentRuns: RecentRun[];
}

export interface KnownIntent {
  intent: string;
  /** Selector level that worked last time — agent will try that first. */
  bestLevel: CascadeLevel;
  /** Times we've successfully resolved this intent on this host. */
  hits: number;
}

export interface RecentRun {
  at: string;
  url: string;
  scenarios: number;
  cost: number;
  model: string;
  durationSec: number;
}

export interface ProjectMemory {
  updatedAt: string;
  /** Pinned overrides — set by the user, never auto-modified. */
  overrides?: {
    /** Force these selectors when the agent sees this intent on any host. */
    intentAliases?: Record<string, string>;
    /** Per-host notes the user wants the agent to see every run. */
    hostNotes?: Record<string, string>;
  };
  /** Aggregate cascade distribution across all runs. */
  cascadeStats: Record<CascadeLevel, number>;
}

const MEMORY_ROOT = '.qa-core';
const SITES_DIR = path.join(MEMORY_ROOT, 'sites');
const PROJECT_FILE = path.join(MEMORY_ROOT, 'memory.json');
const MAX_RUNS_KEPT = 5;
const MAX_INTENTS_KEPT = 24;

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

function siteFile(host: string): string {
  return path.join(SITES_DIR, `${host.replace(/[^a-z0-9.-]/gi, '_')}.json`);
}

/* ---------------- Read ---------------- */

export function loadSiteFingerprint(url: string): SiteFingerprint | null {
  const host = hostOf(url);
  const file = siteFile(host);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SiteFingerprint;
  } catch {
    return null;
  }
}

export function loadProjectMemory(): ProjectMemory {
  if (!fs.existsSync(PROJECT_FILE)) {
    return {
      updatedAt: new Date().toISOString(),
      cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    };
  }
  try {
    return JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf8')) as ProjectMemory;
  } catch {
    return {
      updatedAt: new Date().toISOString(),
      cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    };
  }
}

/* ---------------- Write ---------------- */

export interface RunSummary {
  url: string;
  scenarios: number;
  cost: number;
  model: string;
  durationSec: number;
  cascadeStats: Record<CascadeLevel, number>;
  /** Intents the agent successfully resolved during this run, with the winning level. */
  resolvedIntents: Array<{ intent: string; level: CascadeLevel }>;
  /** Optional auth hint to remember. */
  authHint?: SiteFingerprint['authHint'];
}

export function saveRun(summary: RunSummary): void {
  ensureDir(SITES_DIR);

  // 1. Update the per-host fingerprint.
  const host = hostOf(summary.url);
  const existing = loadSiteFingerprint(summary.url);
  const intents = mergeIntents(existing?.knownIntents ?? [], summary.resolvedIntents);
  const cascadeStats = mergeCascade(existing?.cascadeStats, summary.cascadeStats);
  const recentRuns = [
    {
      at: new Date().toISOString(),
      url: summary.url,
      scenarios: summary.scenarios,
      cost: summary.cost,
      model: summary.model,
      durationSec: summary.durationSec,
    },
    ...(existing?.recentRuns ?? []),
  ].slice(0, MAX_RUNS_KEPT);

  const fingerprint: SiteFingerprint = {
    host,
    lastUrl: summary.url,
    updatedAt: new Date().toISOString(),
    cascadeStats,
    knownIntents: intents.slice(0, MAX_INTENTS_KEPT),
    authHint: summary.authHint ?? existing?.authHint,
    recentRuns,
  };
  fs.writeFileSync(siteFile(host), JSON.stringify(fingerprint, null, 2));

  // 2. Update project memory aggregate.
  const project = loadProjectMemory();
  project.cascadeStats = mergeCascade(project.cascadeStats, summary.cascadeStats);
  project.updatedAt = new Date().toISOString();
  fs.writeFileSync(PROJECT_FILE, JSON.stringify(project, null, 2));
}

function mergeCascade(
  a: Record<CascadeLevel, number> | undefined,
  b: Record<CascadeLevel, number>,
): Record<CascadeLevel, number> {
  const base = a ?? { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 };
  return {
    role: (base.role ?? 0) + (b.role ?? 0),
    label: (base.label ?? 0) + (b.label ?? 0),
    placeholder: (base.placeholder ?? 0) + (b.placeholder ?? 0),
    text: (base.text ?? 0) + (b.text ?? 0),
    alt: (base.alt ?? 0) + (b.alt ?? 0),
    title: (base.title ?? 0) + (b.title ?? 0),
    testid: (base.testid ?? 0) + (b.testid ?? 0),
    css: (base.css ?? 0) + (b.css ?? 0),
    xpath: (base.xpath ?? 0) + (b.xpath ?? 0),
  };
}

function mergeIntents(
  existing: KnownIntent[],
  next: Array<{ intent: string; level: CascadeLevel }>,
): KnownIntent[] {
  const map = new Map<string, KnownIntent>();
  for (const e of existing) map.set(e.intent.toLowerCase(), { ...e });
  for (const n of next) {
    const key = n.intent.toLowerCase();
    const cur = map.get(key);
    if (cur) {
      cur.hits += 1;
      cur.bestLevel = n.level; // last-write wins — most recent successful resolution
    } else {
      map.set(key, { intent: n.intent, bestLevel: n.level, hits: 1 });
    }
  }
  // Most-hit first; ties broken by recency (which is implicit in order).
  return [...map.values()].sort((a, b) => b.hits - a.hits);
}

/* ---------------- Prompt block ---------------- */

/**
 * Build a compact, agent-readable memory block to prepend to the system prompt.
 * Returns null if there's nothing useful to inject (avoids burning cache budget
 * on a block that says "no memory").
 */
export function renderMemoryBlock(url: string): string | null {
  const project = loadProjectMemory();
  const site = loadSiteFingerprint(url);

  const parts: string[] = [];

  if (site && (site.knownIntents.length > 0 || site.recentRuns.length > 0)) {
    parts.push(`Site memory for ${site.host}:`);
    if (site.recentRuns.length > 0) {
      const last = site.recentRuns[0];
      if (last) {
        parts.push(`  Last run: ${last.scenarios} scenarios in ${last.durationSec}s ($${last.cost.toFixed(3)}, model ${last.model}).`);
      }
    }
    if (site.knownIntents.length > 0) {
      const top = site.knownIntents.slice(0, 10);
      parts.push(`  Intents this host resolves cleanly (try first):`);
      for (const k of top) {
        parts.push(`    - "${k.intent}" → ${k.bestLevel} (${k.hits}× successful)`);
      }
    }
    if (site.authHint) {
      parts.push(`  Auth hint: login at ${site.authHint.loginUrl}, fields "${site.authHint.userField}" / "${site.authHint.passField}", submit "${site.authHint.submitButton}".`);
    }
  }

  const note = project.overrides?.hostNotes?.[hostOf(url)];
  if (note) {
    parts.push('');
    parts.push(`Project note for this host: ${note}`);
  }

  if (project.overrides?.intentAliases && Object.keys(project.overrides.intentAliases).length > 0) {
    parts.push('');
    parts.push('Global intent aliases set by the team:');
    for (const [k, v] of Object.entries(project.overrides.intentAliases)) {
      parts.push(`  - "${k}" ⇒ "${v}"`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}
