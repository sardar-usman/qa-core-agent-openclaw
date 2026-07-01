/**
 * Locks per-run unique data generation for creation flows (unique-data.ts).
 *
 * The bug this prevents: a register happy path that fills a fixed email passes
 * once, then fails every later run because the email is already taken; or it
 * fills a fixed password that a strength / data-leak check rejects outright. The
 * fix is generated data: the emitted spec calls uniqueEmail() / uniquePassword()
 * so each run uses a fresh, strong value, and replay/exploration use the same
 * generator.
 *
 * Checks:
 *   - detectUniqueField fires only for an email/username on a happy creation
 *     flow, never for negative/edge or non-creation flows (so a deliberate
 *     duplicate test keeps its literal).
 *   - generateUnique returns fresh, correctly shaped values.
 *   - The emitted POM spec imports and CALLS uniqueEmail() for the generated
 *     field and does NOT contain the recorded literal, while a literal email on
 *     an edge scenario is preserved.
 *   - helpers/unique-data.{ts,js} ships with uniqueEmail / uniqueToken.
 *   - The JS output path is clean (require + module.exports).
 *   - The single-file inline transcriber inlines the generator and calls it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scaffold, frameworkDirName } from '../src/agent/scaffold.js';
import { transcribe } from '../src/agent/transcriber.js';
import { detectUniqueField, generateUnique } from '../src/agent/unique-data.js';
import type { RunReport, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── A. detection is general and scoped to happy creation flows ───────────── */
check('A1. email on a happy register flow generates a unique email',
  detectUniqueField({ category: 'happy', flowHint: 'register sign up', fieldHint: 'email input' }) === 'email');
check('A2. email field detected by testid on a registration flow',
  detectUniqueField({ category: 'happy', flowHint: 'registration https://x.com/auth/register', fieldHint: 'user email address e-mail' }) === 'email');
check('A3. a username field on a creation flow generates a token',
  detectUniqueField({ category: 'happy', flowHint: 'create account', fieldHint: 'username' }) === 'token');
check('A4. an EDGE duplicate-email scenario keeps its literal (no generation)',
  detectUniqueField({ category: 'edge', flowHint: 'register', fieldHint: 'email input' }) === undefined);
check('A5. a NEGATIVE invalid-email scenario keeps its literal',
  detectUniqueField({ category: 'negative', flowHint: 'register', fieldHint: 'email input' }) === undefined);
check('A6. an email on a NON-creation flow (login) is not generated',
  detectUniqueField({ category: 'happy', flowHint: 'login sign in', fieldHint: 'email input' }) === undefined);
check('A7. a non-email, non-username field on a creation flow is not generated',
  detectUniqueField({ category: 'happy', flowHint: 'register', fieldHint: 'first name input' }) === undefined);
check('A8. a password field on a happy register flow generates a strong password',
  detectUniqueField({ category: 'happy', flowHint: 'sign up create account', fieldHint: 'password input' }) === 'password');
check('A9. a password field on a LOGIN flow is not generated (needs the known password)',
  detectUniqueField({ category: 'happy', flowHint: 'login sign in', fieldHint: 'password input' }) === undefined);
check('A10. a password on a NEGATIVE flow keeps its literal (e.g. a deliberately weak password)',
  detectUniqueField({ category: 'negative', flowHint: 'register', fieldHint: 'password input' }) === undefined);

/* ─── B. the runtime generator is fresh and correctly shaped ────────────────── */
const e1 = generateUnique('email');
const e2 = generateUnique('email');
check('B1. generated emails look like real emails', /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e1), e1);
check('B2. two generated emails are different (fresh per call)', e1 !== e2, `${e1} vs ${e2}`);
const t1 = generateUnique('token');
check('B3. generated tokens are non-empty alphanumeric', /^[a-z0-9]+$/i.test(t1), t1);
check('B4. token and email are different shapes', !t1.includes('@'));
const p1 = generateUnique('password');
const p2 = generateUnique('password');
check('B5. generated password has upper, lower, digit, and symbol (clears strength rules)',
  /[A-Z]/.test(p1) && /[a-z]/.test(p1) && /[0-9]/.test(p1) && /[^A-Za-z0-9]/.test(p1) && p1.length >= 12, p1);
