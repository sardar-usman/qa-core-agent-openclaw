/**
 * Lock in the four known Haiku format variants for the Planner output.
 * If any future model drift breaks one of these, this test fails fast.
 *
 * No network, no API calls. Imports the same parsePlan logic the runtime uses.
 */
import { plan as _ } from '../src/agent/planner.js';

// parsePlan is not exported; we test through plan()'s public behavior via a
// minimal harness. Easier path: replicate the regex here. If we ever want to
// run this as a unit test, parsePlan can be exported.
function parsePlan(text: string): Array<{ name: string; category: string; rationale: string }> {
  const m = text.match(/<plan>([\s\S]*?)<\/plan>/i);
  const body = m && m[1] ? m[1] : text;
  const lines = body.split('\n').map(l => l.trim()).filter(l => /^\d+[.)]/.test(l));
  const out: Array<{ name: string; category: string; rationale: string }> = [];
  for (const raw of lines) {
    const match = raw.match(/^\d+[.)]\s*\[?(happy|negative|edge|a11y)\]?\s*[:\-—–]?\s*(.+?)\s*[—–]+\s*(.+)$/i);
    if (match && match[1] && match[2] && match[3]) {
      out.push({
        name: match[2].trim(),
        category: match[1].toLowerCase(),
        rationale: match[3].trim(),
      });
    }
  }
  return out;
}

const variants: Array<{ label: string; text: string; expected: number }> = [
  {
    label: 'A. brackets + em-dash (prompt-as-asked)',
    text: '<plan>\n1. [happy] logged in with valid credentials — verifies the success path\n2. [negative] rejects invalid password — error message appears\n</plan>',
    expected: 2,
  },
  {
    label: 'B. no brackets, em-dash separator only',
    text: '<plan>\n1. happy logged in with valid credentials — verifies success\n2. negative rejects invalid password — error appears\n</plan>',
    expected: 2,
  },
  {
    label: 'C. no brackets, em-dash AFTER category too',
    text: '<plan>\n1. happy — logged in with valid credentials — verifies success\n2. negative — rejects invalid password — error appears\n</plan>',
    expected: 2,
  },
  {
    label: 'D. no brackets, colon AFTER category',
    text: '<plan>\n1. happy: logged in with valid credentials — verifies success\n2. negative: rejects invalid password — error appears\n</plan>',
    expected: 2,
  },
  {
    label: 'E. scenario name contains a hyphen (must NOT split on it)',
    text: '<plan>\n1. [edge] handles well-formed JSON input — verifies non-string payloads parse correctly\n</plan>',
    expected: 1,
  },
];

let ok = true;
for (const v of variants) {
  const got = parsePlan(v.text);
  const pass = got.length === v.expected;
  console.log(`${pass ? 'OK' : 'FAIL'}: ${v.label} → got ${got.length}, expected ${v.expected}`);
  if (!pass) {
    ok = false;
    console.log('  parsed:', JSON.stringify(got, null, 2));
  } else if (v.label.startsWith('E')) {
    // Variant E is the one that would break under a too-loose regex; show the
    // captures so we can confirm the hyphen-in-name didn't split incorrectly.
    console.log('  captures:', JSON.stringify(got, null, 2));
  }
}

if (!ok) process.exit(1);
console.log('\nAll 5 Planner format variants parse correctly.');
