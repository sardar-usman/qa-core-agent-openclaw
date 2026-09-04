import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { generateFromStory } from '../agent/generate.js';
import { buildRequirementsMap, countRules, loadSrsText, type RequirementsMap } from '../agent/requirements.js';

/**
 * CLI:  npm run generate -- "<story>" [--lang ts|js] [--base-url <url>] [--out <dir>] [--srs <file>]
 *
 * Single-shot story → spec. The spec is marked UNVERIFIED — run it before trusting it.
 * With --srs, the requirements document is converted to a rules map that is
 * injected as context, so the generated tests verify the documented constraints.
 */

function parseArgs(argv: string[]): {
  story: string; lang: 'ts' | 'js'; baseUrl?: string; outBase?: string; srs?: string;
} {
  const args = argv.slice(2);
  let lang: 'ts' | 'js' = 'ts';
  let baseUrl: string | undefined;
  let outBase: string | undefined;
  let srs: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--lang') { const v = args[++i]; lang = (v === 'js' ? 'js' : 'ts'); }
    else if (a === '--base-url') baseUrl = args[++i];
    else if (a === '--out') outBase = args[++i];
    else if (a === '--srs') {
      srs = args[++i];
      if (!srs) {
        console.error('✗ --srs expects a file path (.md, .txt, .pdf, or .docx)');
        process.exit(1);
      }
    }
    else if (a) positional.push(a);
  }
  const story = positional.join(' ').trim();
  if (!story) {
    console.error('Usage: npm run generate -- "<user story>" [--lang ts|js] [--base-url https://...] [--out dir] [--srs requirements.md]');
    process.exit(1);
  }
  return { story, lang, baseUrl, outBase, srs };
}

function runId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main(): Promise<void> {
  const { story, lang, baseUrl, outBase, srs } = parseArgs(process.argv);
  const base = outBase ?? path.join(process.cwd(), 'output');
  const id = `${runId()}-generate`;
  const outDir = path.join(base, id);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`▸ Generating spec from story`);
  console.log(`  language: ${lang}`);
  console.log(`  output:   ${path.relative(process.cwd(), outDir)}\n`);

  let requirements: RequirementsMap | undefined;
  if (srs) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('✗ --srs needs ANTHROPIC_API_KEY set (the requirements map is built with a Haiku call).');
      process.exit(1);
    }
    const { text, truncated } = await loadSrsText(srs);
    const built = await buildRequirementsMap({ srsText: text, truncated, apiKey });
    requirements = built.map;
    console.log(`  SRS: ${requirements.features.length} feature(s), ${countRules(requirements)} rule(s) · $${built.costUsd.toFixed(4)}${requirements.truncated ? ' · truncated at cap' : ''}\n`);
  }

  const { feature, scenarios, spec } = await generateFromStory({ story, language: lang, baseUrl, requirements });
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
