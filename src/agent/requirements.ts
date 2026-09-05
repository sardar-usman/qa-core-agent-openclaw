import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { normalizeFeatureName } from './parse-features.js';

/**
 * Requirements map — SRS ingestion for rule-driven planning.
 *
 * The user supplies a requirements document (SRS) in .md, .txt, .pdf, or
 * .docx. One cheap Haiku call converts it into a structured RequirementsMap:
 * features, per-feature rules with stable ids, and the roles the SRS names.
 * The Planner then derives scenarios from the stated rules first and cites
 * rule ids per scenario, and the run ends with a rule-coverage report.
 *
 * The map contains ONLY what the SRS states. The extraction prompt forbids
 * inventing URLs or rules; a rule that is not in the document must not appear
 * in the map.
 */

export interface RequirementRule {
  /** Stable id, unique across the whole map: R1, R2, ... */
  id: string;
  /** The rule in plain words. */
  text: string;
  type: 'validation' | 'behavior' | 'permission' | 'navigation';
}

export interface RequirementFeature {
  /** Kebab-case slug, same normalization as parse-features.ts. */
  name: string;
  /** One sentence. */
  description: string;
  /** Only present when the SRS states them. Never invented. */
  urls?: string[];
  rules: RequirementRule[];
}

export interface RequirementsMap {
  features: RequirementFeature[];
  /** User roles the SRS names. Empty when it names none. */
  roles: string[];
  /** True when the SRS text was cut at the extraction cap. */
  truncated: boolean;
}

/** Cap on the SRS text sent to the model. */
export const SRS_TEXT_CAP = 60_000;

const SUPPORTED_EXTENSIONS = ['.md', '.txt', '.pdf', '.docx'];

const HAIKU_MODEL = 'claude-haiku-4-5';
// Haiku pricing per million tokens, same constants pattern as parse-features.ts.
const PRICE = { in: 1.0, out: 5.0 };

/**
 * Read an SRS document into plain text. .md and .txt read directly; .pdf via
 * pdf-parse; .docx via mammoth. Anything else is rejected with an error that
 * names the supported extensions. Output is capped at SRS_TEXT_CAP characters;
 * a longer document keeps the first SRS_TEXT_CAP and reports truncated=true.
 */
export async function loadSrsText(filePath: string): Promise<{ text: string; truncated: boolean }> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`SRS file not found: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  let text: string;
  switch (ext) {
    case '.md':
    case '.txt':
      text = fs.readFileSync(filePath, 'utf8');
      break;
    case '.pdf': {
      const { default: pdfParse } = await import('pdf-parse');
      const parsed = await pdfParse(fs.readFileSync(filePath));
      text = parsed.text;
      break;
    }
    case '.docx': {
      const { default: mammoth } = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: fs.readFileSync(filePath) });
      text = result.value;
      break;
    }
    default:
      throw new Error(
        `Unsupported SRS file type "${ext || '(none)'}" for ${filePath}. ` +
          `Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
      );
  }
  if (text.length > SRS_TEXT_CAP) {
    return { text: text.slice(0, SRS_TEXT_CAP), truncated: true };
  }
  return { text, truncated: false };
}

const SYSTEM = `You convert a software requirements document (SRS) into a structured map of features and testable rules.

Extraction rules:
- Extract ONLY what the document states. Never invent URLs, features, roles, or rules that are not in the text.
- Include a "urls" array on a feature ONLY when the document states the URL. Omit the key otherwise.
- Every validation constraint gets its OWN rule: each length limit, format requirement, required field, and value range is one rule, not a combined sentence.
- Rule types: "validation" (input constraints), "behavior" (what the system does), "permission" (who may do what), "navigation" (where the user lands or may go).
- Rule ids are R1, R2, R3, ... unique across the WHOLE document, in reading order.
- Feature names are short lowercase kebab-case slugs (login, user-registration, cart).
- "roles" lists the user roles the document names (admin, guest, ...). Empty array when it names none.

Output STRICT JSON matching exactly this shape, and nothing else — no prose, no markdown fence:
{
  "features": [
    {
      "name": "kebab-case-slug",
      "description": "one sentence",
      "urls": ["only-when-stated"],
      "rules": [
        { "id": "R1", "text": "the rule in plain words", "type": "validation" }
      ]
    }
  ],
  "roles": []
}`;

const RULE_TYPES = new Set(['validation', 'behavior', 'permission', 'navigation']);

/**
 * Parse the model's response into the features + roles of a RequirementsMap.
 * Defensive: strips a markdown fence if one sneaks in, tolerates prose around
 * the JSON object, validates the shape, normalizes feature names to kebab-case,
 * and re-numbers rule ids R1..Rn (in order) when the model's ids are missing or
 * collide, so ids are always unique across the map. Throws on anything that
 * cannot be recovered into the expected shape.
 *
 * Exported (pure, no API call) so the smoke test can drive the recovery paths.
 */
