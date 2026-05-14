import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Render the architecture diagrams to PNGs and (optionally) a frame sequence
 * for animation conversion.
 *
 * Outputs:
 *   docs/architecture.png        Polished architecture.html screenshot
 *   docs/architecture-svg.png    Bare architecture.svg
 *   docs/agent-flow.png          Bare agent-flow.svg (active mid-loop frame)
 *   docs/agent-flow-frames/      14 frames sampled across the 12s animation
 */

async function main() {
  const root = process.cwd();
  const browser = await chromium.launch();

  try {
    // 1. Architecture html screenshot
    {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.goto('file://' + path.join(root, 'docs/architecture.html'), { waitUntil: 'load', timeout: 15000 });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.screenshot({ path: path.join(root, 'docs/architecture.png'), fullPage: true });
      console.log('Wrote docs/architecture.png');
      await ctx.close();
    }

    // 2. architecture.svg
    await renderSvg(browser, path.join(root, 'docs/architecture.svg'), path.join(root, 'docs/architecture-svg.png'), 1400, 2000);

    // 3. agent-flow.svg (single still mid-animation)
    await renderSvg(browser, path.join(root, 'docs/agent-flow.svg'), path.join(root, 'docs/agent-flow.png'), 1400, 2200);

    // 4. agent-flow frame sequence for GIF conversion
    const framesDir = path.join(root, 'docs/agent-flow-frames');
    fs.mkdirSync(framesDir, { recursive: true });
    // Wipe old frames
    for (const f of fs.readdirSync(framesDir)) {
      if (f.endsWith('.png')) fs.unlinkSync(path.join(framesDir, f));
    }
    const totalDurationMs = 12000;
    const frameCount = 24;
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 2200 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const svg = fs.readFileSync(path.join(root, 'docs/agent-flow.svg'), 'utf8');
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#08080a}</style></head><body>${svg}</body></html>`,
      { waitUntil: 'load' },
    );
    // Pause CSS animations so we can scrub frame by frame.
    await page.addStyleTag({ content: `*, *::before, *::after { animation-play-state: paused !important; }` });

    for (let i = 0; i < frameCount; i++) {
      const t = (i / frameCount) * totalDurationMs;
      await page.evaluate((tMs) => {
        document.getAnimations().forEach((a) => { a.currentTime = tMs; });
      }, t);
      const out = path.join(framesDir, `frame-${String(i).padStart(2, '0')}.png`);
      await page.screenshot({ path: out, fullPage: true });
      if (i % 6 === 0) console.log(`  frame ${i + 1}/${frameCount}`);
    }
    await ctx.close();
    console.log(`Wrote ${frameCount} frames to ${path.relative(root, framesDir)}/`);
  } finally {
    await browser.close();
  }
}

async function renderSvg(browser: import('playwright').Browser, svgPath: string, outPath: string, w: number, h: number): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const svg = fs.readFileSync(svgPath, 'utf8');
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#08080a}</style></head><body>${svg}</body></html>`,
    { waitUntil: 'load' },
  );
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: outPath, fullPage: true });
  await ctx.close();
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
