import Anthropic from '@anthropic-ai/sdk';

/**
 * /generate — user story → Playwright spec source.
 *
 * Unlike /explore (which drives a real browser), this is a single LLM call:
 * we ask the model to derive scenarios from the story and emit the spec body
 * in one shot. The output is UNVERIFIED — clearly marked in the file header
 * so the user knows to run it before trusting it.
 */

export interface GenerateOptions {
  story: string;
  language: 'ts' | 'js';
  baseUrl?: string;
  model?: string;
}

export interface GenerateResult {
  feature: string;
  scenarios: number;
  spec: string;
}

const SYSTEM_PROMPT = `You are QA-Core. Convert a user story into a runnable Playwright spec file.

Rules:
- Derive at least one happy path, at least one negative case, and at least one edge case.
- Use selector cascade preference: getByRole > getByLabel > getByTestId > CSS.
- Add one a11y test that uses @axe-core/playwright and asserts no WCAG 2 AA violations.
- Tests must be self-contained. If state is needed, set it up in beforeEach.
- Add a comment header marking the file as UNVERIFIED — generated from a story without browser execution.

Return strictly in this format:
<feature>short kebab-case feature name (used as filename)</feature>
<scenarios>number of scenarios you wrote</scenarios>
<spec>
... entire spec file body, runnable as-is ...
</spec>

Nothing outside these tags.`;

export async function generateFromStory(opts: GenerateOptions): Promise<GenerateResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');

  const model = opts.model ?? process.env.QA_CORE_MODEL_TRANSCRIBE ?? 'claude-sonnet-4-6';
  const client = new Anthropic({ apiKey });

  const langNote = opts.language === 'js'
    ? `Emit JavaScript using CommonJS: const { test, expect } = require('@playwright/test'); const AxeBuilder = require('@axe-core/playwright').default;`
    : `Emit TypeScript: import { test, expect } from '@playwright/test'; import AxeBuilder from '@axe-core/playwright';`;
  const baseHint = opts.baseUrl ? `Base URL is ${opts.baseUrl}.` : 'No base URL given — write tests against a relative path.';

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    // SDK 0.32 typedefs predate cache_control on TextBlockParam; cast to bypass.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam],
    messages: [
      { role: 'user', content: `${langNote}\n${baseHint}\n\nUser story:\n\n${opts.story}` },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const feature = extract(text, 'feature') ?? 'feature';
  const scenarios = Number(extract(text, 'scenarios') ?? '0') || 0;
  const spec = extract(text, 'spec');
  if (!spec) throw new Error('Model did not return a <spec> block. Raw output:\n' + text.slice(0, 600));
  return { feature: feature.trim(), scenarios, spec: spec.trim() };
}

function extract(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const m = text.match(re);
  return m && m[1] ? m[1] : null;
}
