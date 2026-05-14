import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { transcribePOM } from '../src/agent/pom.js';
import type { RunReport } from '../src/agent/trace.js';

/**
 * Quick validation: re-emit the POM framework from a run-report.json that
 * already exists on disk. No API calls, no browser, just exercises the emitter.
 */

const reportPath = process.argv[2];
if (!reportPath || !fs.existsSync(reportPath)) {
  console.error('Usage: tsx scripts/test-pom.ts <path-to-run-report.json>');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as RunReport;
const outDir = path.join(path.dirname(reportPath), 'pom-test');
fs.mkdirSync(outDir, { recursive: true });

const result = transcribePOM({ report, outDir, name: 'replay' });

console.log(`Wrote POM framework under ${outDir}/`);
console.log(`  pages: ${result.pageFiles.length}`);
console.log(`  spec : ${path.basename(result.specFile)}`);
console.log(`  a11y : ${path.basename(result.a11yFile)}`);
console.log('');
for (const pf of result.pageFiles) {
  console.log('--- ' + path.basename(pf) + ' ---');
  console.log(fs.readFileSync(pf, 'utf8'));
  console.log('');
}
console.log('--- spec ---');
console.log(fs.readFileSync(result.specFile, 'utf8'));
