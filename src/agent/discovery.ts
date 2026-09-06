import type { RequirementsMap } from './requirements.js';

/**
 * Multi-page discovery — the ladder that decides WHICH pages a run covers.
 *
 * Without discovery the agent tests only the entry page. With it, the run
 * walks a ladder of sources, stopping at the first rung that yields pages:
 *
 *   1. SRS map    — features in the requirements map that state URLs
 *   2. User list  — an explicit --urls flag value
 *   3. Sitemap    — robots.txt Sitemap directive, then sitemap.xml
 *   4. Polite crawl — same-origin links from the entry page, depth 2
 *   4b. Browser crawl — same walk, links read off the RENDERED DOM. Only
 *       when the fetch crawl found nothing (client-rendered SPAs serve a
 *       shell with no anchors); static sites keep the cheap path
 *   5. Entry only — the entry URL, with a warning naming why 1-4 failed
 *
 * Note on rung order: the written spec listed the user list AFTER sitemap and
 * crawl. It sits above them here on purpose: an explicit --urls value is the
 * user naming exactly what to test, and letting a sitemap override it would
 * make the flag dead on any site that has one. The SRS stays on top (a stated
 * requirements document outranks a quick flag, and rung 1 only fires when the
 * SRS actually states URLs).
 *
 * Politeness rules (locked by smoke-discovery-ladder):
 * - robots.txt is fetched once and honored by BOTH the sitemap and crawl
 *   rungs. A disallow-all robots skips straight past both, with the reason
 *   recorded. Disallowed paths never appear in the page set.
 * - The crawl is sequential (never parallel), waits CRAWL_DELAY_MS between
 *   fetches, identifies itself with the DISCOVERY_UA user agent, uses plain
 *   HTTP fetch (no browser), and stops at CRAWL_MAX_DEPTH / CRAWL_PAGE_CAP.
 * - The sitemap set is capped at SITEMAP_PAGE_CAP, preferring shallow paths
 *   (fewer segments) when trimming.
 *
 * Never fails silently into single-page mode: every rung that yields nothing
 * records what it tried in `warnings`, and the entry-only fallback names the
 * failed rungs.
 */

export interface DiscoveredPage {
  url: string;
  source: 'srs' | 'sitemap' | 'crawl' | 'browser-crawl' | 'user' | 'entry';
  /** Feature this page belongs to, when the source knows it (SRS rung). */
  feature?: string;
}

/**
 * Collect anchor hrefs from a page's RENDERED DOM (a real browser), for the
 * browser-crawl rung. Returns null when the page could not be loaded.
 * Injectable so the smoke drives the rung with no browser.
 */
export type RenderedLinkCollector = (url: string) => Promise<string[] | null>;

export interface DiscoveryResult {
  pages: DiscoveredPage[];
  /** The rung that yielded the pages: srs | user | sitemap | crawl | entry. */
  method: string;
  warnings: string[];
}

/** User agent the sitemap fetches and the crawl identify with. */
export const DISCOVERY_UA = 'qa-core-agent-discovery';
/** Cap on pages taken from a sitemap (shallow paths preferred when trimming). */
export const SITEMAP_PAGE_CAP = 30;
/** Cap on pages the crawl collects. */
export const CRAWL_PAGE_CAP = 15;
/** How many link hops from the entry page the crawl follows. */
export const CRAWL_MAX_DEPTH = 2;
/** Pause between crawl fetches. One page at a time, never parallel. */
export const CRAWL_DELAY_MS = 500;
/** Cap on child sitemaps fetched from one sitemap index (one nesting level). */
const SITEMAP_INDEX_CHILD_CAP = 10;
/** Timeout per discovery fetch. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The slice of fetch() discovery uses. Injectable so the smoke test drives the
 * whole ladder from in-code fixtures with zero network.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Default fetch: global fetch with the discovery UA and a hard timeout. */
const defaultFetch: FetchLike = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': DISCOVERY_UA, ...(init?.headers ?? {}) },
      signal: controller.signal,
      redirect: 'follow',
    });
    return { ok: res.ok, status: res.status, text: () => res.text() };
  } finally {
    clearTimeout(timer);
  }
};

