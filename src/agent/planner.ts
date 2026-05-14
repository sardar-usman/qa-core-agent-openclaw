import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';

/**
 * Planner — Step 1 of the multi-agent pipeline.
 *
 * Cheap pre-pass on Haiku that opens the target URL once, captures the DOM
 * summary, and emits a numbered list of scenarios to cover. The Explorer
 * agent uses this list as a guide instead of deciding what to test on the fly.
 *
 * Why this exists: Opus tool-use loops are expensive. The Planner spends
 * pennies to give Opus a clear plan, which means Opus does less wandering
 * and produces a tighter set of scenarios.
 */

export interface PlannedScenario {
  name: string;
  category: 'happy' | 'negative' | 'edge' | 'a11y';
  rationale: string;
}

export interface PlanResult {
  scenarios: PlannedScenario[];
  pageTitle: string;
  /** Cost of the planning call in USD. */
  costUsd: number;
}

const SYSTEM = `You are the Planner. Your job: look at a single web page and propose a focused list of test scenarios for a Playwright suite.

Constraints:
- Propose 3-6 scenarios total.
- At least one happy path, one negative case, one edge case.
- Each scenario name is past-tense and describes the OUTCOME, not the action (good: "rejects invalid password"; bad: "type wrong password").
- Categories: happy, negative, edge, a11y.
- Skip scenarios you cannot verify from a single page (e.g., end-to-end checkout if only the login page is visible).

Return strictly in this format, nothing else:

<plan>
1. [category] scenario-name — one-line rationale
2. [category] scenario-name — one-line rationale
...
</plan>`;

const PLANNER_PRICE = { in: 1.0, out: 5.0 }; // Haiku 4.5 default

export async function plan(opts: {
  url: string;
  model?: string;
  apiKey?: string;
}): Promise<PlanResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  const model = opts.model ?? process.env.QA_CORE_MODEL_PLANNER ?? 'claude-haiku-4-5';
  const client = new Anthropic({ apiKey });

  // Take one snapshot — title + visible interactive elements.
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    const snapshot = await page.evaluate(() => {
      const pick = (el: Element) => {
        const r = el as HTMLElement;
        return {
          tag: r.tagName.toLowerCase(),
          role: r.getAttribute('role') ?? undefined,
          label: (r.getAttribute('aria-label') ?? r.getAttribute('placeholder') ?? r.getAttribute('name') ?? (r.textContent ?? '').trim().slice(0, 80)) || undefined,
          type: (r as HTMLInputElement).type ?? undefined,
        };
      };
      return {
        title: document.title,
        url: location.href,
        headings: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 8).map(pick),
        inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 25).map(pick),
        buttons: Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 25).map(pick),
      };
    });

    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam],
      messages: [
        {
          role: 'user',
          content: `URL: ${opts.url}\n\nPage snapshot:\n${JSON.stringify(snapshot, null, 2)}\n\nPropose scenarios.`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const scenarios = parsePlan(text);
    const u = response.usage;
    const costUsd = (u.input_tokens * PLANNER_PRICE.in + u.output_tokens * PLANNER_PRICE.out) / 1_000_000;

    return { scenarios, pageTitle: snapshot.title, costUsd };
  } finally {
    await browser.close();
  }
}

function parsePlan(text: string): PlannedScenario[] {
  const m = text.match(/<plan>([\s\S]*?)<\/plan>/i);
  const body = m && m[1] ? m[1] : text;
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+[.)]/.test(l));
  const out: PlannedScenario[] = [];
  for (const raw of lines) {
    // "1. [happy] scenario name — rationale"
    const match = raw.match(/^\d+[.)]\s*\[(happy|negative|edge|a11y)\]\s*(.+?)\s*[—-]+\s*(.+)$/i);
    if (match && match[1] && match[2] && match[3]) {
      out.push({
        name: match[2].trim(),
        category: match[1].toLowerCase() as PlannedScenario['category'],
        rationale: match[3].trim(),
      });
    }
  }
  return out;
}
