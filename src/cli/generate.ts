import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { generateFromStory } from '../agent/generate.js';

/**
 * CLI:  npm run generate -- "<story>" [--lang ts|js] [--base-url <url>] [--out <dir>]
 *
 * Single-shot story → spec. The spec is marked UNVERIFIED — run it before trusting it.
 */

function parseArgs(argv: string[]): {
  story: string; lang: 'ts' | 'js'; baseUrl?: string; outBase?: string;
} {
  const args = argv.slice(2);
  let lang: 'ts' | 'js' = 'ts';
  let baseUrl: string | undefined;
  let outBase: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--lang') { const v = args[++i]; lang = (v === 'js' ? 'js' : 'ts'); }
    else if (a === '--base-url') baseUrl = args[++i];
    else if (a === '--out') outBase = args[++i];
    else if (a) positional.push(a);
  }
  const story = positional.join(' ').trim();
  if (!story) {
    console.error('Usage: npm run generate -- "<user story>" [--lang ts|js] [--base-url https://...] [--out dir]');
    process.exit(1);
  }
  return { story, lang, baseUrl, outBase };
}

function runId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main(): Promise<void> {
  const { story, lang, baseUrl, outBase } = parseArgs(process.argv);
  const base = outBase ?? path.join(process.cwd(), 'output');
  const id = `${runId()}-generate`;
  const outDir = path.join(base, id);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`▸ Generating spec from story`);
  console.log(`  language: ${lang}`);
  console.log(`  output:   ${path.relative(process.cwd(), outDir)}\n`);

  const { feature, scenarios, spec } = await generateFromStory({ story, language: lang, baseUrl });
  const file = `${slug(feature)}.spec.${lang}`;
  const specPath = path.join(outDir, file);

  const header = lang === 'ts'
    ? `// UNVERIFIED — generated from a user story without browser execution.\n// Run \`npx playwright test\` against it before trusting the output.\n\n`
    : `// UNVERIFIED — generated from a user story without browser execution.\n// Run \`npx playwright test\` against it before trusting the output.\n\n`;

  fs.writeFileSync(specPath, header + spec + (spec.endsWith('\n') ? '' : '\n'));
  console.log(`✓ ${scenarios} scenario(s) — wrote ${path.relative(process.cwd(), specPath)}`);
  console.log(`\nRun: npx playwright test ${path.relative(process.cwd(), specPath)}`);
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase() || 'feature';
}

main().catch((err) => {
  console.error('\n✗ Generation failed:', err.message);
  process.exit(1);
});
