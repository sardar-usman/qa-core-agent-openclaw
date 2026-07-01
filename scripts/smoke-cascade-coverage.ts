/**
 * Coverage matrix for the selector cascade.
 *
 * The agent emits intents in many shapes ("password input", "Sign in",
 * "Email Address", icon-only buttons, etc.). The cascade must resolve
 * EVERY common form-field pattern to SOMETHING unique — that's the
 * contract behind "Could not resolve element" not happening on real sites.
 *
 * Each case below mirrors a pattern we've actually seen in the wild
 * (saucedemo, practicesoftwaretesting, the-internet/herokuapp, demo
 * playwright, generic React forms with Tailwind/MUI).
 *
 * For each case we assert TWO things:
 *   1. The cascade resolves the intent (no null return).
 *   2. The resolved locator matches the EXPECTED element (uniqueness check).
 *      We tag the expected element with `data-target="yes"` in the fixture
 *      so we can verify the resolver picked the right one.
 *
 * If a case fails at baseline, that's a real gap — patch the cascade
 * (tightly, without risking wrong matches) and re-run.
 *
 * No network. No LLM. Pure cascade + Playwright primitives.
 */
import { chromium, type Page } from 'playwright';
import { resolve } from '../src/agent/selectors.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

interface Case {
  name: string;
  html: string;
  /** What the agent might pass. The cascade must resolve to the [data-target="yes"] element. */
  spec: { intent: string; role?: string; label?: string; testid?: string; css?: string };
  /** Optional override — for cases where exact resolution isn't required, just non-null. */
  acceptNullCheckOnly?: boolean;
}

// Shared body wrapper.
const wrap = (inner: string): string => `<!doctype html><html><body><form>${inner}</form></body></html>`;

const cases: Case[] = [
  // ─── 1. Inputs with a real <label> ────────────────────────────────────
  {
    name: '01 text input with <label>',
    html: wrap('<label for="u">Username</label><input id="u" data-target="yes">'),
    spec: { intent: 'username' },
  },
  {
    name: '02 text input with <label>, multi-word intent',
    html: wrap('<label for="u">Username</label><input id="u" data-target="yes">'),
    spec: { intent: 'username input' },
  },
  {
    name: '03 text input wrapped in label',
    html: wrap('<label>Email<input data-target="yes" type="email"></label>'),
    spec: { intent: 'email' },
  },

  // ─── 2. Placeholder-only (no label) ──────────────────────────────────
  {
    name: '04 placeholder-only password (saucedemo pattern)',
    html: wrap('<input type="password" placeholder="Password" data-target="yes">'),
    spec: { intent: 'password input' },
  },
  {
    name: '05 placeholder-only text (search bar)',
    html: wrap('<input type="text" placeholder="Search products..." data-target="yes">'),
    spec: { intent: 'search' },
  },
  {
    name: '06 placeholder mentions "Email" but label says "Username"',
    html: wrap(
      '<label for="user">Username</label><input id="user" placeholder="Username or Email">' +
      '<input type="email" placeholder="Personal Email Address" data-target="yes">',
    ),
    spec: { intent: 'personal email address' },
  },

  // ─── 3. aria-label only ──────────────────────────────────────────────
  {
    name: '07 aria-label only on icon button',
    html: wrap('<button aria-label="Close dialog" data-target="yes"><svg></svg></button>'),
    spec: { intent: 'close button' },
  },
  {
    name: '08 aria-label on input',
    html: wrap('<input type="text" aria-label="Promo Code" data-target="yes">'),
    spec: { intent: 'promo code' },
  },

  // ─── 4. Type-only differentiation ────────────────────────────────────
  {
    name: '09 type=password with no other instrumentation',
    html: wrap(
      '<input type="text" name="username">' +
      '<input type="password" data-target="yes">',
    ),
    spec: { intent: 'password' },
  },
  {
    name: '10 type=email with name attribute',
    html: wrap(
      '<input type="text" name="username">' +
      '<input type="email" name="email" data-target="yes">',
    ),
    spec: { intent: 'email address' },
  },
  {
    name: '11 type=tel',
    html: wrap('<input type="tel" name="phone" placeholder="Phone Number" data-target="yes">'),
    spec: { intent: 'phone number' },
  },
  {
    name: '12 type=search',
    html: wrap('<input type="search" name="q" data-target="yes">'),
    spec: { intent: 'search' },
  },

  // ─── 5. Buttons ─────────────────────────────────────────────────────
  {
    name: '13 submit button with text "Login"',
    html: wrap('<button type="submit" data-target="yes">Login</button>'),
    spec: { intent: 'login button' },
  },
  {
    name: '14 submit button with text "Sign In"',
    html: wrap('<button type="submit" data-target="yes">Sign In</button>'),
    spec: { intent: 'sign in' },
  },
  {
    name: '15 submit input[type="submit"] with value',
    html: wrap('<input type="submit" value="Submit" data-target="yes">'),
    spec: { intent: 'submit button' },
  },
  {
    name: '16 button with only an icon and aria-label',
    html: wrap('<button aria-label="Add to cart" data-target="yes"><svg></svg></button>'),
    spec: { intent: 'add to cart' },
  },

  // ─── 6. data-test (not data-testid) ─────────────────────────────────
  {
    name: '17 saucedemo-style: data-test attribute',
    html: wrap('<input data-test="login-button" type="submit" value="LOGIN" data-target="yes">'),
    spec: { intent: 'login', testid: 'login-button' },
  },

  // ─── 7. Multi-word, generic suffix ──────────────────────────────────
  {
    name: '18 "first name" with generic suffix',
    html: wrap('<label for="fn">First Name</label><input id="fn" data-target="yes">'),
    spec: { intent: 'first name field' },
  },
  {
    name: '19 "confirm password"',
    html: wrap(
      '<label for="pw1">Password</label><input id="pw1" type="password">' +
      '<label for="pw2">Confirm Password</label><input id="pw2" type="password" data-target="yes">',
    ),
    spec: { intent: 'confirm password' },
  },

  // ─── 8. Links ───────────────────────────────────────────────────────
  {
    name: '20 link by visible text',
    html: wrap('<a href="/forgot" data-target="yes">Forgot password?</a>'),
    spec: { intent: 'forgot password' },
  },

  // ─── 9. Checkboxes and radios ───────────────────────────────────────
  {
    name: '21 checkbox with adjacent label',
    html: wrap('<label><input type="checkbox" data-target="yes"> Remember me</label>'),
    spec: { intent: 'remember me' },
  },
  {
    name: '22 radio with label',
    html: wrap(
      '<label><input type="radio" name="plan" value="basic"> Basic</label>' +
      '<label><input type="radio" name="plan" value="pro" data-target="yes"> Pro</label>',
    ),
    spec: { intent: 'pro' },
  },

  // ─── 10. textarea + select ──────────────────────────────────────────
  {
    name: '23 textarea with placeholder',
    html: wrap('<textarea placeholder="Tell us more" data-target="yes"></textarea>'),
    spec: { intent: 'tell us more' },
  },
  {
    name: '24 select with label',
    html: wrap('<label for="c">Country</label><select id="c" data-target="yes"><option>US</option></select>'),
    spec: { intent: 'country' },
  },
];