export function parseRequirementsResponse(text: string): Pick<RequirementsMap, 'features' | 'roles'> {
  let body = text.trim();
  // Strip a ```json ... ``` (or bare ```) fence.
  const fence = body.match(/^```[a-z]*\s*([\s\S]*?)\s*```\s*$/i);
  if (fence && fence[1]) body = fence[1].trim();
  // Tolerate prose around the object: parse from the first "{" to the last "}".
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) body = body.slice(first, last + 1);

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new Error(`Requirements response is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Requirements response is not a JSON object.');
  }
  const obj = raw as { features?: unknown; roles?: unknown };
  if (!Array.isArray(obj.features)) {
    throw new Error('Requirements response has no "features" array.');
  }

  const features: RequirementFeature[] = [];
  const seenIds = new Set<string>();
  let idsValid = true;
  for (const f of obj.features) {
    if (typeof f !== 'object' || f === null) continue;
    const fo = f as { name?: unknown; description?: unknown; urls?: unknown; rules?: unknown };
    const name = normalizeFeatureName(typeof fo.name === 'string' ? fo.name : '');
    if (!name) continue;
    const rules: RequirementRule[] = [];
    for (const r of Array.isArray(fo.rules) ? fo.rules : []) {
      if (typeof r !== 'object' || r === null) continue;
      const ro = r as { id?: unknown; text?: unknown; type?: unknown };
      const ruleText = typeof ro.text === 'string' ? ro.text.trim() : '';
      if (!ruleText) continue;
      const id = typeof ro.id === 'string' ? ro.id.trim().toUpperCase() : '';
      if (!/^R\d+$/.test(id) || seenIds.has(id)) idsValid = false;
      seenIds.add(id);
      const type = typeof ro.type === 'string' && RULE_TYPES.has(ro.type) ? (ro.type as RequirementRule['type']) : 'behavior';
      rules.push({ id, text: ruleText, type });
    }
    const urls = Array.isArray(fo.urls)
      ? fo.urls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      : [];
    features.push({
      name,
      description: typeof fo.description === 'string' ? fo.description.trim() : '',
      ...(urls.length > 0 ? { urls } : {}),
      rules,
    });
  }
  if (features.length === 0) {
    throw new Error('Requirements response contained no usable features.');
  }
  // Guarantee unique sequential ids across the whole map when the model's ids
  // are unusable. Renumbering happens BEFORE anything cites an id, so it is safe.
  if (!idsValid) {
    let n = 0;
    for (const f of features) for (const r of f.rules) r.id = `R${++n}`;
  }
  const roles = Array.isArray(obj.roles)
    ? obj.roles.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim())
    : [];
  return { features, roles };
}

export interface BuildRequirementsMapOptions {
  srsText: string;
  apiKey: string;
  model?: string;
  /** Set when loadSrsText already cut the document at the cap. */
  truncated?: boolean;
}

/**
 * One Haiku call that converts SRS text into a RequirementsMap. On a malformed
 * response the call is retried once with a "return only valid JSON" reminder;
 * a second failure throws with both parse errors named.
 */
export async function buildRequirementsMap(
  opts: BuildRequirementsMapOptions,
): Promise<{ map: RequirementsMap; costUsd: number }> {
  const model = opts.model ?? HAIKU_MODEL;
  const client = new Anthropic({ apiKey: opts.apiKey });
  // Apply the cap here too, so a caller that skipped loadSrsText cannot send
  // an unbounded document to the model.
  const overCap = opts.srsText.length > SRS_TEXT_CAP;
  const srsText = overCap ? opts.srsText.slice(0, SRS_TEXT_CAP) : opts.srsText;
  const truncated = (opts.truncated ?? false) || overCap;

  let costUsd = 0;
  const ask = async (reminder?: string): Promise<string> => {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam],
      messages: [
        { role: 'user', content: `${reminder ? reminder + '\n\n' : ''}SRS document:\n\n${srsText}` },
      ],
    });
    const u = response.usage;
    costUsd += (u.input_tokens * PRICE.in + u.output_tokens * PRICE.out) / 1_000_000;
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  };

  let parsed: Pick<RequirementsMap, 'features' | 'roles'>;
  try {
    parsed = parseRequirementsResponse(await ask());
  } catch (firstErr) {
    try {
      parsed = parseRequirementsResponse(
        await ask('Your previous answer was not valid JSON. Return ONLY the JSON object, with no prose and no markdown fence.'),
      );
    } catch (secondErr) {
      throw new Error(
        `Could not extract a requirements map from the SRS. First attempt: ${(firstErr as Error).message} ` +
          `Retry: ${(secondErr as Error).message}`,
      );
    }
  }
  return { map: { ...parsed, truncated }, costUsd };
}

/** Total rule count across every feature of a map. */
export function countRules(map: RequirementsMap): number {
  return map.features.reduce((n, f) => n + f.rules.length, 0);
}

/**
 * Render a map as the REQUIREMENTS text block injected into the Planner's
 * system prompt and the /generate context: each feature with its stated rules
 * (id + type + text), plus the roles when the SRS names any.
 */
export function renderRequirementsBlock(map: RequirementsMap): string {
  const lines: string[] = ['REQUIREMENTS (stated by the SRS — the source of truth for what to test):'];
  for (const f of map.features) {
    const urls = f.urls && f.urls.length > 0 ? ` (${f.urls.join(', ')})` : '';
    lines.push(`- feature "${f.name}"${urls}: ${f.description}`);
    for (const r of f.rules) {
      lines.push(`    ${r.id} [${r.type}] ${r.text}`);
    }
  }
  if (map.roles.length > 0) lines.push(`Roles named by the SRS: ${map.roles.join(', ')}`);
  if (map.truncated) lines.push('Note: the SRS was truncated at the extraction cap; rules beyond the cap are not listed.');
  return lines.join('\n');
}
