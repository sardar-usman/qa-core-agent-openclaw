import 'dotenv/config';
import path from 'node:path';
import { heal } from '../agent/heal.js';

/**
 * CLI:  npm run heal -- <spec-path> [--base-url <url>] [--report <existing-json>]
 *
 * Runs the spec, finds failures, re-resolves selectors against the live page,
 * and writes <spec>.healed.<ext> with the patched calls.
 */

function parseArgs(argv: string[]): { specPath: string; baseUrl?: string; reportPath?: string } {
  const args = argv.slice(2);
  let specPath: string | undefined;
  let baseUrl: string | undefined;
  let reportPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--base-url') baseUrl = args[++i];
    else if (a === '--report') reportPath = args[++i];
    else if (a && !specPath) specPath = a;
  }
  if (!specPath) {
    console.error('Usage: npm run heal -- <spec-path> [--base-url https://...] [--report path/to/results.json]');
    process.exit(1);
  }
  return { specPath, baseUrl, reportPath };
}

async function main(): Promise<void> {
  const { specPath, baseUrl, reportPath } = parseArgs(process.argv);

  console.log(`▸ Healing ${specPath}`);
  console.log('');

  const result = await heal({
    specPath, baseUrl, reportPath,
    onEvent: (e) => {
      switch (e.type) {
        case 'running_spec':    console.log('  · running spec to find failures…'); break;
        case 'failures_found':  console.log(`  · ${e.count} selector-style failure(s) detected`); break;
        case 'healing':         console.log(`  → healing ${e.selector}`); break;
        case 'healed':          console.log(`    ✓ ${e.old}\n      → ${e.new}\n      level=${e.level}  confidence=${e.confidence.toFixed(2)}`); break;
        case 'unhealed':        console.log(`    ✗ ${e.selector}  (${e.reason})`); break;
        case 'done':            console.log(`\n${e.healed}/${e.total} healed`); break;
      }
    },
  });

  if (result.healedPath) {
    console.log(`\nWrote ${path.relative(process.cwd(), result.healedPath)}`);
    console.log(`\nRun: npx playwright test ${path.relative(process.cwd(), result.healedPath)}`);
  } else {
    console.log('\nNothing to heal.');
  }
}

main().catch((err) => {
  console.error('\n✗ Healing failed:', err.message);
  process.exit(1);
});
