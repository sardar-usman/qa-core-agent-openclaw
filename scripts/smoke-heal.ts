/**
 * Locks automatic selector healing during Explorer execution (tools.ts).
 *
 * Healing is scoped STRICTLY to locators, never to assertions:
 *
 *   1. A selector that FAILS TO RESOLVE (element cannot be found) is
 *      automatically re-resolved against the live page by the locator ladder. If
 *      the element is found a different stable way, the locator is updated, a
 *      distinct heal event is recorded (ctx.heals), and the run continues. This
 *      is safe because an unresolvable selector is always a locator problem.
 *
 *   2. An ASSERTION that fails (element found, value/state wrong) is NEVER
 *      healed — that may be a real regression. It keeps the existing behavior:
 *      bounded retry, then a finding. No heal is recorded.
 *
 *   3. Every heal is a distinct, visible record (ctx.heals → a 'heal' event in
 *      the run output) naming what was healed and what it re-resolved to.
 *
 *   4. Heal attempts per selector are capped (HEAL_CAP = 2). A selector that
 *      cannot be re-resolved after the cap is recorded as a finding, not a
 *      silent pass.
 *
 * Uses a headless page with setContent, no live site, no network.
 */
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const browser = await chromium.launch();
const context = await browser.newContext();
await installEvalShim(context);
const page = await context.newPage();

/* ─── 1. an unresolvable selector triggers a heal and re-resolves ──────────────
 *   The element is a plain div identifiable only by its visible text. The model
 *   passes a WRONG label hint, which suppresses the ladder's intent-as-text
 *   fallback (that path is gated off whenever a label hint is present), so the
 *   normal resolve returns null. Healing drops the bad hint, re-resolves by
 *   intent alone, and finds the element by its text — a different stable
 *   locator. The action then succeeds and the heal is logged. */
{
  const ctx = createContext(page, 80);
  await page.setContent(
    `<!doctype html><html><body><div id="banner">Special Offer Today</div></body></html>`,
    { waitUntil: 'load' },
  );
  await runTool(ctx, { name: 'begin_scenario', input: { name: 'clicked the offer banner', category: 'happy', feature: 'home' } });
  const res = await runTool(ctx, { name: 'click', input: { intent: 'Special Offer Today', label: 'promo-banner' } });

  check('1A. the click succeeds after healing (element found a different way)', res.ok === true, JSON.stringify(res));
  check('1B. exactly one heal was recorded', ctx.heals.length === 1, `heals=${JSON.stringify(ctx.heals)}`);
  const h = ctx.heals[0];
  check('1C. the heal names what the model asked for (the failing label hint)', !!h && h.from === 'label=promo-banner', h?.from);
  check('1D. the heal names what it re-resolved to (a stable text locator)', !!h && h.to === 'text=Special Offer Today', h?.to);
  check('1E. the heal carries the intent for the run log', !!h && h.intent === 'Special Offer Today', h?.intent);
  // The recorded click step must use the HEALED locator (text), not the failed label.
  const step = ctx.current!.steps.find((s) => s.kind === 'click');
  const lvl = step && step.kind === 'click' ? step.target.level : undefined;
  check('1F. the recorded step uses the healed locator (text level)', lvl === 'text', String(lvl));
  check('1G. no finding was recorded (a heal is a recovery, not a failure)', ctx.findings.length === 0);
}

/* ─── 2. a resolvable selector does NOT heal (healing fires only on failure) ─── */
{
  const ctx = createContext(page, 80);
  await page.setContent(
    `<!doctype html><html><body><button id="go">Continue</button></body></html>`,
    { waitUntil: 'load' },
  );
  await runTool(ctx, { name: 'begin_scenario', input: { name: 'clicked continue', category: 'happy', feature: 'home' } });
  const res = await runTool(ctx, { name: 'click', input: { intent: 'Continue button', css: '#go' } });
  check('2A. the click succeeds normally', res.ok === true, JSON.stringify(res));
  check('2B. no heal is recorded when the selector resolves first try', ctx.heals.length === 0, JSON.stringify(ctx.heals));
}

