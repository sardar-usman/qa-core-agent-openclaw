import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import { resolve as resolveSelector, type CascadeLevel } from './selectors.js';

/**
 * Self-healing selectors.
 *
 * Workflow:
 *
 *   1. Run the target spec with the Playwright JSON reporter.
 *   2. For each failed test whose error message looks like a selector miss
 *      (element-not-found, timeout, count assertion failure), grab the
 *      assertion's URL and the original selector call from the spec.
 *   3. Open the URL in a fresh browser, ask Claude (Sonnet by default) for
 *      a replacement intent + level + arg the cascade can resolve.
 *   4. Verify the new selector resolves to exactly one element.
 *   5. Rewrite the spec in place to <spec>.healed.<ext> with the new calls,
 *      annotating each heal with the confidence and the original call.
 *
 * Only assertion-style failures are healed. Logic failures (wrong text, wrong
 * URL) are left alone — they need a human.
 */

export interface HealOptions {
  specPath: string;
  model?: string;
  baseUrl?: string;
  /** Skip running Playwright — caller already has a JSON report. */
  reportPath?: string;
  onEvent?: (event: HealEvent) => void;
}

export type HealEvent =
  | { type: 'running_spec' }
  | { type: 'failures_found'; count: number }
  | { type: 'healing'; selector: string; url: string }
  | { type: 'healed'; old: string; new: string; level: CascadeLevel; confidence: number }
  | { type: 'unhealed'; reason: string; selector: string }
  | { type: 'done'; healedPath: string | null; healed: number; total: number };

export interface HealResult {
  healedPath: string | null;
  healed: number;
  total: number;
}

interface SelectorCall {
  raw: string;            // e.g. page.getByRole("button", { name: "Sign in" })
  level: CascadeLevel;
  arg: unknown;           // role+name object, or label string, etc.
  /** 1-indexed line in the spec where this call appears. */
  line: number;
  /** Column offset of the call within that line. */
  col: number;
}

interface FailureContext {
  testTitle: string;
  url: string;
  /** The error message Playwright produced. */
  error: string;
  /** Heuristically extracted selector call from the error stack. */
  selectorRaw?: string;
}

const SELECTOR_REGEXES = [
  /page\.getByRole\(([^)]+)\)/g,
  /page\.getByLabel\(([^)]+)\)/g,
  /page\.getByTestId\(([^)]+)\)/g,
  /page\.locator\(([^)]+)\)/g,
];

