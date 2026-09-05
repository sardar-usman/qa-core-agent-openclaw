/**
 * Locks the multi-page discovery ladder (src/agent/discovery.ts):
 *   - rung order: srs -> user -> sitemap -> crawl -> entry (user sits above
 *     sitemap/crawl on purpose: an explicit --urls list must not be overridden
 *     by remote discovery)
 *   - robots.txt honored by BOTH sitemap and crawl; disallow-all skips both
 *     rungs and routes to the user list / entry fallback with the reason
 *     recorded
 *   - same-origin filtering, asset and fragment skipping, dedupe by pathname
 *   - the 30-page sitemap cap trims keeping the shallowest paths
 *   - sitemap-index nesting (one level)
 *   - the crawl: depth cap, page cap, robots-disallowed paths skipped,
 *     discovery user agent sent, sequential fetching
 *   - the entry-only fallback carries warnings naming what each rung tried
 *
 * Pure in-code fixtures via the injectable fetchFn. No network. No LLM.
 */
import {
  discoverPages,
  parseRobotsTxt,
  robotsAllows,
  DISCOVERY_UA,
  SITEMAP_PAGE_CAP,
  CRAWL_PAGE_CAP,
  type FetchLike,
} from '../src/agent/discovery.js';
import type { RequirementsMap } from '../src/agent/requirements.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const ORIGIN = 'https://shop.example';

/** Fixture fetch: URL -> body (string) or status (number). Records requests. */
function fixtureFetch(routes: Record<string, string | number>): { fetchFn: FetchLike; requests: Array<{ url: string; ua?: string }> } {
  const requests: Array<{ url: string; ua?: string }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, ua: init?.headers?.['user-agent'] });
    const hit = routes[url];
    if (hit === undefined) return { ok: false, status: 404, text: async () => '' };
    if (typeof hit === 'number') return { ok: false, status: hit, text: async () => '' };
    return { ok: true, status: 200, text: async () => hit };
  };
  return { fetchFn, requests };
}

const sitemapXml = (urls: string[]): string =>
  `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;

/* ─── A. robots.txt parsing ────────────────────────────────────────────────── */
const robots = parseRobotsTxt(
  `# comment\nUser-agent: *\nDisallow: /admin\nDisallow: /private/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`,
);
check('A1. Disallow rules for * apply to our agent', JSON.stringify(robots.disallow) === '["/admin","/private/"]', JSON.stringify(robots.disallow));
check('A2. the Sitemap directive is noted', robots.sitemaps[0] === `${ORIGIN}/sitemap.xml`);
check('A3. a disallowed path is refused', !robotsAllows(robots, '/admin/panel') && !robotsAllows(robots, '/private/x'));
check('A4. an allowed path passes', robotsAllows(robots, '/login'));
const specific = parseRobotsTxt(`User-agent: qa-core-agent-discovery\nDisallow: /only-for-us\n\nUser-agent: *\nDisallow: /for-everyone\n`);
check('A5. a group naming our agent wins over *', JSON.stringify(specific.disallow) === '["/only-for-us"]', JSON.stringify(specific.disallow));
check('A6. Disallow: / means disallow-all', parseRobotsTxt('User-agent: *\nDisallow: /\n').disallowAll);

/* ─── B. rung 1: SRS map with stated URLs ──────────────────────────────────── */
const map: RequirementsMap = {
  features: [
    { name: 'login', description: 'sign in', urls: ['/login'], rules: [{ id: 'R1', text: 'x', type: 'validation' }] },
    { name: 'cart', description: 'cart', urls: [`${ORIGIN}/cart`, '/login'], rules: [] },
  ],
  roles: [],
  truncated: false,
};
{
  const { fetchFn, requests } = fixtureFetch({});
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, requirements: map, fetchFn, crawlDelayMs: 0 });
  check('B1. SRS rung wins when the map states URLs', r.method === 'srs' && r.pages.length === 2, JSON.stringify(r.pages));
  check('B2. SRS pages are tagged with their feature', r.pages[0]?.feature === 'login' && r.pages[1]?.feature === 'cart');
  check('B3. SRS pages dedupe by pathname (cart also cited /login)', r.pages.filter((p) => p.url.endsWith('/login')).length === 1);
  check('B4. the SRS rung makes no network fetches', requests.length === 0, String(requests.length));
}

