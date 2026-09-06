/**
 * Locks css attribute-prefix selector resolution (src/agent/selectors.ts).
 *
 * Live-run finding: `a[data-testid^=\\"product-\\"]` (a doubly-escaped model
 * artifact) failed to resolve while plain testid hints worked, because
 * normalizeCssQuotes stripped only ONE escape layer, the leftover backslash
 * made the selector unparseable, and the resolver counts a parse error as 0
 * matches — a silent skip. normalizeCssQuotes now unescapes to a fixpoint and
 * maps smart quotes to ASCII, so every sane spelling of a prefix selector
 * resolves:
 *   - clean double/single/unquoted values, unique -> level css, not ambiguous
 *   - once- and twice-over-escaped quotes normalize and resolve
 *   - smart quotes normalize and resolve
 *   - a multi-match prefix selector resolves ambiguous (.first()), never null
 *
 * Uses a real headless browser on an inline fixture (same pattern as
 * smoke-cascade-coverage). No network beyond the local page. No LLM.
 */
import { chromium } from 'playwright';
import { resolve, normalizeCssQuotes } from '../src/agent/selectors.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── A. normalizeCssQuotes (pure) ─────────────────────────────────────────── */
const CLEAN = 'a[data-testid^="product-"]';
check('A1. a clean selector is untouched', normalizeCssQuotes(CLEAN) === CLEAN);
check('A2. one escape layer strips', normalizeCssQuotes('a[data-testid^=\\"product-\\"]') === CLEAN);
check('A3. two escape layers strip to a fixpoint (the live-run artifact)',
  normalizeCssQuotes(String.raw`a[data-testid^=\\"product-\\"]`) === CLEAN,
  JSON.stringify(normalizeCssQuotes(String.raw`a[data-testid^=\\"product-\\"]`)));
check('A4. smart double quotes map to ASCII', normalizeCssQuotes('a[data-testid^=“product-”]') === CLEAN);
check('A5. smart single quotes map to ASCII', normalizeCssQuotes("[title=‘hi’]") === "[title='hi']");
check('A6. single-quote escapes strip too', normalizeCssQuotes("a[data-testid^=\\'product-\\']") === "a[data-testid^='product-']");

/* ─── B. resolution through the real cascade ───────────────────────────────── */
const single = `
<html><body>
  <a data-testid="product-1" href="/p1">Alpha Widget</a>
  <div data-testid="other">noise</div>
</body></html>`;
const multi = `
<html><body>
  <a data-testid="product-1" href="/p1">Alpha Widget</a>
  <a data-testid="product-2" href="/p2">Beta Widget</a>
</body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext();
  await installEvalShim(ctx);
  const page = await ctx.newPage();

  // Intent chosen to match nothing at any earlier cascade level, so only the
  // css hint can resolve — the same isolation the live failure had.
  const INTENT = 'zzqx unmatched intent';
  const uniqueVariants: Array<[string, string]> = [
    ['clean double quotes', CLEAN],
    ['over-escaped once', 'a[data-testid^=\\"product-\\"]'],
    ['over-escaped twice', String.raw`a[data-testid^=\\"product-\\"]`],
    ['single quotes', "a[data-testid^='product-']"],
    ['unquoted value', 'a[data-testid^=product-]'],
    ['smart quotes', 'a[data-testid^=“product-”]'],
  ];
  let i = 0;
  for (const [label, css] of uniqueVariants) {
    i++;
    await page.setContent(single);
    const r = await resolve(page, { intent: INTENT, css });
    check(`B${i}. ${label} resolves uniquely at the css level`,
      r !== null && r.level === 'css' && r.ambiguous === false,
      r ? `${r.level}/${r.ambiguous}` : 'null');
  }

  await page.setContent(multi);
  const m = await resolve(page, { intent: INTENT, css: CLEAN });
  check('B7. a multi-match prefix selector resolves ambiguous (.first()), never null',
    m !== null && m.level === 'css' && m.ambiguous === true, m ? `${m.level}/${m.ambiguous}` : 'null');
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: css prefix selectors resolve in every sane spelling; over-escaped and smart quotes normalize to a fixpoint instead of failing silently.');
