/**
 * Lock in the Planner output format variants:
 *   - v3.1 format with explicit feature tag: "[feature][category] name — rationale"
 *   - Four legacy format variants (no feature tag) — kept as fallbacks
 *   - Mixed lines in the same plan (some with feature, some without)
 *
 * The natural-language Haiku path is exercised separately by smoke-planner-features.ts.
 * This file stays free (no network).
 */

// Mirror of parsePlan from src/agent/planner.ts. Kept inline because parsePlan
// is not exported. If we ever extract it to a shared module, switch to import.
function parsePlan(text: string): Array<{ name: string; category: string; rationale: string; feature?: string }> {
  const m = text.match(/<plan>([\s\S]*?)<\/plan>/i);
  const body = m && m[1] ? m[1] : text;
  const lines = body.split('\n').map(l => l.trim()).filter(l => /^\d+[.)]/.test(l));
  const out: Array<{ name: string; category: string; rationale: string; feature?: string }> = [];
  for (const raw of lines) {
    const withFeature = raw.match(/^\d+[.)]\s*\[([a-z][a-z0-9-]*)\]\s*\[?(happy|negative|edge|a11y)\]?\s*[:\-—–]?\s*(.+?)\s*[—–]+\s*(.+)$/i);
    if (withFeature && withFeature[1] && withFeature[2] && withFeature[3] && withFeature[4]) {
      out.push({
        feature: withFeature[1].toLowerCase(),
        category: withFeature[2].toLowerCase(),
        name: withFeature[3].trim(),
        rationale: withFeature[4].trim(),
      });
      continue;
    }
    const match = raw.match(/^\d+[.)]\s*\[?(happy|negative|edge|a11y)\]?\s*[:\-—–]?\s*(.+?)\s*[—–]+\s*(.+)$/i);
    if (match && match[1] && match[2] && match[3]) {
      out.push({ name: match[2].trim(), category: match[1].toLowerCase(), rationale: match[3].trim() });
    }
  }
  return out;
}

interface Case {
  label: string;
  text: string;
  expected: number;
  /** When set, every parsed scenario must have feature equal to this. */
  expectFeature?: string;
  /** When set, NO parsed scenario should have a feature field. */
  expectNoFeature?: boolean;
}

const variants: Case[] = [
  {
    label: 'A. v3.1: feature + category brackets (prompt-as-asked)',
    text: '<plan>\n1. [login][happy] logged in with valid credentials — verifies success\n2. [login][negative] rejects invalid password — error appears\n</plan>',
    expected: 2,
    expectFeature: 'login',
  },
  {
    label: 'B. v3.1 with hyphen in feature name',
    text: '<plan>\n1. [forgot-password][happy] reset link sent — confirmation shown\n</plan>',
    expected: 1,
    expectFeature: 'forgot-password',
  },
  {
    label: 'C. legacy: brackets + em-dash (no feature)',
    text: '<plan>\n1. [happy] logged in with valid credentials — verifies success\n2. [negative] rejects invalid password — error appears\n</plan>',
    expected: 2,
    expectNoFeature: true,
  },
  {
    label: 'D. legacy: no brackets, em-dash AFTER category',
    text: '<plan>\n1. happy — logged in with valid credentials — verifies success\n</plan>',
    expected: 1,
    expectNoFeature: true,
  },
  {
    label: 'E. legacy: no brackets, colon AFTER category',
    text: '<plan>\n1. happy: logged in with valid credentials — verifies success\n</plan>',
    expected: 1,
    expectNoFeature: true,
  },
  {
    label: 'F. legacy: scenario name contains a hyphen (must NOT split on it)',
    text: '<plan>\n1. [edge] handles well-formed JSON input — verifies non-string payloads parse correctly\n</plan>',
    expected: 1,
  },
  {
    label: 'G. v3.1: hyphen in scenario name AND feature',
    text: '<plan>\n1. [user-profile][edge] handles well-formed JSON input — non-string payloads parse correctly\n</plan>',
    expected: 1,
    expectFeature: 'user-profile',
  },
  {
    label: 'H. mixed: some lines with feature, some without (both should parse)',
    text: '<plan>\n1. [login][happy] logged in with valid credentials — verifies success\n2. [happy] generic happy scenario — no feature tag\n</plan>',
    expected: 2,
  },
];

let pass = 0;
let fail = 0;
for (const v of variants) {
  const got = parsePlan(v.text);
  let ok = got.length === v.expected;
  if (ok && v.expectFeature) {
    ok = got.every(s => s.feature === v.expectFeature);
  }
  if (ok && v.expectNoFeature) {
    ok = got.every(s => s.feature === undefined);
  }
  if (ok) {
    pass++;
    console.log(`OK ${v.label} → ${got.length} parsed${v.expectFeature ? ', feature=' + v.expectFeature : ''}`);
  } else {
    fail++;
    console.log(`FAIL ${v.label}`);
    console.log('  parsed:', JSON.stringify(got, null, 2));
  }
}

console.log(`\n${pass}/${pass + fail} cases passed.`);
if (fail > 0) process.exit(1);
console.log('All Planner format variants (v3.1 + legacy) parse correctly.');
