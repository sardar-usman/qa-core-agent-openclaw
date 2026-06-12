/**
 * Capture what the Planner LLM ACTUALLY returns for saucedemo, before any
 * regex parsing. If the agent is getting "0 scenarios planned" it's almost
 * certainly because the model's format does not match parsePlan's regex.
 *
 * Costs ~$0.001 to run.
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { installEvalShim } from '../src/agent/eval-shim.js';

const SYSTEM = `You are the Planner. Your job: look at a single web page and propose a focused list of test scenarios for a Playwright suite.

Constraints:
- Propose 3-6 scenarios total.
- At least one happy path, one negative case, one edge case.
- Each scenario name is past-tense and describes the OUTCOME, not the action (good: "rejects invalid password"; bad: "type wrong password").
- Categories: happy, negative, edge, a11y.
- Skip scenarios you cannot verify from a single page (e.g., end-to-end checkout if only the login page is visible).

a11y category guidance — only propose an a11y scenario when one of these is verifiable from the page:
- A keyboard-only flow: Tab through the form, Enter / Space to activate, assert the resulting state. Name it like "completed login using keyboard only".
- Semantic structure: critical content uses a proper role (main, alert, navigation) or accessible name. Name it like "error message is announced via role=alert".
- DO NOT propose an a11y scenario that is merely "page renders" or "heading is visible" — those are happy-path, not accessibility.

Return strictly in this format, nothing else:

<plan>
1. [category] scenario-name — one-line rationale
2. [category] scenario-name — one-line rationale
...
</plan>`;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
const client = new Anthropic({ apiKey });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await installEvalShim(ctx);
const page = await ctx.newPage();
await page.goto('https://www.saucedemo.com/', { waitUntil: 'load' });

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

await browser.close();

console.log('=== SNAPSHOT SENT TO HAIKU ===');
console.log(JSON.stringify(snapshot, null, 2));

const response = await client.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 2000,
  system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam],
  messages: [
    {
      role: 'user',
      content: `URL: https://www.saucedemo.com/\n\nPage snapshot:\n${JSON.stringify(snapshot, null, 2)}\n\nPropose scenarios.`,
    },
  ],
});

const text = response.content
  .filter((b): b is Anthropic.TextBlock => b.type === 'text')
  .map((b) => b.text)
  .join('\n');

console.log('\n=== RAW HAIKU RESPONSE ===');
console.log(text);
console.log('\n=== END RAW RESPONSE ===');

// Now apply the parser and see what it extracts.
const m = text.match(/<plan>([\s\S]*?)<\/plan>/i);
const body = m && m[1] ? m[1] : text;
console.log('\n=== BODY AFTER <plan> EXTRACTION ===');
console.log(body);

const lines = body.split('\n').map((l) => l.trim()).filter((l) => /^\d+[.)]/.test(l));
console.log('\n=== LINES MATCHING /^\\d+[.)]/ ===');
console.log(JSON.stringify(lines, null, 2));

const regex = /^\d+[.)]\s*\[(happy|negative|edge|a11y)\]\s*(.+?)\s*[—-]+\s*(.+)$/i;
console.log('\n=== PER-LINE PARSER RESULT ===');
for (const line of lines) {
  const match = line.match(regex);
  console.log({ line, matched: !!match, captures: match ? [match[1], match[2], match[3]] : null });
}