/** File extensions that are assets, not pages. Links to these are skipped. */
const ASSET_EXT_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|rss|atom|pdf|zip|gz|tar|rar|7z|mp4|mp3|wav|webm|mov|woff2?|ttf|eot|otf|map|txt|csv|xlsx?|docx?|pptx?)(\?|$)/i;

/** Schemes that are never pages. */
const NON_PAGE_SCHEME_RE = /^(mailto:|tel:|javascript:|data:|ftp:)/i;

export interface RobotsInfo {
  /** False when robots.txt could not be fetched (treated as allow-all). */
  fetched: boolean;
  /** Disallow path rules that apply to our agent (specific group wins over *). */
  disallow: string[];
  /** Sitemap directive URLs, in file order. */
  sitemaps: string[];
  /** True when a rule disallows every path for our agent. */
  disallowAll: boolean;
}

/**
 * Parse robots.txt for the rules that apply to our agent. Standard group
 * semantics: the group naming our agent (substring match, case-insensitive)
 * wins; otherwise the `*` group applies. Sitemap directives are global.
 * Empty Disallow lines mean allow-all and contribute no rule.
 */
export function parseRobotsTxt(text: string, agent: string = DISCOVERY_UA): Omit<RobotsInfo, 'fetched'> {
  const sitemaps: string[] = [];
  type Group = { agents: string[]; disallow: string[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'disallow' && current) {
      if (value) current.disallow.push(value);
    }
  }
  const agentLower = agent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && (agentLower.includes(a) || a.includes(agentLower))));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const disallow = (specific ?? wildcard)?.disallow ?? [];
  const disallowAll = disallow.some((d) => d === '/' || d === '/*');
  return { disallow, sitemaps, disallowAll };
}

/** Does robots.txt allow this pathname for our agent? Prefix rules, basic `*` and `$`. */
export function robotsAllows(robots: Pick<RobotsInfo, 'disallow'>, pathname: string): boolean {
  for (const rule of robots.disallow) {
    if (rule.includes('*') || rule.endsWith('$')) {
      const rx = new RegExp(
        '^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\$$/, '$').replace(/\*/g, '.*'),
      );
      if (rx.test(pathname)) return false;
    } else if (pathname.startsWith(rule)) {
      return false;
    }
  }
  return true;
}

/** Resolve a candidate href/loc to a same-origin page URL, or null. */
function toPageUrl(candidate: string, base: URL): URL | null {
  const trimmed = candidate.trim();
  if (!trimmed || NON_PAGE_SCHEME_RE.test(trimmed)) return null;
  let u: URL;
  try {
    u = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin !== base.origin) return null;
  if (ASSET_EXT_RE.test(u.pathname)) return null;
  u.hash = '';
  return u;
}

/** Count path segments, so trimming can prefer shallow pages. */
function pathDepth(u: URL): number {
  return u.pathname.split('/').filter(Boolean).length;
}

/** Dedupe by pathname, keeping first occurrence order. */
function dedupeByPathname(urls: URL[]): URL[] {
  const seen = new Set<string>();
  const out: URL[] = [];
  for (const u of urls) {
    if (seen.has(u.pathname)) continue;
    seen.add(u.pathname);
    out.push(u);
  }
  return out;
}

/** Extract <loc> values from a sitemap or sitemap-index body. */
function sitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Extract href values from an HTML body. Plain regex, no browser. */
function extractHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (v && !v.startsWith('#')) out.push(v);
  }
  return out;
}

export interface DiscoverOptions {
  entryUrl: string;
  /** Rung 1: requirements map whose features may state URLs. */
  requirements?: RequirementsMap;
  /** Rung 2: explicit page list from --urls. */
  userUrls?: string[];
  /** Injectable fetch for offline tests. Defaults to global fetch + UA + timeout. */
  fetchFn?: FetchLike;
  /** Crawl pause override. Tests set 0; the default is CRAWL_DELAY_MS. */
  crawlDelayMs?: number;
  /**
   * Injectable rendered-DOM link collector for the browser-crawl rung.
   * Defaults to a real Playwright browser, launched ONLY when the rung runs.
   */
  collectRendered?: RenderedLinkCollector;
}

