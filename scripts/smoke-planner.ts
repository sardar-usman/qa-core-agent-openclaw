/**
 * Reproduces ONLY the page.evaluate snapshot step that planner.ts performs
 * against saucedemo.com — the call that was failing with `__name is not
 * defined`. No LLM call, no API key needed. If this prints a snapshot, the
 * shim is doing its job in the runtime code path.
 */
import { chromium } from 'playwright';
import { installEvalShim } from '../src/agent/eval-shim.js';

const url = 'https://www.saucedemo.com/';
const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext();
  await installEvalShim(ctx);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load' });

  // Identical body to planner.ts page.evaluate.
  const snapshot = await page.evaluate(() => {
    function pick(el: Element): Record<string, unknown> {
      const r = el as HTMLElement;
      return {
        tag: r.tagName.toLowerCase(),
        role: r.getAttribute('role') ?? undefined,
        label: (r.getAttribute('aria-label') ?? r.getAttribute('placeholder') ?? r.getAttribute('name') ?? (r.textContent ?? '').trim().slice(0, 80)) || undefined,
        type: (r as HTMLInputElement).type ?? undefined,
      };
    }
    return {
      title: document.title,
      url: location.href,
      headings: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 8).map(pick),
      inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 25).map(pick),
      buttons: Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 25).map(pick),
    };
  });
  console.log(JSON.stringify(snapshot, null, 2));
} finally {
  await browser.close();
}