/* ─── C. rung 2: explicit user list beats sitemap/crawl ────────────────────── */
{
  const { fetchFn, requests } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nDisallow:\n`,
    [`${ORIGIN}/sitemap.xml`]: sitemapXml([`${ORIGIN}/a`, `${ORIGIN}/b`]),
  });
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, userUrls: ['/login', `${ORIGIN}/cart`, '/login#frag', 'not a url'], fetchFn, crawlDelayMs: 0 });
  check('C1. user rung wins over an available sitemap', r.method === 'user', r.method);
  check('C2. user pages resolve, dedupe by pathname, and drop junk', r.pages.length === 2 && r.pages.every((p) => p.source === 'user'), JSON.stringify(r.pages));
  check('C3. the unusable --urls value is warned about', r.warnings.some((w) => w.includes('not a url')), JSON.stringify(r.warnings));
  check('C4. no sitemap fetch happened (rung never reached)', !requests.some((q) => q.url.includes('sitemap')), JSON.stringify(requests));
}

/* ─── D. rung 3: sitemap via robots directive, same-origin, cap, dedupe ────── */
{
  // 35 URLs: depths 1..35 scattered, plus cross-origin and asset noise and a
  // robots-disallowed path. The cap must keep the 30 shallowest.
  const deep = Array.from({ length: 33 }, (_, i) => `${ORIGIN}/${'d/'.repeat((i % 6) + 1)}page${i}`);
  const locs = [
    `${ORIGIN}/`, `${ORIGIN}/login`, `https://other.example/steal`, `${ORIGIN}/logo.png`,
    `${ORIGIN}/admin/secret`, `${ORIGIN}/login`, ...deep,
  ];
  const { fetchFn } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nDisallow: /admin\nSitemap: ${ORIGIN}/deep/sitemap-main.xml\n`,
    [`${ORIGIN}/deep/sitemap-main.xml`]: sitemapXml(locs),
  });
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn, crawlDelayMs: 0 });
  check('D1. sitemap rung fires via the robots Sitemap directive', r.method === 'sitemap', r.method);
  check(`D2. capped at ${SITEMAP_PAGE_CAP} pages`, r.pages.length === SITEMAP_PAGE_CAP, String(r.pages.length));
  check('D3. cross-origin URL excluded', !r.pages.some((p) => p.url.includes('other.example')));
  check('D4. asset URL excluded', !r.pages.some((p) => p.url.endsWith('.png')));
  check('D5. robots-disallowed path excluded from the sitemap set', !r.pages.some((p) => p.url.includes('/admin')));
  check('D6. dedupe by pathname (login listed twice, kept once)', r.pages.filter((p) => p.url.endsWith('/login')).length === 1);
  const depths = r.pages.map((p) => new URL(p.url).pathname.split('/').filter(Boolean).length);
  check('D7. trimming keeps the shallowest paths (all kept depths <= dropped depths)', Math.max(...depths) <= 6, JSON.stringify(depths));
  check('D8. shallow pages like / and /login survive the trim', r.pages.some((p) => new URL(p.url).pathname === '/') && r.pages.some((p) => p.url.endsWith('/login')));
  check('D9. the trim is warned about', r.warnings.some((w) => w.includes(`trimmed to ${SITEMAP_PAGE_CAP}`)), JSON.stringify(r.warnings));
}

/* ─── E. sitemap index nesting (one level) ─────────────────────────────────── */
{
  const { fetchFn } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: 404,
    [`${ORIGIN}/sitemap.xml`]: `<?xml version="1.0"?><sitemapindex><sitemap><loc>${ORIGIN}/sm-1.xml</loc></sitemap><sitemap><loc>${ORIGIN}/sm-2.xml</loc></sitemap></sitemapindex>`,
    [`${ORIGIN}/sm-1.xml`]: sitemapXml([`${ORIGIN}/a`]),
    [`${ORIGIN}/sm-2.xml`]: sitemapXml([`${ORIGIN}/b`]),
  });
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn, crawlDelayMs: 0 });
  check('E1. a sitemap index is followed one level deep', r.method === 'sitemap' && r.pages.length === 2, JSON.stringify(r.pages));
}

/* ─── F. rung 4: polite crawl when no sitemap exists ───────────────────────── */
{
  const { fetchFn, requests } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nDisallow: /admin\n`,
    [`${ORIGIN}/sitemap.xml`]: 404,
    [`${ORIGIN}/`]: `<a href="/login">L</a> <a href="/cart">C</a> <a href="/admin">A</a> <a href="/logo.svg">S</a> <a href="#top">T</a> <a href="https://other.example/x">O</a> <a href="/login#reset">dup</a>`,
    [`${ORIGIN}/login`]: `<a href="/login/help">H</a>`,
    [`${ORIGIN}/cart`]: `<a href="/checkout">K</a>`,
    [`${ORIGIN}/login/help`]: `<a href="/too/deep/now">D</a>`,
    [`${ORIGIN}/checkout`]: ``,
  });
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn, crawlDelayMs: 0 });
  check('F1. crawl rung fires when the sitemap 404s', r.method === 'crawl', r.method);
  const paths = r.pages.map((p) => new URL(p.url).pathname).sort();
  check('F2. crawl collects entry + linked pages, depth-capped', JSON.stringify(paths) === JSON.stringify(['/', '/cart', '/checkout', '/login', '/login/help']), JSON.stringify(paths));
  check('F3. depth-3 link never fetched', !requests.some((q) => q.url.includes('/too/deep/now')));
  check('F4. robots-disallowed link never fetched', !requests.some((q) => q.url.includes('/admin')));
  check('F5. asset and cross-origin links never fetched', !requests.some((q) => q.url.endsWith('.svg') || q.url.includes('other.example')));
  check('F6. crawl fetches identify with the discovery user agent', requests.filter((q) => !q.url.includes('robots') && !q.url.includes('sitemap')).every((q) => q.ua === DISCOVERY_UA));
  check(`F7. page cap constant is ${CRAWL_PAGE_CAP}`, CRAWL_PAGE_CAP === 15);
  check('F8. fragment link deduped by pathname (login fetched once)', requests.filter((q) => new URL(q.url).pathname === '/login').length === 1);
}

