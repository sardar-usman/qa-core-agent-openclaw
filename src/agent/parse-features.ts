import Anthropic from '@anthropic-ai/sdk';

/**
 * Feature-list parser.
 *
 * `/explore` accepts feature names in three forms:
 *   1. As a comma-separated value on the --features flag:
 *        --features login,cart,checkout
 *   2. As natural language embedded in the prompt:
 *        "/explore https://shop.com test login and cart and checkout"
 *   3. Not at all — the Planner then infers 2–3 highest-signal flows
 *      from a homepage snapshot.
 *
 * This module produces a single normalized `string[]` regardless of the
 * input form. The comma path is deterministic and free. The natural-language
 * path uses Haiku (~$0.001) to extract structured names.
 */

const MAX_FEATURES = 8;
const HAIKU_MODEL = 'claude-haiku-4-5';

// Haiku pricing per million tokens.
const PRICE = { in: 1.0, out: 5.0 };

export interface ParseFeaturesOptions {
  /** Value from a --features flag, e.g. "login,cart,checkout". */
  flagInput?: string;
  /** Free-form natural-language input, e.g. "test login and cart". */
  naturalInput?: string;
  /** Required if `naturalInput` is set and we need an LLM call. */
  apiKey?: string;
  /** Override the natural-language parser model. */
  model?: string;
}

export interface ParseFeaturesResult {
  features: string[];
  /** Which path was taken. `none` means no input or both inputs empty. */
  method: 'none' | 'comma' | 'natural';
  /** USD cost of the LLM call, only present for `natural` method. */
  costUsd?: number;
}

/**
 * Normalize a single feature label: trim, lowercase, replace internal
 * whitespace with hyphens. Strip surrounding quotes the user might paste.
 * Keep internal hyphens as-is so "user-profile" survives.
 */
function normalize(name: string): string {
  return name
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** Dedupe + cap, preserving first occurrence order. */
function tidy(features: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const n = normalize(f);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_FEATURES) break;
  }
  return out;
}

/**
 * Comma-separated parsing. Deterministic, no LLM.
 * "login, cart , , checkout" → ["login", "cart", "checkout"]
 */
export function parseCommaSeparated(input: string): string[] {
  if (!input) return [];
  return tidy(input.split(','));
}

const SYSTEM = `You extract a list of feature names from a free-form sentence about what a tester wants to automate. Output ONLY a JSON array of short, lowercase, kebab-case feature names. No prose. No code fence. No keys.

Examples:

Input: "test login and cart and checkout"
Output: ["login","cart","checkout"]

Input: "I want tests for the search feature, the product listing page, and the wishlist button"
Output: ["search","product-listing","wishlist"]

Input: "automate login, registration, and the forgot-password flow"
Output: ["login","registration","forgot-password"]

Input: "just explore the site"
Output: []

Input: "test stuff"
Output: []

Rules:
- 0-${MAX_FEATURES} entries.
- Each entry is a short lowercase noun phrase joined by hyphens. No verbs.
- If the input doesn't actually mention specific features, return [].
- Output strictly JSON parseable as string[].`;

/**
 * Natural-language parsing via Haiku. Throws if the model returns invalid
 * JSON; caller should fall back to an empty list with a warning.
 */
export async function parseNaturalLanguage(
  input: string,
  apiKey: string,
  model: string = HAIKU_MODEL,
): Promise<{ features: string[]; costUsd: number }> {
  if (!input.trim()) return { features: [], costUsd: 0 };
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 256,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam],
    messages: [{ role: 'user', content: input }],
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  // Find the first JSON array in the response. Be tolerant — Haiku
  // occasionally adds prose despite the instruction.
  const match = text.match(/\[[\s\S]*?\]/);
  let raw: unknown;
  try {
    raw = JSON.parse(match ? match[0] : text);
  } catch {
    return { features: [], costUsd: 0 };
  }
  if (!Array.isArray(raw)) return { features: [], costUsd: 0 };
  const cleaned = tidy(raw.filter((x): x is string => typeof x === 'string'));
  const u = response.usage;
  const costUsd = (u.input_tokens * PRICE.in + u.output_tokens * PRICE.out) / 1_000_000;
  return { features: cleaned, costUsd };
}

/**
 * Unified entry point. Order of precedence:
 *   1. If `flagInput` has any value, use comma parser (no LLM cost).
 *   2. Else if `naturalInput` has any value, use Haiku.
 *   3. Else return `{ features: [], method: 'none' }`.
 */
export async function parseFeatures(opts: ParseFeaturesOptions): Promise<ParseFeaturesResult> {
  if (opts.flagInput && opts.flagInput.trim().length > 0) {
    return { features: parseCommaSeparated(opts.flagInput), method: 'comma' };
  }
  if (opts.naturalInput && opts.naturalInput.trim().length > 0) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // No key available — silently fall back rather than fail the run.
      // The caller can still use the Planner's homepage-inference path.
      return { features: [], method: 'none' };
    }
    const { features, costUsd } = await parseNaturalLanguage(opts.naturalInput, apiKey, opts.model);
    return { features, method: 'natural', costUsd };
  }
  return { features: [], method: 'none' };
}