let pass = 0;
let fail = 0;
const failures: string[] = [];

async function runCase(c: Case): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    await installEvalShim(ctx);
    const page: Page = await ctx.newPage();
    await page.setContent(c.html, { waitUntil: 'load' });

    const resolved = await resolve(page, c.spec);
    if (!resolved) {
      fail++;
      failures.push(c.name);
      console.log(`FAIL ${c.name} — cascade returned null (Could not resolve)`);
      return;
    }
    if (c.acceptNullCheckOnly) { pass++; console.log(`OK   ${c.name} (resolved at "${resolved.level}")`); return; }

    // Verify it picked the [data-target="yes"] element.
    const targetCount = await page.locator('[data-target="yes"]').count();
    if (targetCount !== 1) {
      fail++;
      failures.push(c.name);
      console.log(`FAIL ${c.name} — fixture has ${targetCount} [data-target="yes"] elements (must be exactly 1)`);
      return;
    }
    const resolvedHandle = await resolved.locator.first().elementHandle();
    const targetHandle = await page.locator('[data-target="yes"]').elementHandle();
    if (!resolvedHandle || !targetHandle) {
      fail++;
      failures.push(c.name);
      console.log(`FAIL ${c.name} — couldn't get element handles`);
      return;
    }
    const sameElement = await page.evaluate(([a, b]) => a === b, [resolvedHandle, targetHandle]);
    if (!sameElement) {
      fail++;
      failures.push(c.name);
      const resolvedTag = await resolvedHandle.evaluate((el) => (el as Element).outerHTML.slice(0, 120));
      console.log(`FAIL ${c.name} — resolved WRONG element at "${resolved.level}": ${resolvedTag}`);
      return;
    }
    pass++;
    console.log(`OK   ${c.name} (resolved at "${resolved.level}"${resolved.ambiguous ? ', AMBIGUOUS' : ''})`);
  } finally {
    await browser.close();
  }
}

for (const c of cases) {
  await runCase(c);
}

console.log(`\n${pass}/${pass + fail} patterns resolved correctly.`);
if (fail > 0) {
  console.log(`\nFailing patterns:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('OK: every common form-field pattern resolves to the right element.');