export async function heal(opts: HealOptions): Promise<HealResult> {
  const specPath = path.resolve(opts.specPath);
  if (!fs.existsSync(specPath)) throw new Error(`Spec not found: ${specPath}`);

  opts.onEvent?.({ type: 'running_spec' });
  const failures = opts.reportPath
    ? parseReport(opts.reportPath)
    : runAndParse(specPath, opts.baseUrl);

  opts.onEvent?.({ type: 'failures_found', count: failures.length });
  if (failures.length === 0) {
    return { healedPath: null, healed: 0, total: 0 };
  }

  // Extract every selector call in the spec, with line numbers.
  const specSrc = fs.readFileSync(specPath, 'utf8');
  const calls = extractSelectorCalls(specSrc);

  // For each failure, find the matching selector call and try to heal it.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  const model = opts.model ?? process.env.QA_CORE_MODEL_HEAL ?? 'claude-sonnet-4-6';
  const client = new Anthropic({ apiKey });

  let browser: Browser | undefined;
  const edits: Array<{ line: number; col: number; oldRaw: string; newRaw: string }> = [];
  try {
    browser = await chromium.launch({ headless: true });

    for (const failure of failures) {
      const call = matchFailureToCall(failure, calls);
      if (!call) {
        opts.onEvent?.({ type: 'unhealed', reason: 'no matching selector call in spec', selector: failure.selectorRaw ?? '' });
        continue;
      }

      opts.onEvent?.({ type: 'healing', selector: call.raw, url: failure.url });

      // Open fresh page, ask Claude for a replacement, verify it resolves.
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      try {
        await page.goto(failure.url, { waitUntil: 'domcontentloaded' });
        const proposal = await proposeNewSelector(client, model, {
          page, failure, oldCall: call,
        });
        if (!proposal) {
          opts.onEvent?.({ type: 'unhealed', reason: 'model declined to propose', selector: call.raw });
          continue;
        }

        // Validate: try to resolve, must hit exactly one element.
        const resolved = await resolveSelector(page, {
          intent: proposal.intent, role: proposal.role, label: proposal.label,
          testid: proposal.testid, css: proposal.css,
        });
        if (!resolved) {
          opts.onEvent?.({ type: 'unhealed', reason: 'proposal did not resolve on live page', selector: call.raw });
          continue;
        }

        const newRaw = emitPlaywrightCall(resolved.level, resolved.arg);
        edits.push({ line: call.line, col: call.col, oldRaw: call.raw, newRaw });
        opts.onEvent?.({ type: 'healed', old: call.raw, new: newRaw, level: resolved.level, confidence: proposal.confidence });
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser?.close();
  }

  if (edits.length === 0) {
    opts.onEvent?.({ type: 'done', healedPath: null, healed: 0, total: failures.length });
    return { healedPath: null, healed: 0, total: failures.length };
  }

  const healedPath = writeHealedSpec(specPath, specSrc, edits);
  opts.onEvent?.({ type: 'done', healedPath, healed: edits.length, total: failures.length });
  return { healedPath, healed: edits.length, total: failures.length };
}

/* ───── Playwright invocation ───── */

function runAndParse(specPath: string, baseUrl: string | undefined): FailureContext[] {
  const reportPath = path.join(path.dirname(specPath), '.heal-report.json');
  try {
    execSync(
      `npx playwright test "${specPath}" --reporter=json --project=chromium`,
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(baseUrl ? { QA_CORE_BASE_URL: baseUrl } : {}),
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    // Playwright exits non-zero when tests fail — expected.
  }
  return parseReport(reportPath);
}

function parseReport(reportPath: string): FailureContext[] {
  if (!fs.existsSync(reportPath)) return [];
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { return []; }
  const failures: FailureContext[] = [];
  const suites = (data as { suites?: unknown[] }).suites ?? [];
  walkSuites(suites, failures);
  return failures.filter(isSelectorMiss);
}

function walkSuites(suites: unknown[], out: FailureContext[]): void {
  for (const s of suites) {
    const suite = s as { specs?: unknown[]; suites?: unknown[] };
    if (suite.specs) {
      for (const spec of suite.specs) {
        const sp = spec as { title: string; tests?: unknown[] };
        for (const t of sp.tests ?? []) {
          const test = t as { results?: unknown[] };
          for (const r of test.results ?? []) {
            const result = r as { status?: string; error?: { message?: string; stack?: string }; errors?: Array<{ message?: string }> };
            if (result.status === 'failed' || result.status === 'timedOut') {
              const errMsg = result.error?.message ?? result.errors?.[0]?.message ?? '';
              const stack = result.error?.stack ?? '';
              out.push({
                testTitle: sp.title,
                url: extractUrlFromStack(stack) ?? '',
                error: errMsg,
                selectorRaw: extractSelectorFromError(errMsg + '\n' + stack),
              });
            }
          }
        }
      }
    }
    if (suite.suites) walkSuites(suite.suites, out);
  }
}

function isSelectorMiss(f: FailureContext): boolean {
  const e = f.error.toLowerCase();
  return e.includes('locator') || e.includes('not found') || e.includes('timeout') ||
         e.includes('expected to be visible') || e.includes('expected count');
}

function extractUrlFromStack(stack: string): string | null {
  const m = stack.match(/page\.goto\(['"`](https?:\/\/[^'"`]+)['"`]/);
  return m && m[1] ? m[1] : null;
}

function extractSelectorFromError(text: string): string | undefined {
  const m = text.match(/(page\.(?:getByRole|getByLabel|getByTestId|locator)\([^)]+\))/);
  return m ? m[1] : undefined;
}

/* ───── Spec parsing ───── */

function extractSelectorCalls(src: string): SelectorCall[] {
  const calls: SelectorCall[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const re of SELECTOR_REGEXES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const raw = m[0];
        const args = m[1] ?? '';
        const level: CascadeLevel = raw.includes('getByRole')   ? 'role'
                                  : raw.includes('getByLabel')  ? 'label'
                                  : raw.includes('getByTestId') ? 'testid'
                                  :                                'css';
        calls.push({ raw, level, arg: args, line: i + 1, col: m.index });
      }
    }
  }
  return calls;
}

function matchFailureToCall(f: FailureContext, calls: SelectorCall[]): SelectorCall | null {
  if (!f.selectorRaw) return null;
  return calls.find((c) => c.raw === f.selectorRaw) ?? null;
}

/* ───── Proposal call ───── */

interface HealProposal {
  intent: string;
  role?: string;
  label?: string;
  testid?: string;
  css?: string;
  /** Model's confidence 0..1. */
  confidence: number;
}

const PROPOSER_SYSTEM = `You are a selector healer. A Playwright test selector stopped working because the page changed. You will be given:
  - The original failing selector call.
  - A snapshot of the visible interactive elements on the live page.

Your job: propose a replacement that matches the ORIGINAL INTENT. Prefer role+name; fall back to label; then testid; then CSS as last resort.

Return strictly:

<intent>short description of what the element is, e.g. "submit button"</intent>
<role>aria role if applicable, otherwise empty</role>
<label>visible label text if applicable, otherwise empty</label>
<testid>data-testid if you see one, otherwise empty</testid>
<css>CSS selector ONLY if nothing else fits, otherwise empty</css>
<confidence>0.0 to 1.0</confidence>

If no good replacement is visible, return <confidence>0.0</confidence> and leave the other tags empty.`;

async function proposeNewSelector(
  client: Anthropic,
  model: string,
  args: { page: Page; failure: FailureContext; oldCall: SelectorCall },
): Promise<HealProposal | null> {
  const snapshot = await args.page.evaluate(() => {
    const pick = (el: Element) => {
      const r = el as HTMLElement;
      const text = (r.getAttribute('aria-label') ?? r.getAttribute('placeholder') ?? r.getAttribute('name') ?? (r.textContent ?? '').trim().slice(0, 60)) || undefined;
      return {
        tag: r.tagName.toLowerCase(),
        role: r.getAttribute('role') ?? undefined,
        label: text,
        testid: r.getAttribute('data-testid') ?? undefined,
        type: (r as HTMLInputElement).type ?? undefined,
      };
    };
    return {
      inputs:  Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 40).map(pick),
      buttons: Array.from(document.querySelectorAll('button, [role="button"], [type="submit"]')).slice(0, 40).map(pick),
      links:   Array.from(document.querySelectorAll('a[href]')).slice(0, 30).map(pick),
    };
  });

  const response = await client.messages.create({
    model,
    max_tokens: 700,
    system: [{ type: 'text', text: PROPOSER_SYSTEM, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam],
    messages: [
      {
        role: 'user',
        content: `Original failing call:\n  ${args.oldCall.raw}\n\nFailure message:\n  ${args.failure.error.slice(0, 400)}\n\nLive page elements:\n${JSON.stringify(snapshot, null, 2)}`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text).join('\n');

  const get = (tag: string): string => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
    return m && m[1] ? m[1].trim() : '';
  };

  const confidence = parseFloat(get('confidence') || '0');
  if (!isFinite(confidence) || confidence < 0.4) return null;
  const intent = get('intent') || 'element';
  return {
    intent,
    role:   get('role')   || undefined,
    label:  get('label')  || undefined,
    testid: get('testid') || undefined,
    css:    get('css')    || undefined,
    confidence,
  };
}

/* ───── Emit + write ───── */

function emitPlaywrightCall(level: CascadeLevel, arg: unknown): string {
  switch (level) {
    case 'role': {
      const a = arg as { role: string; name: string };
      return `page.getByRole(${JSON.stringify(a.role)}, { name: ${JSON.stringify(a.name)} })`;
    }
    case 'label':  return `page.getByLabel(${JSON.stringify(arg as string)})`;
    case 'testid': return `page.getByTestId(${JSON.stringify(arg as string)})`;
    case 'css':    return `page.locator(${JSON.stringify(arg as string)})`;
  }
}

function writeHealedSpec(
  specPath: string, src: string,
  edits: Array<{ line: number; col: number; oldRaw: string; newRaw: string }>,
): string {
  const lines = src.split('\n');
  // Apply right-to-left within each line to keep column offsets valid.
  const byLine = new Map<number, Array<{ col: number; oldRaw: string; newRaw: string }>>();
  for (const e of edits) {
    const list = byLine.get(e.line) ?? [];
    list.push(e);
    byLine.set(e.line, list);
  }
  for (const [lineNum, list] of byLine) {
    list.sort((a, b) => b.col - a.col);
    let line = lines[lineNum - 1] ?? '';
    for (const e of list) {
      line = line.slice(0, e.col) +
             `/* qa-core: healed (was ${e.oldRaw.replace(/\*\//g, '*\\/')}) */ ${e.newRaw}` +
             line.slice(e.col + e.oldRaw.length);
    }
    lines[lineNum - 1] = line;
  }
  const ext = path.extname(specPath);
  const base = specPath.slice(0, -ext.length);
  const healedPath = `${base}.healed${ext}`;
  fs.writeFileSync(healedPath, lines.join('\n'));
  return healedPath;
}