/** Walk the discovery ladder. See the module doc for the rung order. */
export async function discoverPages(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const entry = new URL(opts.entryUrl);
  const fetchFn = opts.fetchFn ?? defaultFetch;

  // Rung 1 — SRS map. Only fires when the map actually states URLs.
  if (opts.requirements) {
    const pages: DiscoveredPage[] = [];
    const seen = new Set<string>();
    for (const f of opts.requirements.features) {
      for (const raw of f.urls ?? []) {
        const u = toPageUrl(raw, entry) ?? absoluteUrlOrNull(raw);
        if (!u) {
          warnings.push(`SRS: could not resolve stated URL "${raw}" for feature "${f.name}"; skipped.`);
          continue;
        }
        const key = `${u.origin}${u.pathname}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pages.push({ url: u.toString(), source: 'srs', feature: f.name });
      }
    }
    if (pages.length > 0) {
      return { pages, method: 'srs', warnings };
    }
    warnings.push('SRS map present but no feature states a URL; falling through to the next rung.');
  }

  // Rung 2 — explicit user list. Above sitemap/crawl on purpose (module doc).
  if (opts.userUrls && opts.userUrls.length > 0) {
    const resolved: URL[] = [];
    for (const raw of opts.userUrls) {
      // A user URL must be absolute (https://...) or site-absolute (/path).
      // Anything else ("not a url", "login") would silently resolve as a
      // relative path, which is never what the flag meant.
      const trimmed = raw.trim();
      const wellFormed = /^https?:\/\//i.test(trimmed) || trimmed.startsWith('/');
      const u = wellFormed ? (toPageUrl(trimmed, entry) ?? absoluteUrlOrNull(trimmed)) : null;
      if (!u) {
        warnings.push(`--urls: "${raw}" is not a usable page URL; skipped.`);
        continue;
      }
      resolved.push(u);
    }
    const pages = dedupeByPathname(resolved).map((u): DiscoveredPage => ({ url: u.toString(), source: 'user' }));
    if (pages.length > 0) {
      return { pages, method: 'user', warnings };
    }
    warnings.push('--urls was provided but none of its values resolved to a usable URL; falling through.');
  }

  // robots.txt — fetched once, honored by BOTH the sitemap and crawl rungs.
  let robots: RobotsInfo = { fetched: false, disallow: [], sitemaps: [], disallowAll: false };
  try {
    const res = await fetchFn(`${entry.origin}/robots.txt`);
    if (res.ok) {
      robots = { fetched: true, ...parseRobotsTxt(await res.text()) };
      if (robots.disallow.length > 0) {
        warnings.push(`robots.txt: ${robots.disallow.length} Disallow rule(s) apply to our agent; disallowed paths are excluded.`);
      }
      if (robots.sitemaps.length > 0) {
        warnings.push(`robots.txt: Sitemap directive found (${robots.sitemaps.length}).`);
      }
    } else {
      warnings.push(`robots.txt: HTTP ${res.status}; treating as allow-all.`);
    }
  } catch (err) {
    warnings.push(`robots.txt: fetch failed (${(err as Error).message}); treating as allow-all.`);
  }

  if (robots.disallowAll) {
    warnings.push('robots.txt disallows all paths for our agent; sitemap and crawl rungs skipped out of politeness.');
  } else {
    // Rung 3 — sitemap.
    const sitemapPages = await sitemapRung(entry, robots, fetchFn, warnings);
    if (sitemapPages.length > 0) {
      return { pages: sitemapPages, method: 'sitemap', warnings };
    }

    // Rung 4 — polite crawl (plain fetch).
    const crawlPages = await crawlRung(entry, robots, fetchFn, opts.crawlDelayMs ?? CRAWL_DELAY_MS, warnings);
    if (crawlPages.length > 0) {
      return { pages: crawlPages, method: 'crawl', warnings };
    }

    // Rung 4b — browser-assisted crawl. Only when the fetch crawl yielded
    // nothing: a client-rendered SPA serves a shell with no anchors to plain
    // fetch (practicesoftwaretesting.com found zero links on the live run),
    // so the links must be read off the RENDERED DOM. Static sites never pay
    // the browser cost. Same robots rules, caps, delay, and dedupe.
    let collect = opts.collectRendered;
    let closeCollector: (() => Promise<void>) | undefined;
    if (!collect) {
      const d = await defaultRenderedCollector(warnings);
      if (d) {
        collect = d.collect;
        closeCollector = d.close;
      }
    }
    if (collect) {
      try {
        const rendered = await walkCrawl({
          entry,
          robots,
          getLinks: collect,
          delayMs: opts.crawlDelayMs ?? CRAWL_DELAY_MS,
          warnings,
          label: 'browser crawl',
          source: 'browser-crawl',
        });
        if (rendered.length > 0) {
          return { pages: rendered, method: 'browser-crawl', warnings };
        }
      } finally {
        await closeCollector?.();
      }
    }
  }

  // Rung 5 — entry only. Loud, never silent.
  warnings.push(
    `Discovery fell back to the entry page only. No rung yielded pages — see the warnings above for what each rung tried.`,
  );
  return {
    pages: [{ url: entry.toString(), source: 'entry' }],
    method: 'entry',
    warnings,
  };
}

/** Parse an absolute URL with no base, or null. Used for cross-origin SRS/user URLs. */
function absoluteUrlOrNull(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (ASSET_EXT_RE.test(u.pathname)) return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

/** Rung 3: robots Sitemap directive first, then /sitemap.xml, one index level deep. */
async function sitemapRung(
  entry: URL,
  robots: RobotsInfo,
  fetchFn: FetchLike,
  warnings: string[],
): Promise<DiscoveredPage[]> {
  const candidates = robots.sitemaps.length > 0
    ? robots.sitemaps
    : [`${entry.origin}/sitemap.xml`];

  const collected: URL[] = [];
  for (const smUrl of candidates) {
    let body: string;
    try {
      const res = await fetchFn(new URL(smUrl, entry).toString());
      if (!res.ok) {
        warnings.push(`sitemap: ${smUrl} returned HTTP ${res.status}.`);
        continue;
      }
      body = await res.text();
    } catch (err) {
      warnings.push(`sitemap: fetch of ${smUrl} failed (${(err as Error).message}).`);
      continue;
    }
    const locs = sitemapLocs(body);
    if (/<sitemapindex/i.test(body)) {
      // One nesting level: fetch child sitemaps listed by the index.
      const children = locs.slice(0, SITEMAP_INDEX_CHILD_CAP);
      if (locs.length > children.length) {
        warnings.push(`sitemap: index lists ${locs.length} child sitemaps; fetched the first ${children.length}.`);
      }
      for (const child of children) {
        try {
          const res = await fetchFn(new URL(child, entry).toString());
          if (!res.ok) continue;
          for (const loc of sitemapLocs(await res.text())) {
            const u = toPageUrl(loc, entry);
            if (u && robotsAllows(robots, u.pathname)) collected.push(u);
          }
        } catch {
          // A broken child sitemap is skipped; the others still count.
        }
      }
    } else {
      for (const loc of locs) {
        const u = toPageUrl(loc, entry);
        if (u && robotsAllows(robots, u.pathname)) collected.push(u);
      }
    }
  }

  let pages = dedupeByPathname(collected);
  if (pages.length === 0) {
    warnings.push('sitemap: no usable same-origin pages found; falling through to the crawl.');
    return [];
  }
  if (pages.length > SITEMAP_PAGE_CAP) {
    // Stable sort by depth so shallow paths survive the trim.
    const before = pages.length;
    pages = pages
      .map((u, i) => ({ u, i }))
      .sort((a, b) => pathDepth(a.u) - pathDepth(b.u) || a.i - b.i)
      .slice(0, SITEMAP_PAGE_CAP)
      .map((x) => x.u);
    warnings.push(`sitemap: ${before} pages trimmed to ${SITEMAP_PAGE_CAP}, keeping the shallowest paths.`);
  }
  return pages.map((u): DiscoveredPage => ({ url: u.toString(), source: 'sitemap' }));
}

/**
 * The shared polite crawl walker used by BOTH crawl rungs. Sequential,
 * delayed, depth- and count-capped, robots-respecting, fragment-free, deduped
 * by pathname. Only the link source differs: plain fetch + href regex for the
 * fetch rung, a rendered-DOM collector for the browser rung. Yields nothing
 * when the entry page has no same-origin links (the entry alone is not
 * "discovery").
 */
async function walkCrawl(opts: {
  entry: URL;
  robots: RobotsInfo;
  /** Links found on one page, or null when the page could not be loaded. */
  getLinks: (url: string) => Promise<string[] | null>;
  delayMs: number;
  warnings: string[];
  /** Warning prefix: 'crawl' or 'browser crawl'. */
  label: string;
  source: DiscoveredPage['source'];
}): Promise<DiscoveredPage[]> {
  const { entry, robots, getLinks, delayMs, warnings, label, source } = opts;
  if (!robotsAllows(robots, entry.pathname)) {
    warnings.push(`${label}: robots.txt disallows the entry path ${entry.pathname}; ${label} skipped.`);
    return [];
  }
  const visited = new Set<string>([entry.pathname]);
  const collected: URL[] = [];
  const queue: Array<{ u: URL; depth: number }> = [{ u: entry, depth: 0 }];
  let loads = 0;
  let failures = 0;

  while (queue.length > 0 && collected.length < CRAWL_PAGE_CAP) {
    const { u, depth } = queue.shift()!;
    if (loads > 0 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    loads++;
    let hrefs: string[] | null;
    try {
      hrefs = await getLinks(u.toString());
    } catch {
      hrefs = null;
    }
    if (hrefs === null) {
      failures++;
      continue;
    }
    collected.push(u);
    if (depth >= CRAWL_MAX_DEPTH) continue;
    for (const href of hrefs) {
      const link = toPageUrl(href, u);
      if (!link) continue;
      if (visited.has(link.pathname)) continue;
      if (!robotsAllows(robots, link.pathname)) continue;
      visited.add(link.pathname);
      queue.push({ u: link, depth: depth + 1 });
      if (visited.size > CRAWL_PAGE_CAP * 4) break; // frontier guard
    }
  }

  if (failures > 0) {
    warnings.push(`${label}: ${failures} page load(s) failed or returned non-OK status.`);
  }
  if (collected.length <= 1) {
    warnings.push(`${label}: found no additional same-origin pages beyond the entry; falling through.`);
    return [];
  }
  return collected.slice(0, CRAWL_PAGE_CAP).map((u): DiscoveredPage => ({ url: u.toString(), source }));
}

/** Rung 4: the plain-fetch crawl. Cheap; fails on client-rendered SPAs. */
async function crawlRung(
  entry: URL,
  robots: RobotsInfo,
  fetchFn: FetchLike,
  delayMs: number,
  warnings: string[],
): Promise<DiscoveredPage[]> {
  return walkCrawl({
    entry,
    robots,
    getLinks: async (url) => {
      try {
        const res = await fetchFn(url, { headers: { 'user-agent': DISCOVERY_UA } });
        if (!res.ok) return null;
        return extractHrefs(await res.text());
      } catch {
        return null;
      }
    },
    delayMs,
    warnings,
    label: 'crawl',
    source: 'crawl',
  });
}

/**
 * Default rendered-DOM collector for the browser-crawl rung: one headless
 * Playwright browser for the whole rung, the same settle logic the Planner
 * snapshot uses, anchors read off the rendered DOM. Launched lazily so static
 * sites (whose fetch crawl succeeds) never pay for a browser. Returns null
 * with a warning when a browser cannot be launched.
 */
async function defaultRenderedCollector(
  warnings: string[],
): Promise<{ collect: RenderedLinkCollector; close: () => Promise<void> } | null> {
  try {
    const { chromium } = await import('playwright');
    const { installEvalShim } = await import('./eval-shim.js');
    const { settleForSnapshot } = await import('./planner.js');
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: DISCOVERY_UA });
    await installEvalShim(ctx);
    const page = await ctx.newPage();
    const collect: RenderedLinkCollector = async (url) => {
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 15_000 });
        await settleForSnapshot(page);
        return await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .map((a) => a.getAttribute('href') || '')
            .filter((h) => h.length > 0),
        );
      } catch {
        return null;
      }
    };
    return {
      collect,
      close: async () => {
        await browser.close().catch(() => {});
      },
    };
  } catch (err) {
    warnings.push(`browser crawl: could not launch a browser (${(err as Error).message}); rung skipped.`);
    return null;
  }
}
