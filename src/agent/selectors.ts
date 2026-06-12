import type { Locator, Page } from '@playwright/test';

/**
 * Selector cascade: role → label → testid → CSS.
 *
 * The agent describes targets in terms of *intent* ("the email field",
 * "the submit button"). This module resolves that intent to a Locator
 * by trying levels in order of robustness.
 *
 * Hardening over the v1 cascade:
 *   - Each level is tried with exact-name match first, then fuzzy.
 *   - A level only "wins" if it resolves to exactly one element.
 *   - When every level is ambiguous (count > 1), we return the best
 *     candidate marked `ambiguous: true` so the transcriber can emit
 *     `.first()` consciously instead of silently swallowing strict-mode
 *     violations at runtime.
 */

export type CascadeLevel = 'role' | 'label' | 'testid' | 'css';

export interface ResolvedLocator {
  locator: Locator;
  level: CascadeLevel;
  /** The argument used to construct the winning locator — emitted into the spec. */
  arg: string | { role: string; name: string; exact?: boolean };
  /** True when the cascade had to take `.first()` of multiple matches. */
  ambiguous: boolean;
}

export interface ResolveSpec {
  intent: string;
  role?: string;
  label?: string;
  testid?: string;
  css?: string;
}

const ROLE_PATTERNS: Array<[RegExp, string]> = [
  [/button|submit|sign\s*(in|up)|log\s*(in|out)|continue|next|cancel/i, 'button'],
  [/(check|tick)box/i, 'checkbox'],
  [/radio/i, 'radio'],
  [/select|dropdown|combo/i, 'combobox'],
  [/link|anchor/i, 'link'],
  [/textbox|input|field|email|password|user(name)?/i, 'textbox'],
];

function guessRole(intent: string): string | undefined {
  for (const [re, role] of ROLE_PATTERNS) {
    if (re.test(intent)) return role;
  }
  return undefined;
}

async function countOf(locator: Locator): Promise<number> {
  try { return await locator.count(); } catch { return 0; }
}

type Candidate = { locator: Locator; level: CascadeLevel; arg: ResolvedLocator['arg'] };

/**
 * Cascade resolver. Prefers unique matches; falls back to ambiguous-first
 * only after every level has been tried. Never returns a unique-looking
 * result for what is actually a multi-match — the spec we transcribe gets
 * to know whether `.first()` is needed.
 */
export async function resolve(page: Page, spec: ResolveSpec): Promise<ResolvedLocator | null> {
  const role = spec.role ?? guessRole(spec.intent);
  const name = spec.label ?? spec.intent;
  const ambiguousCandidates: Candidate[] = [];

  const tryCandidate = async (c: Candidate): Promise<ResolvedLocator | null> => {
    const n = await countOf(c.locator);
    if (n === 1) return { locator: c.locator, level: c.level, arg: c.arg, ambiguous: false };
    if (n > 1) ambiguousCandidates.push(c);
    return null;
  };

  // 1. role + accessible name — exact first, then fuzzy
  if (role && name) {
    const exact = page.getByRole(role as Parameters<Page['getByRole']>[0], { name, exact: true });
    const winner = await tryCandidate({ locator: exact, level: 'role', arg: { role, name, exact: true } });
    if (winner) return winner;

    const fuzzy = page.getByRole(role as Parameters<Page['getByRole']>[0], { name });
    const w2 = await tryCandidate({ locator: fuzzy, level: 'role', arg: { role, name } });
    if (w2) return w2;
  }

  // 2. label — explicit hint, then intent
  if (spec.label) {
    const exact = page.getByLabel(spec.label, { exact: true });
    const w = await tryCandidate({ locator: exact, level: 'label', arg: spec.label });
    if (w) return w;
    const fuzzy = page.getByLabel(spec.label);
    const w2 = await tryCandidate({ locator: fuzzy, level: 'label', arg: spec.label });
    if (w2) return w2;
  }
  const byLabelFromIntent = page.getByLabel(spec.intent);
  const labelW = await tryCandidate({ locator: byLabelFromIntent, level: 'label', arg: spec.intent });
  if (labelW) return labelW;

  // 3. testid
  if (spec.testid) {
    const byTestId = page.getByTestId(spec.testid);
    const w = await tryCandidate({ locator: byTestId, level: 'testid', arg: spec.testid });
    if (w) return w;
  }

  // 4. css
  if (spec.css) {
    const byCss = page.locator(spec.css);
    const w = await tryCandidate({ locator: byCss, level: 'css', arg: spec.css });
    if (w) return w;
  }

  // Nothing resolved uniquely. If we have ambiguous candidates, take the
  // best (most-preferred level) and mark it ambiguous so the spec emits
  // `.first()` honestly.
  if (ambiguousCandidates.length > 0) {
    const priority: CascadeLevel[] = ['role', 'label', 'testid', 'css'];
    ambiguousCandidates.sort((a, b) => priority.indexOf(a.level) - priority.indexOf(b.level));
    const best = ambiguousCandidates[0]!;
    return { locator: best.locator.first(), level: best.level, arg: best.arg, ambiguous: true };
  }

  return null;
}

/**
 * Emit a Playwright call expression for the resolved cascade level.
 * When `ambiguous`, the emitter appends `.first()` so the runtime spec
 * survives strict-mode.
 */
export function emitLocatorCall(level: CascadeLevel, arg: ResolvedLocator['arg'], ambiguous = false): string {
  const tail = ambiguous ? '.first()' : '';
  switch (level) {
    case 'role': {
      const a = arg as { role: string; name: string; exact?: boolean };
      const opts: Record<string, unknown> = { name: a.name };
      if (a.exact) opts.exact = true;
      return `page.getByRole(${JSON.stringify(a.role)}, ${JSON.stringify(opts)})${tail}`;
    }
    case 'label':
      return `page.getByLabel(${JSON.stringify(arg as string)})${tail}`;
    case 'testid':
      return `page.getByTestId(${JSON.stringify(arg as string)})${tail}`;
    case 'css':
      return `page.locator(${JSON.stringify(arg as string)})${tail}`;
  }
}

/** Escape a string for safe use inside a `new RegExp(...)` pattern. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