/* ─── G. robots disallow-all routes past sitemap AND crawl ─────────────────── */
{
  const routes = {
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nDisallow: /\n`,
    [`${ORIGIN}/sitemap.xml`]: sitemapXml([`${ORIGIN}/a`]),
    [`${ORIGIN}/`]: `<a href="/login">L</a>`,
  };
  const withUser = await discoverPages({ entryUrl: `${ORIGIN}/`, userUrls: ['/manual'], fetchFn: fixtureFetch(routes).fetchFn, crawlDelayMs: 0 });
  check('G1. disallow-all + --urls routes to the user rung', withUser.method === 'user', withUser.method);

  const f2 = fixtureFetch(routes);
  const noUser = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn: f2.fetchFn, crawlDelayMs: 0 });
  check('G2. disallow-all with no user list falls to entry-only', noUser.method === 'entry' && noUser.pages[0]?.source === 'entry');
  check('G3. the robots block is named in the warnings', noUser.warnings.some((w) => w.includes('disallows all paths')), JSON.stringify(noUser.warnings));
  check('G4. neither the sitemap nor any page was fetched', f2.requests.every((q) => q.url.endsWith('/robots.txt')), JSON.stringify(f2.requests));
}

/* ─── H. entry-only fallback carries every rung's warnings ─────────────────── */
{
  const { fetchFn } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: 404,
    [`${ORIGIN}/sitemap.xml`]: 500,
    [`${ORIGIN}/`]: `<p>no links here</p>`,
  });
  const emptyMap: RequirementsMap = {
    features: [{ name: 'login', description: 'no urls stated', rules: [] }],
    roles: [],
    truncated: false,
  };
  const r = await discoverPages({ entryUrl: `${ORIGIN}/landing`, requirements: emptyMap, fetchFn, crawlDelayMs: 0 });
  check('H1. everything failing yields the entry page, source entry', r.method === 'entry' && r.pages.length === 1 && r.pages[0]?.url === `${ORIGIN}/landing`);
  check('H2. the SRS rung recorded why it yielded nothing', r.warnings.some((w) => w.includes('no feature states a URL')));
  check('H3. the sitemap rung recorded its failure', r.warnings.some((w) => w.includes('HTTP 500')));
  check('H4. the crawl rung recorded why it yielded nothing', r.warnings.some((w) => w.includes('no additional same-origin pages')));
  check('H5. the fallback itself is loud', r.warnings.some((w) => w.includes('fell back to the entry page')));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the discovery ladder honors rung order and robots.txt, filters and caps politely, and never falls into single-page mode silently.');
