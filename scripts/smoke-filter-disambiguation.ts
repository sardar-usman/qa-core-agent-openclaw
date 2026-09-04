/**
 * Locks the filter-based disambiguation in the selector cascade.
 *
 * When a cascade level finds SEVERAL matches and the spec carries a text or
 * label hint, the resolver tries locator.filter({ hasText: hint }) before
 * giving up on that level. A unique filtered match wins at the level, records
 * `filterText` on the result, and:
 *   - replay rebuilds the exact same filtered locator (baseLocator)
 *   - the emitters append .filter({ hasText: ... }) before any .first()
 *
 * Also locks the negatives: no hint means the old ambiguous + .first()
 * behaviour, and a unique match never records a filterText.
 *
 * No network. No LLM. Local fixture page + Playwright primitives.
 */
import { chromium, type Page } from 'playwright';
import { resolve, emitLocatorCall } from '../src/agent/selectors.js';
import { baseLocator } from '../src/agent/replay.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import type { SelectorRecord } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const FIXTURE = `<!doctype html><html><body>
  <div class="card"><h3>Backpack</h3><button data-target="yes">Add to cart</button></div>
  <div class="card"><h3>Bike light</h3><button>Add to wishlist</button></div>
</body></html>`;

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    installEvalShim(ctx);
    const page: Page = await ctx.newPage();
    await page.setContent(FIXTURE, { waitUntil: 'load' });

    // A. Multi-match role level + text hint resolves via filter, uniquely.
    // getByRole('button', { name: 'Add' }) fuzzy-matches BOTH buttons; the
    // 'cart' hint narrows to the one whose text contains it.
    const hit = await resolve(page, { intent: 'add button', role: 'button', label: 'Add', text: 'cart' });
    check('A. multi-match + text hint resolves', hit !== null);
    check('B. resolved without ambiguity (no .first() needed)', hit?.ambiguous === false);
    check('C. filterText records the winning hint', hit?.filterText === 'cart', String(hit?.filterText));
    check('D. still wins at the role level', hit?.level === 'role');
    if (hit) {
      const n = await hit.locator.count();
      const target = n === 1 ? await hit.locator.getAttribute('data-target') : null;
      check('E. filtered locator is unique', n === 1, `count=${n}`);
      check('F. filtered locator points at the RIGHT element', target === 'yes');
    } else {
      check('E. filtered locator is unique', false, 'no resolution');
      check('F. filtered locator points at the RIGHT element', false, 'no resolution');
    }

    // G/H. Round-trip: replay's baseLocator rebuilds the SAME filtered locator
    // from the SelectorRecord that exploration would persist.
    if (hit) {
      const record: SelectorRecord = { level: hit.level, arg: hit.arg, intent: 'add button', ambiguous: hit.ambiguous || undefined, filterText: hit.filterText };
      const rebuilt = baseLocator(page, record);
      const n = await rebuilt.count();
      const target = n === 1 ? await rebuilt.getAttribute('data-target') : null;
      check('G. replay baseLocator rebuilds a unique locator', n === 1, `count=${n}`);
      check('H. replay baseLocator finds the same element', target === 'yes');

      // I/J. The emitted call carries the filter, before any .first().
      const emitted = emitLocatorCall(record.level, record.arg, record.ambiguous === true, record.frameChain, record.filterText);
      check('I. emitted call contains .filter({ hasText: "cart" })', emitted.includes('.filter({ hasText: "cart" })'), emitted);
      check('J. emitted call does not append .first() for a filtered unique match', !emitted.includes('.first()'), emitted);
    } else {
      for (const l of ['G', 'H', 'I', 'J']) check(`${l}. skipped`, false, 'no resolution');
    }

    // K/L. No hint: the same multi-match stays ambiguous and emits .first(),
    // with no filter (the old behaviour is preserved).
    const noHint = await resolve(page, { intent: 'add button', role: 'button', label: 'Add' });
    check('K. no hint still resolves ambiguously', noHint !== null && noHint.ambiguous === true && noHint.filterText === undefined);
    if (noHint) {
      const emitted = emitLocatorCall(noHint.level, noHint.arg, noHint.ambiguous, noHint.frameChain, noHint.filterText);
      check('L. no hint emits .first() and no .filter', emitted.endsWith('.first()') && !emitted.includes('.filter('), emitted);
    } else {
      check('L. no hint emits .first() and no .filter', false, 'no resolution');
    }

    // M. A unique match never records filterText, even when a hint is present.
    const unique = await resolve(page, { intent: 'wishlist button', role: 'button', label: 'Add to wishlist', text: 'wishlist' });
    check('M. unique match records no filterText', unique !== null && unique.filterText === undefined && unique.ambiguous === false);

    // N. Emit order when a record is BOTH filtered and ambiguous: filter first,
    // then .first() (defensive — resolution never produces this pair, but the
    // emitter must keep the order stable for hand-built records).
    const both = emitLocatorCall('css', '.card', true, undefined, 'Backpack');
    check('N. .filter(...) is emitted before .first()', both.endsWith('.filter({ hasText: "Backpack" }).first()'), both);

    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  if (fail > 0) process.exit(1);
  console.log('OK: filter-based disambiguation resolves, round-trips, and emits .filter.');
}

main().catch((err) => {
  console.error('FAIL (crash):', err);
  process.exit(1);
});
