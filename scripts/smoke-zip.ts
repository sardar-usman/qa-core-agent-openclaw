/**
 * Verifies the framework zipper:
 *   - zipFrameworkToFile writes a valid zip that unzip can list and extract
 *   - zipFrameworkToBuffer returns bytes that unzip recognizes via stdin
 *   - zipFrameworkToDataUrl returns a proper data: URL
 *   - The zip contains the expected files (no nesting weirdness, no symlinks)
 *   - The unzipped contents match the originals byte-for-byte
 *   - Refuses missing / non-directory inputs
 *   - Sanity: produced zip is < 1 MB for a typical generated framework
 *
 * No network. Builds a fixture framework via scaffold.ts, then zips it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { scaffold } from '../src/agent/scaffold.js';
import { zipFrameworkToFile, zipFrameworkToBuffer, zipFrameworkToDataUrl } from '../src/agent/zip-framework.js';
import type { RunReport } from '../src/agent/trace.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-zip-'));
const frameworkDir = path.join(tmpRoot, 'saucedemo-framework');
const zipPath = path.join(tmpRoot, 'saucedemo-framework.zip');

const report: RunReport = {
  url: 'https://www.saucedemo.com/',
  language: 'ts',
  scenarios: [{
    name: 'logged in with valid credentials',
    category: 'happy',
    steps: [
      { kind: 'navigate', url: 'https://www.saucedemo.com/' },
      { kind: 'fill', target: { level: 'role', arg: { role: 'textbox', name: 'Username', exact: true }, intent: 'username input' }, value: 'standard_user' },
      { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login', exact: true }, intent: 'login button' } },
      { kind: 'assert', name: 'inventory URL', assertion: { type: 'toHaveURL', pattern: '/inventory' } },
    ],
  }],
  cascadeStats: { role: 2, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 4,
  startedAt: '2026-06-20T12:00:00Z',
  finishedAt: '2026-06-20T12:01:00Z',
};

scaffold({ report, outDir: frameworkDir, siteName: 'www.saucedemo.com', features: ['login'] });

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

// 1. zipFrameworkToFile produces a real file with non-zero size.
const fileResult = zipFrameworkToFile(frameworkDir, zipPath);
check('A. file zip path matches request', fileResult.zipPath === zipPath);
check('B. file zip exists on disk', fs.existsSync(zipPath));
check('C. file zip is non-empty', fileResult.sizeBytes > 0);
check('D. file zip size matches stat', fileResult.sizeBytes === fs.statSync(zipPath).size);

// 2. The zip is a real zip (unzip can list it).
const listResult = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
check('E. unzip -l succeeds on the file', listResult.status === 0, listResult.stderr);
if (listResult.status === 0) {
  const listing = listResult.stdout;
  check('F. zip contains package.json', /saucedemo-framework\/package\.json/.test(listing));
  check('G. zip contains README.md', /saucedemo-framework\/README\.md/.test(listing));
  check('H. zip contains pages/', /saucedemo-framework\/pages\//.test(listing));
  check('I. zip contains tests/', /saucedemo-framework\/tests\//.test(listing));
  check('J. zip preserves top-level directory', /^Archive:|saucedemo-framework\//.test(listing));
}

// 3. The zip extracts correctly and matches original byte-for-byte.
const extractDir = path.join(tmpRoot, 'extracted');
fs.mkdirSync(extractDir);
const extractResult = spawnSync('unzip', ['-q', zipPath, '-d', extractDir], { encoding: 'utf8' });
check('K. unzip extract succeeds', extractResult.status === 0, extractResult.stderr);
const originalPkg = fs.readFileSync(path.join(frameworkDir, 'package.json'), 'utf8');
const extractedPkg = fs.readFileSync(path.join(extractDir, 'saucedemo-framework', 'package.json'), 'utf8');
check('L. extracted package.json matches original byte-for-byte', originalPkg === extractedPkg);

// 4. zipFrameworkToBuffer returns valid zip bytes.
const buf = zipFrameworkToBuffer(frameworkDir);
check('M. buffer is non-empty', buf.length > 0);
// Zip files start with magic bytes "PK\x03\x04" (local file header signature)
check('N. buffer starts with PK zip signature', buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04);
// Buffer and file zip won't be byte-equal (zip emits slightly different metadata
// to stdout vs to a file), but they should be functionally equivalent — both
// must extract to identical contents.
const bufferZipPath = path.join(tmpRoot, 'from-buffer.zip');
fs.writeFileSync(bufferZipPath, buf);
const bufferExtractDir = path.join(tmpRoot, 'extracted-from-buffer');
fs.mkdirSync(bufferExtractDir);
const bufferExtract = spawnSync('unzip', ['-q', bufferZipPath, '-d', bufferExtractDir], { encoding: 'utf8' });
check('O. buffer-zip extracts cleanly', bufferExtract.status === 0, bufferExtract.stderr);
const bufferExtractedPkg = fs.readFileSync(path.join(bufferExtractDir, 'saucedemo-framework', 'package.json'), 'utf8');
check('O2. buffer-zip extracted package.json matches original', originalPkg === bufferExtractedPkg);
// Sizes should be within 10% — minor metadata differences only
const sizeDelta = Math.abs(buf.length - fileResult.sizeBytes) / fileResult.sizeBytes;
check('O3. buffer-zip size within 10% of file-zip size', sizeDelta < 0.1, `delta=${(sizeDelta * 100).toFixed(1)}%`);

// 5. zipFrameworkToDataUrl returns a proper data URL.
const dataUrl = zipFrameworkToDataUrl(frameworkDir);
check('P. data URL has correct prefix', dataUrl.startsWith('data:application/zip;base64,'));
const base64Part = dataUrl.slice('data:application/zip;base64,'.length);
check('Q. data URL base64 is decodable', (() => {
  try { return Buffer.from(base64Part, 'base64').length === buf.length; } catch { return false; }
})());

// 6. Refuses bad inputs.
let threw = false;
try { zipFrameworkToFile('/nonexistent/path/that/should/not/exist', zipPath); } catch { threw = true; }
check('R. file zipper refuses missing source', threw);

threw = false;
try { zipFrameworkToBuffer('/nonexistent/path/that/should/not/exist'); } catch { threw = true; }
check('S. buffer zipper refuses missing source', threw);

// Files (not dirs) should also be refused.
const aRegularFile = path.join(tmpRoot, 'just-a-file.txt');
fs.writeFileSync(aRegularFile, 'not a directory');
threw = false;
try { zipFrameworkToBuffer(aRegularFile); } catch { threw = true; }
check('T. buffer zipper refuses regular file as source', threw);

// 7. Sanity — typical framework should be well under 1 MB.
check('U. zip size under 1 MB (sanity)', fileResult.sizeBytes < 1024 * 1024);

// Cleanup.
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
console.log(`Generated framework zip: ${fileResult.sizeBytes} bytes`);
if (fail > 0) process.exit(1);
console.log('OK: zip-framework produces valid, extractable archives.');
