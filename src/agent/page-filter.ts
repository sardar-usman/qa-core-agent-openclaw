import Anthropic from '@anthropic-ai/sdk';
import type { DiscoveredPage } from './discovery.js';

/**
 * Page relevance filter — trims a discovered page set to what is worth
 * exploring. 30 sitemap pages is too many to plan blindly; one cheap Haiku
 * call (same pattern as parse-features) picks:
 *
 *   - with a feature list: the most relevant page per feature, at most
 *     MAX_PAGES_WITH_FEATURES total, each tagged with its feature
 *   - without one: up to MAX_PAGES_NO_FEATURES pages that look like DISTINCT
 *     features (login, search, product, cart, contact) over near-duplicates
 *
 * Deterministic fallback when the call fails or no API key is available:
 * the first N shallowest unique-pathname pages. SRS and user page sets are
 * never trimmed here (the SRS states them, the user typed them); the caller
 * only filters sitemap/crawl sets.
 */

export const MAX_PAGES_WITH_FEATURES = 8;
export const MAX_PAGES_NO_FEATURES = 5;

const HAIKU_MODEL = 'claude-haiku-4-5';
const PRICE = { in: 1.0, out: 5.0 };

export interface FilterPagesOptions {
  pages: DiscoveredPage[];
  /** Feature list from the SRS map or --features. Drives per-feature picking. */
  features?: string[];
  apiKey?: string;
  model?: string;
}

export interface FilterPagesResult {
  pages: DiscoveredPage[];
  /** llm = Haiku picked; fallback = deterministic; passthrough = under the cap. */
  method: 'llm' | 'fallback' | 'passthrough';
  costUsd: number;
}

/** The cap that applies for a given feature list. */
export function pageCapFor(features?: string[]): number {
  return features && features.length > 0 ? MAX_PAGES_WITH_FEATURES : MAX_PAGES_NO_FEATURES;
}

/**
 * Deterministic fallback: the first `cap` shallowest unique-pathname pages.
 * Stable: ties keep discovery order. Exported so the smoke locks it.
 */
export function fallbackFilter(pages: DiscoveredPage[], cap: number): DiscoveredPage[] {
  const seen = new Set<string>();
  const unique: Array<{ p: DiscoveredPage; depth: number; i: number }> = [];
  for (const [i, p] of pages.entries()) {
    let pathname: string;
    try {
      pathname = new URL(p.url).pathname;
    } catch {
      continue;
    }
    if (seen.has(pathname)) continue;
    seen.add(pathname);
    unique.push({ p, depth: pathname.split('/').filter(Boolean).length, i });
  }
  return unique
    .sort((a, b) => a.depth - b.depth || a.i - b.i)
    .slice(0, cap)
    .map((x) => x.p);
}

const SYSTEM = `You pick the most test-worthy pages from a list of URLs discovered on one site.

Rules:
- Output ONLY a JSON array. No prose. No code fence.
- Each element: { "url": "<one of the input URLs, verbatim>", "feature": "<short kebab-case feature name>" }.
- When a FEATURES list is given: pick the single most relevant page per feature (skip a feature no URL plausibly serves), and never exceed the stated cap.
- When no FEATURES list is given: pick pages that look like DISTINCT features of the site (login, search, product, cart, contact, registration) over near-duplicates of each other. Never exceed the stated cap.
- Prefer functional pages (forms, flows) over marketing/blog/legal pages.
- Never invent a URL that is not in the input list.`;

/**
 * Filter a discovered page set to the most relevant pages. Under the cap the
 * set passes through untouched. The Haiku pick is validated (chosen URLs must
 * come from the input, cap enforced); anything unusable falls back to the
 * deterministic shallowest-first trim, never an error.
 */
export async function filterPages(opts: FilterPagesOptions): Promise<FilterPagesResult> {
  const cap = pageCapFor(opts.features);
  if (opts.pages.length <= cap) {
    return { pages: opts.pages, method: 'passthrough', costUsd: 0 };
  }
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { pages: fallbackFilter(opts.pages, cap), method: 'fallback', costUsd: 0 };
  }

  try {
    const client = new Anthropic({ apiKey });
    const features = (opts.features ?? []).filter((f) => f.trim().length > 0);
    const featureBlock = features.length > 0
      ? `FEATURES (pick the most relevant page per feature, cap ${cap} total):\n${features.map((f) => `- ${f}`).join('\n')}`
      : `No feature list. Pick up to ${cap} pages that look like distinct features.`;
    const response = await client.messages.create({
      model: opts.model ?? HAIKU_MODEL,
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam],
      messages: [
        {
          role: 'user',
          content: `${featureBlock}\n\nDiscovered URLs:\n${opts.pages.map((p) => p.url).join('\n')}`,
        },
      ],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const u = response.usage;
    const costUsd = (u.input_tokens * PRICE.in + u.output_tokens * PRICE.out) / 1_000_000;

    const picked = parsePickResponse(text, opts.pages, cap);
    if (picked.length === 0) {
      return { pages: fallbackFilter(opts.pages, cap), method: 'fallback', costUsd };
    }
    return { pages: picked, method: 'llm', costUsd };
  } catch {
    return { pages: fallbackFilter(opts.pages, cap), method: 'fallback', costUsd: 0 };
  }
}

/**
 * Validate the model's pick: JSON array of {url, feature}, every url from the
 * input list (matched by exact string or by pathname), capped, deduped.
 * Returns [] when nothing usable parsed. Exported for the smoke test.
 */
export function parsePickResponse(text: string, pages: DiscoveredPage[], cap: number): DiscoveredPage[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const byUrl = new Map<string, DiscoveredPage>();
  const byPath = new Map<string, DiscoveredPage>();
  for (const p of pages) {
    byUrl.set(p.url, p);
    try {
      byPath.set(new URL(p.url).pathname, p);
    } catch { /* unparseable page url — exact match only */ }
  }
  const out: DiscoveredPage[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= cap) break;
    const url = typeof item === 'string' ? item : (item as { url?: unknown })?.url;
    if (typeof url !== 'string') continue;
    const trimmed = url.trim();
    let page = byUrl.get(trimmed);
    if (!page && trimmed.startsWith('/')) {
      // The model echoed a bare pathname; match it directly.
      page = byPath.get(trimmed);
    }
    if (!page) {
      try {
        page = byPath.get(new URL(trimmed).pathname);
      } catch { /* not a URL the input knows */ }
    }
    if (!page || seen.has(page.url)) continue;
    seen.add(page.url);
    const feature = typeof item === 'object' && item !== null && typeof (item as { feature?: unknown }).feature === 'string'
      ? ((item as { feature: string }).feature.trim() || undefined)
      : undefined;
    out.push(feature ? { ...page, feature } : page);
  }
  return out;
}