check('B6. the password is stable within a run (so a confirm-password field matches)', p1 === p2, `${p1} vs ${p2}`);

/* ─── C. POM output: generated field uses uniqueEmail(), literal preserved ──── */
const LITERAL_HAPPY_EMAIL = 'jane.exploration.literal@example.com';
const LITERAL_HAPPY_PASSWORD = 'PlainLiteralPass1!';
const LITERAL_EDGE_EMAIL = 'already.taken.customer@example.com';

const emailTarget = (intent: string): Extract<TraceStep, { kind: 'fill' }>['target'] =>
  ({ level: 'testid', arg: 'email', intent });

const report: RunReport = {
  url: 'https://practicesoftwaretesting.com/auth/register',
  language: 'ts',
  scenarios: [
    {
      name: 'registered with valid credentials', category: 'happy', feature: 'register',
      steps: [
        { kind: 'navigate', url: 'https://practicesoftwaretesting.com/auth/register' },
        { kind: 'fill', target: { level: 'testid', arg: 'first-name', intent: 'first name input' }, value: 'Jane' },
        // The email field on the happy register flow is generated per run.
        { kind: 'fill', target: emailTarget('email input'), value: LITERAL_HAPPY_EMAIL, generate: 'email' },
        // The password on the happy register flow is generated strong per run.
        { kind: 'fill', target: { level: 'testid', arg: 'password', intent: 'password input' }, value: LITERAL_HAPPY_PASSWORD, generate: 'password' },
        { kind: 'click', target: { level: 'testid', arg: 'register-submit', intent: 'register button' } },
        { kind: 'assert', name: 'redirected to login', assertion: { type: 'toHaveURL', pattern: '/auth/login' } },
      ],
    },
    {
      name: 'rejected an email already in use', category: 'edge', feature: 'register',
      steps: [
        { kind: 'navigate', url: 'https://practicesoftwaretesting.com/auth/register' },
        { kind: 'fill', target: { level: 'testid', arg: 'first-name', intent: 'first name input' }, value: 'Jane' },
        // Edge case deliberately reuses a known email — must stay literal.
        { kind: 'fill', target: emailTarget('email input'), value: LITERAL_EDGE_EMAIL },
        { kind: 'fill', target: { level: 'testid', arg: 'password', intent: 'password input' }, value: 'StrongP@ss1!' },
        { kind: 'click', target: { level: 'testid', arg: 'register-submit', intent: 'register button' } },
        { kind: 'assert', name: 'stays on register', assertion: { type: 'toHaveURL', pattern: '/auth/register' } },
      ],
    },
  ],
  cascadeStats: { role: 1, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 5, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 12,
  startedAt: '2026-06-26T12:00:00Z',
  finishedAt: '2026-06-26T12:01:00Z',
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-unique-'));
const tsDir = path.join(tmpRoot, frameworkDirName(report.url));
scaffold({ report, outDir: tsDir, siteName: 'practicesoftwaretesting.com', features: ['register'] });

const tsSpec = fs.readFileSync(path.join(tsDir, 'tests', 'register', 'register.spec.ts'), 'utf8');
check('C1. spec imports uniqueEmail from helpers/unique-data',
  /import\s*\{[^}]*\buniqueEmail\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/helpers\/unique-data['"]/.test(tsSpec), tsSpec);
check('C2. spec CALLS uniqueEmail() for the generated field', /uniqueEmail\(\)/.test(tsSpec));
check('C3. spec does NOT contain the recorded happy-path literal email', !tsSpec.includes(LITERAL_HAPPY_EMAIL), tsSpec);
check('C4. spec DOES keep the edge scenario literal email (deliberate duplicate)', tsSpec.includes(LITERAL_EDGE_EMAIL));
check('C5. spec does not import uniqueToken (no username field here)', !/\buniqueToken\b/.test(tsSpec));
check('C6. spec imports and CALLS uniquePassword() for the happy password field',
  /import\s*\{[^}]*\buniquePassword\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/helpers\/unique-data['"]/.test(tsSpec) && /uniquePassword\(\)/.test(tsSpec), tsSpec);
check('C7. spec does NOT contain the recorded happy-path literal password', !tsSpec.includes(LITERAL_HAPPY_PASSWORD), tsSpec);

const tsHelper = path.join(tsDir, 'helpers', 'unique-data.ts');
check('C8. helpers/unique-data.ts exists', fs.existsSync(tsHelper));
const tsHelperSrc = fs.readFileSync(tsHelper, 'utf8');
check('C9. helper exports uniqueEmail, uniqueToken, and uniquePassword',
  /export\s+function\s+uniqueEmail\b/.test(tsHelperSrc) && /export\s+function\s+uniqueToken\b/.test(tsHelperSrc) && /export\s+function\s+uniquePassword\b/.test(tsHelperSrc));

/* ─── D. JS output path is clean (require + module.exports) ─────────────────── */
const jsReport: RunReport = { ...report, language: 'js' };
const jsDir = path.join(tmpRoot, 'js-' + frameworkDirName(report.url));
scaffold({ report: jsReport, outDir: jsDir, siteName: 'practicesoftwaretesting.com', features: ['register'] });
const jsSpec = fs.readFileSync(path.join(jsDir, 'tests', 'register', 'register.spec.js'), 'utf8');
check('D1. JS spec requires uniqueEmail from helpers/unique-data',
  /const\s*\{[^}]*\buniqueEmail\b[^}]*\}\s*=\s*require\(['"]\.\.\/\.\.\/helpers\/unique-data['"]\)/.test(jsSpec), jsSpec);
check('D2. JS spec calls uniqueEmail() and uniquePassword()', /uniqueEmail\(\)/.test(jsSpec) && /uniquePassword\(\)/.test(jsSpec));
check('D3. JS spec drops the happy-path literal email and password', !jsSpec.includes(LITERAL_HAPPY_EMAIL) && !jsSpec.includes(LITERAL_HAPPY_PASSWORD));
const jsHelper = path.join(jsDir, 'helpers', 'unique-data.js');
check('D4. helpers/unique-data.js exists', fs.existsSync(jsHelper));
const jsHelperSrc = fs.readFileSync(jsHelper, 'utf8');
check('D5. JS helper exports uniqueEmail and uniquePassword via module.exports',
  /module\.exports\s*=\s*\{[^}]*uniqueEmail[^}]*\}/.test(jsHelperSrc) && /module\.exports\s*=\s*\{[^}]*uniquePassword[^}]*\}/.test(jsHelperSrc));
check('D6. JS framework has no tsconfig.json', !fs.existsSync(path.join(jsDir, 'tsconfig.json')));

/* ─── E. single-file inline transcriber inlines the generator ──────────────── */
const inlineDir = path.join(tmpRoot, 'inline');
const { specPath } = transcribe({ report, outDir: inlineDir, name: 'register' });
const inlineSpec = fs.readFileSync(specPath, 'utf8');
check('E1. inline spec defines uniqueEmail and uniquePassword locally (self-contained)',
  /function\s+uniqueEmail\b/.test(inlineSpec) && /function\s+uniquePassword\b/.test(inlineSpec));
check('E2. inline spec calls uniqueEmail() and uniquePassword()', /uniqueEmail\(\)/.test(inlineSpec) && /uniquePassword\(\)/.test(inlineSpec));
check('E3. inline spec drops the happy-path literal email and password', !inlineSpec.includes(LITERAL_HAPPY_EMAIL) && !inlineSpec.includes(LITERAL_HAPPY_PASSWORD));
check('E4. inline spec keeps the edge literal', inlineSpec.includes(LITERAL_EDGE_EMAIL));

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: unique-data — creation-flow email/username/password fields generate fresh, strong values in the emitted spec (POM + inline, TS + JS); deliberate-duplicate and login literals are preserved.');
