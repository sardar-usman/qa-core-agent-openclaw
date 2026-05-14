import Anthropic from '@anthropic-ai/sdk';
import type { Scenario } from './trace.js';

/**
 * Critic — Step 3 of the multi-agent pipeline.
 *
 * Reviews the verified trace AFTER exploration and produces per-scenario
 * verdicts: ship / fix / weak. The Critic doesn't drive the browser — it just
 * reads the recorded scenarios and flags problems an experienced QA reviewer
 * would notice (weak assertions, missing negative coverage, brittle selectors).
 *
 * The verdicts land in run-report.json and the CLI prints any non-ship results
 * so the user knows what to look at before shipping the spec.
 */

export type Verdict = 'ship' | 'weak' | 'fix';

export interface ScenarioVerdict {
  scenario: string;
  verdict: Verdict;
  reason: string;
}

export interface CriticResult {
  verdicts: ScenarioVerdict[];
  summary: string;
  costUsd: number;
}

const SYSTEM = `You are the Critic, a senior QA reviewer. You will be shown a list of test scenarios that an exploration agent recorded against a live page. Every scenario has actually executed — the actions worked, but you must judge whether the ASSERTIONS would catch a real bug.

For each scenario, return one verdict:
- ship  → the scenario tests something meaningful and the assertion is specific enough to fail when broken
- weak  → the scenario runs but the assertion is too loose (e.g. asserts page is visible but not that the right outcome happened)
- fix   → the assertion is wrong, missing, or tests something orthogonal to the scenario name

Return strictly in this format:

<review>
1. <verdict>ship|weak|fix</verdict> scenario-name — one-line reason
2. <verdict>ship|weak|fix</verdict> scenario-name — one-line reason
...
</review>

<summary>
one short paragraph summarising the overall quality of the spec
</summary>`;

const CRITIC_PRICE = { in: 3.0, out: 15.0 }; // Sonnet 4.6 default

export async function critique(opts: {
  scenarios: Scenario[];
  url: string;
  model?: string;
  apiKey?: string;
}): Promise<CriticResult> {
  if (opts.scenarios.length === 0) {
    return { verdicts: [], summary: 'No scenarios recorded — nothing to review.', costUsd: 0 };
  }

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  const model = opts.model ?? process.env.QA_CORE_MODEL_CRITIC ?? 'claude-sonnet-4-6';
  const client = new Anthropic({ apiKey });

  const traceSummary = opts.scenarios.map((s, i) => {
    const steps = s.steps.map((step) => describeStep(step)).join('\n      ');
    return `${i + 1}. [${s.category}] ${s.name}\n      ${steps}`;
  }).join('\n\n');

  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam],
    messages: [
      {
        role: 'user',
        content: `URL: ${opts.url}\n\nRecorded scenarios:\n\n${traceSummary}\n\nReview.`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const u = response.usage;
  const costUsd = (u.input_tokens * CRITIC_PRICE.in + u.output_tokens * CRITIC_PRICE.out) / 1_000_000;

  return { verdicts: parseVerdicts(text), summary: parseSummary(text), costUsd };
}

function describeStep(step: import('./trace.js').TraceStep): string {
  switch (step.kind) {
    case 'navigate': return `navigate(${step.url})`;
    case 'click':    return `click(${step.target.intent} via ${step.target.level})`;
    case 'fill':     return `fill(${step.target.intent}, ${JSON.stringify(step.value).slice(0, 30)})`;
    case 'press':    return `press(${step.key} on ${step.target.intent})`;
    case 'wait':     return `wait(${step.ms}ms)`;
    case 'checkpoint': return `# ${step.label}`;
    case 'assert': {
      const a = step.assertion;
      switch (a.type) {
        case 'toBeVisible':   return `assert ${a.target.intent} visible`;
        case 'toHaveText':    return `assert ${a.target.intent} has text "${a.text}"`;
        case 'toContainText': return `assert ${a.target.intent} contains "${a.text}"`;
        case 'toHaveURL':     return `assert URL matches /${a.pattern}/`;
        case 'toHaveCount':   return `assert ${a.target.intent} count=${a.count}`;
      }
    }
  }
}

function parseVerdicts(text: string): ScenarioVerdict[] {
  const m = text.match(/<review>([\s\S]*?)<\/review>/i);
  const body = m && m[1] ? m[1] : text;
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+[.)]/.test(l));
  const out: ScenarioVerdict[] = [];
  for (const raw of lines) {
    // "1. <verdict>ship</verdict> scenario-name — reason"
    const match = raw.match(/^\d+[.)]\s*<verdict>(ship|weak|fix)<\/verdict>\s*(.+?)\s*[—-]+\s*(.+)$/i);
    if (match && match[1] && match[2] && match[3]) {
      out.push({
        verdict: match[1].toLowerCase() as Verdict,
        scenario: match[2].trim(),
        reason: match[3].trim(),
      });
    }
  }
  return out;
}

function parseSummary(text: string): string {
  const m = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  return m && m[1] ? m[1].trim() : '';
}
