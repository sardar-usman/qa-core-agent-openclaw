import 'dotenv/config';
import path from 'node:path';
import { heal } from '../agent/heal.js';

/**
 * CLI:  npm run heal -- <spec-path> [--base-url <url>] [--dry-run]
 *
 * Opens the live page the spec targets, probes every locator, and re-resolves
 * the broken ones against the page with the same locator ladder the Explorer
 * uses. Repaired files are written back in place (use --dry-run to preview).
 */

function parseArgs(argv: string[]): { specPath: string; baseUrl?: string; write: boolean } {
  const args = argv.slice(2);
  let specPath: string | undefined;
  let baseUrl: string | undefined;
  let write = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--base-url') baseUrl = args[++i];
    else if (a === '--dry-run') write = false;
    else if (a && !a.startsWith('--') && !specPath) specPath = a;
  }
  if (!specPath) {
    console.error('Usage: npm run heal -- <spec-path> [--base-url https://...] [--dry-run]');
    process.exit(1);
  }
  return { specPath, baseUrl, write };
}

async function main(): Promise<void> {
  const { specPath, baseUrl, write } = parseArgs(process.argv);

  console.log(`▸ Healing ${specPath}${write ? '' : '  (dry run — no files written)'}`);
  console.log('');

  const result = await heal({
    specPath, baseUrl, write,
    onEvent: (e) => {
      switch (e.type) {
        case 'scanned':      console.log(`  · scanned ${e.total} locator(s) across ${e.files} file(s)`); break;
        case 'opened_page':  console.log(`  · opened ${e.url}`); break;
        case 'healing':      console.log(`  → broken: ${e.selector}`); break;
        case 'healed':       console.log(`    ✓ healed → ${e.new}  (level=${e.level}, ${e.file})`); break;
        case 'unhealed':     console.log(`    ✗ unhealable: ${e.selector}\n        ${e.reason} (${e.file})`); break;
        case 'done':         break;
      }
    },
  });

  console.log('');
  console.log(`Report: ${result.intact} intact · ${result.healed.length} healed · ${result.unhealable.length} unhealable (of ${result.scanned} scanned)`);
  if (result.healed.length) {
    console.log('\nHealed:');
    for (const h of result.healed) console.log(`  • ${path.relative(process.cwd(), h.file)}\n      was: ${h.old}\n      now: ${h.new}`);
  }
  if (result.unhealable.length) {
    console.log('\nUnhealable (reported, left unchanged):');
    for (const u of result.unhealable) console.log(`  • ${path.relative(process.cwd(), u.file)}: ${u.selector}\n      ${u.reason}`);
  }
  if (result.filesWritten.length) {
    console.log('\nWrote:');
    for (const f of result.filesWritten) console.log(`  ${path.relative(process.cwd(), f)}`);
  } else if (result.healed.length) {
    console.log('\n(dry run — nothing written)');
  } else {
    console.log('\nNothing to heal.');
  }
}

main().catch((err) => {
  console.error('\n✗ Healing failed:', err.message);
  process.exit(1);
});