/* ─── 3. a FAILED ASSERTION does not trigger a heal and becomes a finding ──────
 *   toHaveURL asserts the page URL directly — it never resolves a locator, so
 *   the healing path is structurally impossible to reach. The assertion fails
 *   twice (OUTCOME_RETRY_CAP), which records a finding. No heal is ever logged:
 *   a wrong assertion may be a real regression, so it is never healed. */
{
  const ctx = createContext(page, 80);
  await page.setContent(`<!doctype html><html><body><h1>Dashboard</h1></body></html>`, { waitUntil: 'load' });
  await runTool(ctx, { name: 'begin_scenario', input: { name: 'expected a redirect that never happened', category: 'happy', feature: 'auth' } });
  const f1 = await runTool(ctx, { name: 'assert', input: { type: 'toHaveURL', pattern: '/logged-in', timeout: 500 } });
  check('3A. first assertion failure is an honest retry, not a finding', f1.ok === false && (f1.data as { finding?: boolean } | undefined)?.finding !== true, JSON.stringify(f1));
  const f2 = await runTool(ctx, { name: 'assert', input: { type: 'toHaveURL', pattern: '/logged-in', timeout: 500 } });
  check('3B. second failure of the SAME assertion trips the cap → a finding', (f2.data as { finding?: boolean } | undefined)?.finding === true, JSON.stringify(f2));
  check('3C. a finding was recorded', ctx.findings.length === 1, JSON.stringify(ctx.findings));
  check('3D. NO heal was ever recorded for the failed assertion', ctx.heals.length === 0, JSON.stringify(ctx.heals));
  check('3E. the finding describes the assertion (expected URL), not a locator heal',
    ctx.findings.length === 1 && /logged-in/.test(ctx.findings[0]!.expected), JSON.stringify(ctx.findings[0]));
}

/* ─── 4. a selector that cannot be healed becomes a finding after the cap ──────
 *   The element genuinely is not on the page and has no semantic identity, so
 *   both the normal resolve AND the heal re-resolution fail. The first failure
 *   is an honest retry (heal budget left). The second failure of the SAME
 *   selector reaches HEAL_CAP and records a finding — not a silent pass — and
 *   blocks further actions. No heal is logged, because nothing was recovered. */
{
  const ctx = createContext(page, 80);
  await page.setContent(`<!doctype html><html><body><div>nothing useful here</div></body></html>`, { waitUntil: 'load' });
  await runTool(ctx, { name: 'begin_scenario', input: { name: 'tried to click a widget that is gone', category: 'happy', feature: 'home' } });
  const g1 = await runTool(ctx, { name: 'click', input: { intent: 'Missing Widget QZX', css: '#ghost' } });
  check('4A. first unresolvable attempt fails without a finding (heal budget left)', g1.ok === false && ctx.findings.length === 0, JSON.stringify(g1));
  check('4B. no heal logged when nothing could be re-resolved', ctx.heals.length === 0, JSON.stringify(ctx.heals));
  const g2 = await runTool(ctx, { name: 'click', input: { intent: 'Missing Widget QZX', css: '#ghost' } });
  check('4C. second failure of the SAME selector reaches the cap → a finding', ctx.findings.length === 1, JSON.stringify(ctx.findings));
  check('4D. the finding is a locate failure, not a silent pass', g2.ok === false && ctx.findings.length === 1 && /locate element/.test(ctx.findings[0]!.expected), JSON.stringify(ctx.findings[0]));
  check('4E. the half-built scenario was dropped and further actions are blocked',
    ctx.current === null && ctx._blockUntilNewScenario === true);
  check('4F. still no heal recorded (a cap-exhausted selector is a finding, not a heal)', ctx.heals.length === 0);
}

await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: selectors that fail to resolve are automatically healed (logged, capped, and a finding on exhaustion); assertions are never healed.');
