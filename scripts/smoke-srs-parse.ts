/**
 * Locks SRS ingestion (src/agent/requirements.ts), without any LLM call:
 *   - loadSrsText reads a .md file directly.
 *   - The 60,000-character cap truncates and reports truncated=true.
 *   - An unsupported extension is rejected with an error naming the
 *     supported ones.
 *   - parseRequirementsResponse (the parse step behind buildRequirementsMap)
 *     recovers a fenced response, accepts a clean response, tolerates prose
 *     around the JSON, normalizes feature names to kebab-case, renumbers
 *     colliding rule ids, and throws clearly on a malformed response.
 *
 * No network. No LLM. Temp files only.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSrsText, parseRequirementsResponse, SRS_TEXT_CAP } from '../src/agent/requirements.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-srs-'));

const FIXTURE_SRS = `# Login requirements

The login page is at /login.

- The password must be at least 8 characters.
- The email field is required.
- After a successful login the user lands on the dashboard.
- Only admins may open the settings page.
`;

/* ─── A. .md loads directly, no truncation ─────────────────────────────────── */
const mdPath = path.join(tmpRoot, 'srs.md');
fs.writeFileSync(mdPath, FIXTURE_SRS);
const loaded = await loadSrsText(mdPath);
check('A1. .md loads the exact text', loaded.text === FIXTURE_SRS);
check('A2. under the cap is not truncated', loaded.truncated === false);

/* ─── B. the 60k cap truncates and reports it ──────────────────────────────── */
const bigPath = path.join(tmpRoot, 'big.txt');
fs.writeFileSync(bigPath, 'R'.repeat(SRS_TEXT_CAP + 5_000));
const big = await loadSrsText(bigPath);
check('B1. oversized text is cut at the cap', big.text.length === SRS_TEXT_CAP);
check('B2. truncation is recorded', big.truncated === true);

/* ─── C. unsupported extension fails with a clear error ────────────────────── */
const rtfPath = path.join(tmpRoot, 'srs.rtf');
fs.writeFileSync(rtfPath, 'not supported');
let rtfError = '';
try { await loadSrsText(rtfPath); } catch (err) { rtfError = (err as Error).message; }
check('C1. .rtf is rejected', rtfError.length > 0);
check('C2. the error names the supported extensions', ['.md', '.txt', '.pdf', '.docx'].every((e) => rtfError.includes(e)), rtfError);

/* ─── D. parse step: clean response ────────────────────────────────────────── */
const CLEAN = JSON.stringify({
  features: [
    {
      name: 'login',
      description: 'Users sign in with email and password.',
      urls: ['/login'],
      rules: [
        { id: 'R1', text: 'The password must be at least 8 characters.', type: 'validation' },
        { id: 'R2', text: 'The email field is required.', type: 'validation' },
      ],
    },
  ],
  roles: ['admin'],
});
const clean = parseRequirementsResponse(CLEAN);
check('D1. clean JSON parses', clean.features.length === 1 && clean.features[0]!.name === 'login');
check('D2. rules survive with id + type', clean.features[0]!.rules.length === 2 && clean.features[0]!.rules[0]!.id === 'R1' && clean.features[0]!.rules[0]!.type === 'validation');
check('D3. stated urls survive', (clean.features[0]!.urls ?? []).includes('/login'));
check('D4. roles survive', clean.roles.includes('admin'));

/* ─── E. parse step: fenced response is recovered ──────────────────────────── */
const fenced = parseRequirementsResponse('```json\n' + CLEAN + '\n```');
check('E1. a ```json fence is stripped', fenced.features.length === 1 && fenced.features[0]!.rules.length === 2);
const withProse = parseRequirementsResponse('Here is the requirements map you asked for:\n\n' + CLEAN + '\n\nLet me know if you need anything else.');
check('E2. prose around the JSON object is tolerated', withProse.features.length === 1);

/* ─── F. parse step: normalization + id repair ─────────────────────────────── */
const MESSY = JSON.stringify({
  features: [
    { name: 'User Registration', description: 'x', rules: [{ id: 'R1', text: 'a', type: 'validation' }, { id: 'R1', text: 'b', type: 'weird-type' }] },
    { name: 'cart', description: 'y', rules: [{ text: 'c', type: 'behavior' }] },
  ],
  roles: [],
});
const messy = parseRequirementsResponse(MESSY);
check('F1. feature names normalize to kebab-case', messy.features[0]!.name === 'user-registration');
const allIds = messy.features.flatMap((f) => f.rules.map((r) => r.id));
check('F2. colliding/missing ids are renumbered unique', new Set(allIds).size === allIds.length && allIds.every((id) => /^R\d+$/.test(id)), JSON.stringify(allIds));
check('F3. an unknown rule type falls back to behavior', messy.features[0]!.rules[1]!.type === 'behavior');
check('F4. a feature without stated urls has no urls key', !('urls' in messy.features[1]!));

/* ─── G. parse step: malformed responses throw clearly ─────────────────────── */
const throws = (input: string): string => {
  try { parseRequirementsResponse(input); return ''; } catch (err) { return (err as Error).message; }
};
check('G1. non-JSON throws', throws('this is not json at all').length > 0);
check('G2. a JSON array (wrong shape) throws', throws('[1,2,3]').length > 0);
check('G3. an object without features throws', throws('{"roles":[]}').includes('features'));
check('G4. an object with zero usable features throws', throws('{"features":[{"rules":[]}],"roles":[]}').length > 0);

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: SRS loading caps and rejects correctly, and the requirements parser recovers fenced/prose responses and fails loud on malformed ones.');
