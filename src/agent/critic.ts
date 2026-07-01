import Anthropic from '@anthropic-ai/sdk';
import type { Scenario, TraceStep } from './trace.js';

/**
 * Critic — Step 3 of the multi-agent pipeline.
 *
 * Reviews the verified trace and produces per-scenario verdicts with structured
 * reasons and required_fixes arrays. Verdicts gate Reality-Check: only 'pass'
 * scenarios proceed to replay; 'rework' and 'reject' are dropped here.
 */

export type Verdict = 'pass' | 'rework' | 'reject';

export interface ScenarioVerdict {
  scenario: string;
  verdict: Verdict;
  reasons: string[];
  required_fixes: string[];
}

export interface CriticResult {
  verdicts: ScenarioVerdict[];
  summary: string;
  costUsd: number;
}

const SYSTEM = `You are the Critic, a senior QA reviewer. You will be shown test scenarios that an exploration agent recorded against a live page. Every scenario executed successfully — the actions worked. Your job is to judge whether the ASSERTIONS would catch a real regression.

For each scenario return one JSON object:

{
  "scenario": "<exact scenario name from the input>",
  "verdict": "pass" | "rework" | "reject",
  "reasons": ["<short reason>"],
  "required_fixes": ["<concrete fix instruction>"]
}

Verdicts:
- "pass"   — assertion is specific, auto-retrying, and would fail when the feature breaks. Ready for Reality-Check.
- "rework" — the scenario tests something real but the assertion, wait strategy, or locator is wrong. List exactly what needs to change in required_fixes so the Explorer can regenerate a correct version.
- "reject" — not worth keeping: redundant, impossible, tests nothing meaningful, or the scenario name does not match what was tested.

Flagging rules — apply to every scenario:

1. Timing: any assertion on an animated or async element (progress bar, countdown timer, loading spinner, toast, live counter) with [no-timeout] is automatically "rework". The required_fix must name the correct tool: wait_for_text (polls until text matches) or assert with timeout set to at least 10000ms.

2. Vacuous or substring: asserting toBeVisible on the element the agent just clicked proves nothing about the outcome. A substring match (toContainText with a single character or a unit-only string like "%") is never acceptable. Flag as "rework".

3. a11y without ARIA: an a11y scenario that only checks visible text or element presence is automatically "rework". It must assert ARIA attributes (role, aria-valuenow, aria-valuemin, aria-valuemax, aria-label, aria-expanded) via toHaveAttribute, or prove keyboard operability produced a meaningful outcome.

4. Missing outcome assertion: a scenario where the key action (submit, navigate, toggle) has no assertion on its outcome is "rework" or "reject".

Return a JSON array with one element per scenario in the same order as the input, then a <summary> paragraph:

[
  { "scenario": "...", "verdict": "pass", "reasons": ["..."], "required_fixes": [] },
  { "scenario": "...", "verdict": "rework", "reasons": ["..."], "required_fixes": ["..."] }
]

<summary>
One short paragraph on overall spec quality.
</summary>`;

const CRITIC_PRICE = { in: 3.0, out: 15.0 }; // Sonnet 4.6

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
    max_tokens: 3000,
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

function describeStep(step: TraceStep): string {
  switch (step.kind) {
    case 'navigate': return `navigate(${step.url})`;
    case 'click':    return `click(${step.target.intent} via ${step.target.level})`;
    case 'fill':     return `fill(${step.target.intent}, ${JSON.stringify(step.value).slice(0, 30)})`;
    case 'press':    return `press(${step.key} on ${step.target.intent})`;
    case 'select_option': return `select_option(${step.target.intent}, ${step.by}=${JSON.stringify(step.option).slice(0, 30)})`;
    case 'set_checked':   return `set_checked(${step.target.intent}, ${step.checked ? 'check' : 'uncheck'})`;
    case 'set_input_files': return `set_input_files(${step.target.intent}, ${step.files.length} file(s))`;
    case 'wait':          return `wait(${step.ms}ms)`;
    case 'stability_wait': return `stability_wait(${step.ms}ms)`;
    case 'checkpoint': return `# ${step.label}`;
    case 'assert': {
      const a = step.assertion;
      switch (a.type) {
        case 'toBeVisible': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} visible${t}`;
        }
        case 'toHaveText': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} has text "${a.text}"${t}`;
        }
        case 'toContainText': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} contains "${a.text}"${t}`;
        }
        case 'toHaveURL':
          return `assert URL matches /${a.pattern}/`;
        case 'toBeHidden': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} hidden/absent${t}`;
        }
        case 'toHaveCount':
          return `assert ${a.target.intent} count=${a.count}`;
        case 'toHaveAttribute': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} ${a.attribute}="${a.value}"${t}`;
        }
        case 'toHaveValue': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} value="${a.value}"${t}`;
        }
      }
    }
    case 'capture': {
      const what = step.source === 'attribute' ? `${step.attribute} of ${step.target.intent}` : step.source === 'count' ? `count of ${step.target.intent}` : `text of ${step.target.intent}`;
      return `capture ${what} -> ${step.varName}`;
    }
    case 'assert_compare': {
      const bounds = step.bounds ? `, strictly within ${step.bounds.min}..${step.bounds.max}` : '';
      return `assert_compare ${step.readVar} ${step.relation} vs captured ${step.varName}${bounds}`;
    }
    case 'wait_for_state':
      return `wait_for_state(${step.target.intent}, ${step.state})`;
  }
}

function parseVerdicts(text: string): ScenarioVerdict[] {
  // Strip markdown code fences if the model wrapped the JSON
  const stripped = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  // Match the outermost JSON array
  const m = stripped.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    const raw = JSON.parse(m[0]) as unknown[];
    return raw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        scenario: String(item['scenario'] ?? ''),
        verdict: (['pass', 'rework', 'reject'].includes(String(item['verdict']))
          ? item['verdict']
          : 'rework') as Verdict,
        reasons: Array.isArray(item['reasons'])
          ? (item['reasons'] as unknown[]).map(String)
          : [String(item['reasons'] ?? '')],
        required_fixes: Array.isArray(item['required_fixes'])
          ? (item['required_fixes'] as unknown[]).map(String)
          : [],
      }));
  } catch {
    return [];
  }
}

function parseSummary(text: string): string {
  const m = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  return m && m[1] ? m[1].trim() : '';
}
