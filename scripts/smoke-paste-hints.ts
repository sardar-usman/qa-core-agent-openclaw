/**
 * Locks in the two paste-detection helpers in src/agent/parse-hints.ts.
 *
 * These exist to recover from the #1 user mistake we see in the dashboard
 * chat: copy-pasting CLI syntax (with `npm run …` and/or `--` separators).
 * Both helpers intervene only when intent is highly confident — otherwise
 * downstream validators get the normal error path.
 *
 * Zero network, zero LLM.
 */
import {
  stripNpmStyleLeadingDashes,
  detectPastedCliCommand,
} from '../src/agent/parse-hints.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── stripNpmStyleLeadingDashes ─────────────────────────────────────── */

// 1. Strips when followed by a full http URL
const f1 = stripNpmStyleLeadingDashes('-- https://saucedemo.com/ --features login');
check('A. strips `-- https://...` (full URL after dash-dash)', f1.stripped);
check('B. cleaned text starts with the URL', f1.cleaned === 'https://saucedemo.com/ --features login');

// 2. Strips when followed by a bare host (URL validator will normalise)
const f2 = stripNpmStyleLeadingDashes('-- saucedemo.com --features cart');
check('C. strips `-- saucedemo.com` (bare host after dash-dash)', f2.stripped);
check('D. cleaned text starts with the host', f2.cleaned === 'saucedemo.com --features cart');

// 3. Strips for www. prefix
const f3 = stripNpmStyleLeadingDashes('-- www.saucedemo.com/cart');
check('E. strips `-- www.saucedemo.com/cart`', f3.stripped && f3.cleaned === 'www.saucedemo.com/cart');

// 4. Strips with extra whitespace
const f4 = stripNpmStyleLeadingDashes('--   https://shop.com');
check('F. tolerates extra whitespace after the dashes', f4.stripped && f4.cleaned === 'https://shop.com');

// 5. Does NOT strip when followed by garbage (let validator catch it)
const f5 = stripNpmStyleLeadingDashes('-- garbage-not-a-url');
check('G. does NOT strip when remainder is not URL-shaped', !f5.stripped);
check('H. cleaned text unchanged for non-URL remainder', f5.cleaned === '-- garbage-not-a-url');

// 6. Does NOT strip `--features` (no whitespace after the dashes)
const f6 = stripNpmStyleLeadingDashes('--features login,cart');
check('I. does NOT strip a real flag (no space after dashes)', !f6.stripped);
check('J. cleaned text unchanged for real flags', f6.cleaned === '--features login,cart');

// 7. Does NOT touch input that already starts with a URL
const f7 = stripNpmStyleLeadingDashes('https://saucedemo.com/ --features login');
check('K. leaves input alone when it already starts with a URL', !f7.stripped);

// 8. Does NOT strip when remainder is empty
const f8 = stripNpmStyleLeadingDashes('--');
check('L. does NOT strip bare `--` (no remainder)', !f8.stripped);

// 9. Does NOT strip when remainder is single char of punctuation
const f9 = stripNpmStyleLeadingDashes('-- ?');
check('M. does NOT strip when remainder is pure punctuation', !f9.stripped);

// 10. Localhost works (no dot in host but matches the http:// branch)
const f10 = stripNpmStyleLeadingDashes('-- http://localhost:3000/login');
check('N. strips when followed by http://localhost:3000', f10.stripped);

/* ─── detectPastedCliCommand ─────────────────────────────────────────── */

// 11. Matches `npm run explore -- <url>`
const c1 = detectPastedCliCommand('npm run explore -- https://saucedemo.com/ --features login');
check('O. detects `npm run explore -- …`', c1 !== null);
if (c1) {
  check('P. slash = /explore', c1.slash === '/explore');
  check('Q. args carry the URL + flags',
    c1.args === 'https://saucedemo.com/ --features login');
  check('R. suggestion is the corrected command',
    c1.suggestion === '/explore https://saucedemo.com/ --features login');
}

// 12. Matches without the `--` separator
const c2 = detectPastedCliCommand('npm run explore https://saucedemo.com/');
check('S. detects `npm run explore <url>` (no -- separator)', c2 !== null);
check('T. slash + args still correct', c2?.slash === '/explore' && c2?.args === 'https://saucedemo.com/');

// 13. /generate variant
const c3 = detectPastedCliCommand('npm run generate -- "user can log in"');
check('U. detects `npm run generate -- …`',
  c3 !== null && c3.slash === '/generate' && c3.args === '"user can log in"');

// 14. /heal variant
const c4 = detectPastedCliCommand('npm run heal -- tests/login/login.spec.ts');
check('V. detects `npm run heal -- …`',
  c4 !== null && c4.slash === '/heal' && c4.args === 'tests/login/login.spec.ts');

// 15. Surrounding whitespace
const c5 = detectPastedCliCommand('   npm run explore -- https://saucedemo.com/   ');
check('W. tolerates surrounding whitespace',
  c5 !== null && c5.suggestion === '/explore https://saucedemo.com/');

// 16. Case-insensitive on `NPM RUN`
const c6 = detectPastedCliCommand('NPM RUN EXPLORE -- https://saucedemo.com/');
check('X. case-insensitive match',
  c6 !== null && c6.slash === '/explore');

// 17. Ignores unrelated input (slash commands, plain prose)
check('Y. ignores `/explore <url>` (already correct)',
  detectPastedCliCommand('/explore https://saucedemo.com/') === null);
check('Z. ignores plain prose',
  detectPastedCliCommand('hey what does this agent do') === null);
check('AA. ignores `npm install`',
  detectPastedCliCommand('npm install') === null);
check('AB. ignores `npm run gateway`',
  detectPastedCliCommand('npm run gateway') === null);
check('AC. ignores other npm scripts',
  detectPastedCliCommand('npm run test') === null);

// 18. Empty args produces a `<args>` placeholder so the suggestion is still usable
const c7 = detectPastedCliCommand('npm run explore');
check('AD. empty args fills in `<args>` placeholder',
  c7 !== null && c7.args === '<args>');

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: paste-hint helpers recover from npm-style mistakes without breaking valid input.');
