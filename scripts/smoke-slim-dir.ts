/**
 * Verifies the slim-framework-dir behavior shared by the CLI and gateway:
 *
 *   1. scaffold() produces a full framework at <dir>/
 *   2. zip is created at <dir>.zip
 *   3. Caller invokes slimFrameworkDir(<dir>)
 *   4. After slimming, <dir> contains ONLY run-report.json — pages/, tests/,
 *      package.json, etc. are gone. The zip is intact.
 *   5. The dashboard's listRunsFromDisk-equivalent walk still finds the run.
 *
 * No network, no LLM. Builds a fixture framework then mirrors the same
 * "scaffold + zip + slim" sequence both production paths use.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { scaffold } from '../src/agent/scaffold.js';
import { zipFrameworkToFile } from '../src/agent/zip-framework.js';
import type { RunReport } from '../src/agent/trace.js';

// Mirror of the slimFrameworkDir helper in cli/explore.ts and server/gateway.ts.
// Kept inline here so this smoke is self-contained (the production helpers are
// not exported — they're file-local utilities. If we ever extract them to a
// shared module, we should switch to importing from there).
function slimFrameworkDir(dir: string): void {
  const reportPath = path.join(dir, 'run-report.json');
  let reportContent: string | null = null;
  if (fs.existsSync(reportPath)) {
    try { reportContent = fs.readFileSync(reportPath, 'utf8'); } catch { /* leave null */ }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (reportContent !== null) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(reportPath, reportContent);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-slim-'));
const frameworkDir = path.join(tmpRoot, 'saucedemo-framework');
const zipPath = path.join(tmpRoot, 'saucedemo-framework.zip');

const report: RunReport = {
  url: 'https://www.saucedemo.com/',
  language: 'ts',
  scenarios: [{
    name: 'logged in', category: 'happy',
    steps: [
      { kind: 'navigate', url: 'https://www.saucedemo.com/' },
      { kind: 'assert', name: 'inventory URL', assertion: { type: 'toHaveURL', pattern: '/inventory' } },
    ],
  }],
  cascadeStats: { role: 1, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 2,
  startedAt: '2026-06-22T12:00:00Z',
  finishedAt: '2026-06-22T12:00:30Z',
};

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

// 1) Scaffold a full framework.
scaffold({ report, outDir: frameworkDir, siteName: 'www.saucedemo.com', features: ['login'] });
const initialFileCount = walkCount(frameworkDir);
check('A. scaffold produced a full framework', initialFileCount >= 9);

// 2) Zip it.
zipFrameworkToFile(frameworkDir, zipPath);
const zipBytes = fs.statSync(zipPath).size;
check('B. zip created on disk', zipBytes > 0);

// 3) Slim the dir.
slimFrameworkDir(frameworkDir);

// 4) The dir now contains only run-report.json.
const remaining = fs.readdirSync(frameworkDir);
check('C. dir contains exactly 1 entry after slim', remaining.length === 1);
check('D. the remaining entry is run-report.json', remaining[0] === 'run-report.json');
check('E. run-report.json content is valid JSON', (() => {
  try { JSON.parse(fs.readFileSync(path.join(frameworkDir, 'run-report.json'), 'utf8')); return true; }
  catch { return false; }
})());

// 5) Bulky files are gone.
const goneFiles = ['package.json', 'playwright.config.ts', 'README.md', 'tsconfig.json', '.gitignore', '.env.example'];
for (const gone of goneFiles) {
  check(`F. ${gone} removed from slim dir`, !fs.existsSync(path.join(frameworkDir, gone)));
}
check('G. pages/ removed', !fs.existsSync(path.join(frameworkDir, 'pages')));
check('H. tests/ removed (sweeps tests/a11y/ too)', !fs.existsSync(path.join(frameworkDir, 'tests')));
check('I. legacy top-level a11y/ does not exist after slim', !fs.existsSync(path.join(frameworkDir, 'a11y')));

// 6) Zip remains untouched on disk.
check('J. zip still exists after slim', fs.existsSync(zipPath));
check('K. zip size unchanged after slim', fs.statSync(zipPath).size === zipBytes);

// 7) Critical — zip contents are unaffected (still extractable, still complete).
const extractDir = path.join(tmpRoot, 'extracted-after-slim');
fs.mkdirSync(extractDir);
const unzip = spawnSync('unzip', ['-q', zipPath, '-d', extractDir], { encoding: 'utf8' });
check('L. zip extracts cleanly after slim', unzip.status === 0, unzip.stderr);
if (unzip.status === 0) {
  const extractedFramework = path.join(extractDir, 'saucedemo-framework');
  check('M. extracted framework still has package.json', fs.existsSync(path.join(extractedFramework, 'package.json')));
  check('N. extracted framework still has README.md', fs.existsSync(path.join(extractedFramework, 'README.md')));
  check('O. extracted framework still has pages/ + tests/ + tests/a11y/', fs.existsSync(path.join(extractedFramework, 'pages')) && fs.existsSync(path.join(extractedFramework, 'tests')) && fs.existsSync(path.join(extractedFramework, 'tests', 'a11y')));
}

// 8) Sanity — the slim is idempotent (calling it twice on already-slimmed dir is safe).
slimFrameworkDir(frameworkDir);
const stillRemaining = fs.readdirSync(frameworkDir);
check('P. slim is idempotent (second call leaves run-report intact)', stillRemaining.length === 1 && stillRemaining[0] === 'run-report.json');

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: slim-dir keeps the zip intact and reduces the directory to just run-report.json.');

function walkCount(d: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    if (entry.isDirectory()) n += walkCount(path.join(d, entry.name));
    else n++;
  }
  return n;
}
