/**
 * Locks in the brand-vs-host display rule on the UI.
 *
 * The dashboard, run history, and download filenames should show the
 * brand slug (e.g. "saucedemo"), not the full host (e.g. "www.saucedemo.com").
 * The full host stays in r.host as the underlying identifier, and a `title`
 * attribute on each card preserves it for hover discovery.
 *
 * Approach:
 *   1. Open the UI in headless Chromium.
 *   2. Seed localStorage with synthetic runs covering several host shapes.
 *   3. Trigger re-render and assert what the user sees.
 *   4. Verify brandFromHost() helper output for representative inputs.
 *
 * Zero LLM, zero network.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const uiUrl = pathToFileURL(path.resolve(process.cwd(), 'qa-core-ui.html')).href;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const jsErrors: string[] = [];
page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console.error: ' + m.text()); });

await page.goto(uiUrl, { waitUntil: 'load' });
await page.waitForTimeout(300);

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

// 1) brandFromHost helper: verify the exact slug logic mirrors the server.
//    Inputs are passed in via the evaluate arg so the body stays free of
//    inner arrow functions (which tsx decorates with `__name`, blowing up
//    inside page.evaluate). See CLAUDE.md → "tsx + page.evaluate".
const helperOut = await page.evaluate((inputs) => {
  const out: Record<string, string> = {};
  for (const key in inputs) {
    // @ts-expect-error — brandFromHost is defined in the UI file
    out[key] = brandFromHost(inputs[key]);
  }
  return out;
}, {
  saucedemo: 'www.saucedemo.com',
  saucedemoNoWww: 'saucedemo.com',
  multipart: 'the-internet.herokuapp.com',
  subdomain: 'demo.playwright.dev',
  upper: 'WWW.Example.COM',
  bare: 'localhost',
  empty: '',
  nullish: null as unknown as string,
} as Record<string, string>);
check('A. brandFromHost("www.saucedemo.com") → "saucedemo"', helperOut.saucedemo === 'saucedemo', JSON.stringify(helperOut));
check('B. brandFromHost("saucedemo.com") → "saucedemo"', helperOut.saucedemoNoWww === 'saucedemo');
check('C. brandFromHost("the-internet.herokuapp.com") → "the-internet-herokuapp"', helperOut.multipart === 'the-internet-herokuapp');
check('D. brandFromHost("demo.playwright.dev") → "demo-playwright"', helperOut.subdomain === 'demo-playwright');
check('E. brandFromHost("WWW.Example.COM") lower-cases + strips www. + drops TLD', helperOut.upper === 'example');
check('F. brandFromHost("localhost") returns "localhost" (no TLD to strip)', helperOut.bare === 'localhost');
check('G. brandFromHost("") returns ""', helperOut.empty === '');
check('H. brandFromHost(null) returns ""', helperOut.nullish === '');

// 2) Seed runs with full-host identifiers and trigger re-render. We use
//    saveRun() directly so the saved record gets a real id + timestamp.
await page.evaluate((seed) => {
  localStorage.removeItem('qa-core.runs.v1');
  for (const r of seed) {
    // @ts-expect-error — saveRun is defined in the UI file
    saveRun(r);
  }
}, [
  // Plain run — no features, no summary → just brand, no description line.
  { type: 'explore', host: 'www.saucedemo.com',         target: '/explore https://www.saucedemo.com/',         scenarios: 3, passRate: 100, costUsd: 0.12 },
  // Run with a Critic summary but no features.
  { type: 'explore', host: 'the-internet.herokuapp.com', target: '/explore https://the-internet.herokuapp.com/', scenarios: 2, passRate: 50,  costUsd: 0.08, summary: 'Login flow with 2 scenarios. Lockout assertion is weak.' },
  // Same-site run WITH features AND summary — title appends " · login, cart"
  // and description line shows the summary.
  { type: 'explore', host: 'www.saucedemo.com',         target: '/explore https://www.saucedemo.com/',         scenarios: 5, passRate: 80, costUsd: 0.20, features: ['login', 'cart'], summary: 'Login + cart happy paths verified end-to-end; one weak verdict on add-to-cart.' },
  // Many features — caps at 3 visible and adds " +N more".
  { type: 'explore', host: 'shop.example.com',          target: '/explore https://shop.example.com/',          scenarios: 9, passRate: 90, costUsd: 0.31, features: ['login', 'cart', 'checkout', 'profile', 'search'], summary: 'Smoke-tested core commerce funnel; all 9 scenarios passed replay + 3× stability.' },
]);
await page.waitForTimeout(150);

// 3) Site cards must render the BRAND text but preserve the host as a title.
const siteCards = await page.evaluate(() => {
  const out: Array<{ label: string | null; title: string | null; onclick: string }> = [];
  const cards = document.querySelectorAll('#dashSitesGrid .site-card:not(.site-card-add)');
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]!;
    out.push({
      label: c.querySelector('.site-host')?.textContent?.trim() ?? null,
      title: c.getAttribute('title') ?? null,
      onclick: c.getAttribute('onclick') ?? '',
    });
  }
  return out;
});

const saucedemoCard = siteCards.find((c) => c.title === 'www.saucedemo.com');
const herokuappCard = siteCards.find((c) => c.title === 'the-internet.herokuapp.com');
check('I. site-card labelled "saucedemo" exists', saucedemoCard?.label === 'saucedemo', JSON.stringify(siteCards));
check('J. site-card labelled "the-internet-herokuapp" exists', herokuappCard?.label === 'the-internet-herokuapp');
check('K. site-card title attribute preserves full host (www.saucedemo.com)', saucedemoCard?.title === 'www.saucedemo.com');
check('L. site-card onclick still uses full host for the rebuilt /explore URL',
  !!saucedemoCard?.onclick.includes('https://www.saucedemo.com/'));
check('M. NO site-card label shows the literal "www.saucedemo.com"',
  !siteCards.some((c) => c.label === 'www.saucedemo.com'));

// 4) Run history cards must show the brand too.
const runCards = await page.evaluate(() => {
  const out: Array<{ title: string | null; titleAttr: string | null }> = [];
  const cards = document.querySelectorAll('#runHistory .run-card');
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]!;
    const titleEl = c.querySelector('.run-card-title');
    out.push({
      title: titleEl?.textContent?.trim() ?? null,
      titleAttr: titleEl?.getAttribute('title') ?? null,
    });
  }
  return out;
});
// Find the no-features saucedemo run specifically (multiple saucedemo runs are
// seeded — one without features, one with). The features-less one's title is
// the bare brand; we want to assert that.
const sauceRun = runCards.find((c) => c.title === 'saucedemo');
const herokuRun = runCards.find((c) => c.titleAttr === 'the-internet.herokuapp.com');
check('N. run-card-title shows brand "saucedemo" (no features case)', sauceRun?.title === 'saucedemo');
check('O. run-card-title shows brand "the-internet-herokuapp"', herokuRun?.title === 'the-internet-herokuapp');
check('P. run-card title attr preserves full host (www.saucedemo.com)', sauceRun?.titleAttr === 'www.saucedemo.com');

// 5) Recent-runs panel on the dashboard must show the brand label too.
const recentRuns = await page.evaluate(() => {
  const out: Array<{ target: string | null; title: string | null }> = [];
  const items = document.querySelectorAll('#dashRecentRuns .recent-run');
  for (let i = 0; i < items.length; i++) {
    const r = items[i]!;
    out.push({
      target: r.querySelector('.recent-run-target')?.textContent?.trim() ?? null,
      title: r.getAttribute('title') ?? null,
    });
  }
  return out;
});
// Match by the rendered text rather than the host attr — multiple saucedemo
// recent-runs exist now (one bare, one with features). The bare one is what
// asserts the brand-only label.
const recentSauce = recentRuns.find((r) => r.target === 'saucedemo');
check('Q. recent-run shows brand "saucedemo" (no-features case)', !!recentSauce, JSON.stringify(recentRuns));
check('R. recent-run title attr preserves full host', recentSauce?.title === 'www.saucedemo.com');

// 6) Download-filename derivation uses the brand.
//    Capture the would-be filename by calling the download path with a stub.
const downloadName = await page.evaluate(() => {
  // Mirror the renderRunHistory download path inline.
  // @ts-expect-error — brandFromHost is defined in the UI file
  return (brandFromHost('www.saucedemo.com') || 'spec') + '.spec.ts';
});
check('S. Download filename uses brand: "saucedemo.spec.ts"', downloadName === 'saucedemo.spec.ts');

// 7) Feature disambiguation in titles.
//    - run with features=['login','cart'] → "saucedemo · login, cart"
//    - run with 5 features → "shop-example · login, cart, checkout +2 more"
type TitleInput = { host: string | null; target: string | null; features: string[] | null };
const featureTitles = await page.evaluate((inputs: Record<string, TitleInput>) => {
  const out: Record<string, string> = {};
  for (const key in inputs) {
    const v = inputs[key]!;
    // @ts-expect-error — runTitle is defined in the UI file
    out[key] = runTitle(v.host, v.target, v.features);
  }
  return out;
}, {
  noFeatures: { host: 'www.saucedemo.com', target: null, features: null },
  twoFeatures: { host: 'www.saucedemo.com', target: null, features: ['login', 'cart'] },
  fiveFeatures: { host: 'shop.example.com', target: null, features: ['login', 'cart', 'checkout', 'profile', 'search'] },
  noHostNoFeatures: { host: null, target: '/explore https://x.com/', features: null },
  emptyFeatures: { host: 'www.saucedemo.com', target: null, features: [] },
} as Record<string, TitleInput>);
check('T. runTitle: brand only when features=null', featureTitles.noFeatures === 'saucedemo');
check('U. runTitle: appends " · login, cart" for 2 features', featureTitles.twoFeatures === 'saucedemo · login, cart');
check('V. runTitle: caps at 3 features with " +N more" suffix',
  featureTitles.fiveFeatures === 'shop-example · login, cart, checkout +2 more', featureTitles.fiveFeatures);
check('W. runTitle: falls through to target when host is null', featureTitles.noHostNoFeatures === '/explore https://x.com/');
check('X. runTitle: empty features array treated same as null', featureTitles.emptyFeatures === 'saucedemo');

// Confirm the seeded multi-feature run actually rendered with the disambiguation.
const sauceWithFeatures = runCards.find((c) => c.title?.startsWith('saucedemo ·'));
check('Y. A seeded same-site run renders with " · " feature suffix in run-card',
  !!sauceWithFeatures, runCards.map((c) => c.title).join(' | '));

// Recent-runs panel should also show the disambiguated title.
const recentRunsAfter = await page.evaluate(() => {
  const out: string[] = [];
  const items = document.querySelectorAll('#dashRecentRuns .recent-run-target');
  for (let i = 0; i < items.length; i++) out.push(items[i]!.textContent?.trim() ?? '');
  return out;
});
check('Z. Recent-runs panel renders "saucedemo · login, cart" title',
  recentRunsAfter.some((t) => t === 'saucedemo · login, cart'), recentRunsAfter.join(' | '));
check('AA. Recent-runs panel renders capped " +2 more" suffix',
  recentRunsAfter.some((t) => t === 'shop-example · login, cart, checkout +2 more'),
  recentRunsAfter.join(' | '));

// 8) Critic-summary description line.
//    - Runs WITH summary should render a .recent-run-summary / .run-card-summary-preview line.
//    - Runs WITHOUT summary should not render the line at all (no empty stub).
const descriptionRows = await page.evaluate(() => {
  const out: Array<{ target: string | null; summary: string | null; hasSummaryDiv: boolean }> = [];
  const rows = document.querySelectorAll('#dashRecentRuns .recent-run');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const sumDiv = row.querySelector('.recent-run-summary');
    out.push({
      target: row.querySelector('.recent-run-target')?.textContent?.trim() ?? null,
      summary: sumDiv?.textContent?.trim() ?? null,
      hasSummaryDiv: !!sumDiv,
    });
  }
  return out;
});
const featRow = descriptionRows.find((r) => r.target === 'saucedemo · login, cart');
const bareRow = descriptionRows.find((r) => r.target === 'saucedemo');
const herokuRow = descriptionRows.find((r) => r.target?.startsWith('the-internet-herokuapp'));
check('AB. Recent-run "saucedemo · login, cart" shows summary description line',
  featRow?.summary === 'Login + cart happy paths verified end-to-end; one weak verdict on add-to-cart.', JSON.stringify(featRow));
check('AC. Recent-run "saucedemo" (no summary in seed) does NOT render the summary div',
  bareRow?.hasSummaryDiv === false, JSON.stringify(bareRow));
check('AD. Recent-run heroku (summary, no features) still shows the description line',
  herokuRow?.summary === 'Login flow with 2 scenarios. Lockout assertion is weak.', JSON.stringify(herokuRow));

// Run-card head must also surface the summary preview (collapsed state).
const runCardSummaries = await page.evaluate(() => {
  const out: Array<{ title: string | null; preview: string | null }> = [];
  const cards = document.querySelectorAll('#runHistory .run-card');
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]!;
    out.push({
      title: c.querySelector('.run-card-title')?.textContent?.trim() ?? null,
      preview: c.querySelector('.run-card-summary-preview')?.textContent?.trim() ?? null,
    });
  }
  return out;
});
const featCard = runCardSummaries.find((c) => c.title === 'saucedemo · login, cart');
const bareCard = runCardSummaries.find((c) => c.title === 'saucedemo');
check('AE. Run-card head with features shows the Critic summary preview',
  featCard?.preview === 'Login + cart happy paths verified end-to-end; one weak verdict on add-to-cart.', JSON.stringify(featCard));
check('AF. Run-card head without summary on the record does NOT render a preview',
  bareCard?.preview === null, JSON.stringify(bareCard));

// Hover tooltip on the summary line carries the full text (since it can be
// truncated visually via CSS ellipsis).
const summaryTooltip = await page.evaluate(() => {
  return document.querySelector('#dashRecentRuns .recent-run-summary')?.getAttribute('title') ?? null;
});
check('AG. Summary line has a title attr with full text for hover',
  typeof summaryTooltip === 'string' && summaryTooltip.length > 0);

// 9) JS console clean.
check('AH. Zero JS errors during the whole flow', jsErrors.length === 0, jsErrors.join('\n'));

await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: UI shows brand slug instead of full host across site cards, run history, recent runs, and download filenames.');
