import fs from 'node:fs';
import path from 'node:path';
import { emitLocatorCall, type CascadeLevel } from './selectors.js';
import type { Assertion, RunReport, Scenario, SelectorRecord, TraceStep } from './trace.js';

/**
 * Page Object Model emitter.
 *
 * Takes the verified RunReport and produces a real Playwright framework:
 *
 *   output/<run-id>/
 *     pages/
 *       BasePage.ts                    base class with goto + waitReady helpers
 *       <FeaturePage>.ts               one per detected logical page
 *     tests/
 *       <feature>.spec.ts              spec using the page objects
 *     a11y/
 *       landing.a11y.spec.ts           auto-injected accessibility check
 *     run-report.json                  same as before
 *
 * Design rules:
 *   - Locators that appear in 2+ scenarios get hoisted into a class field.
 *   - Common step sequences (e.g. fill+fill+click) get synthesized as action
 *     methods on the page class (e.g. `loginAs(user, pass)`).
 *   - One page object per distinct URL pathname. The hostname becomes the
 *     suite title; the pathname segment becomes the page class name.
 *   - When the trace has only one scenario, we still emit POM (the user picked
 *     this mode explicitly), but with a minimal page class.
 */

export interface POMTranscribeOptions {
  report: RunReport;
  outDir: string;
  /** Filename root for the generated spec (no extension). */
  name: string;
}

export interface POMTranscribeResult {
  rootDir: string;
  pageFiles: string[];
  specFile: string;
  a11yFile: string;
  scenarios: number;
}

/* ───────────────────────── Entry point ───────────────────────── */

export function transcribePOM(opts: POMTranscribeOptions): POMTranscribeResult {
  const { report, outDir, name } = opts;
  fs.mkdirSync(path.join(outDir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'a11y'),  { recursive: true });

  const ext = report.language;
  const pageGroups = groupScenariosByPage(report);
  const pageClasses = pageGroups.map((pg) => buildPageClass(pg, report.language));

  // Emit BasePage.
  const baseFile = path.join(outDir, 'pages', `BasePage.${ext}`);
  fs.writeFileSync(baseFile, renderBasePage(ext));

  // Emit per-page classes.
  const pageFiles: string[] = [baseFile];
  for (const pc of pageClasses) {
    const file = path.join(outDir, 'pages', `${pc.className}.${ext}`);
    fs.writeFileSync(file, renderPageClass(pc, ext));
    pageFiles.push(file);
  }

  // Emit spec that uses them.
  const specFile = path.join(outDir, 'tests', `${name}.spec.${ext}`);
  fs.writeFileSync(specFile, renderSpec(report, pageClasses, ext));

  // Emit a11y test as its own file.
  const a11yFile = path.join(outDir, 'a11y', `landing.a11y.spec.${ext}`);
  fs.writeFileSync(a11yFile, renderA11ySpec(report.url, ext));

  return {
    rootDir: outDir,
    pageFiles,
    specFile,
    a11yFile,
    scenarios: report.scenarios.length,
  };
}

/* ───────────────────────── Page grouping ───────────────────────── */

interface PageGroup {
  /** Logical key: hostname + first path segment. */
  key: string;
  /** Display name for the page (used in PascalCase class name). */
  label: string;
  className: string;
  url: string;
  /** Scenarios whose actions occur primarily on this page. */
  scenarios: Scenario[];
}

interface SelectorUsage {
  /** Original intent (e.g. "username input"). Stable identity for a locator. */
  intent: string;
  level: CascadeLevel;
  arg: SelectorRecord['arg'];
  /** Count across all scenarios on this page. */
  uses: number;
}

interface PageClassPlan {
  className: string;
  url: string;
  /** Locators promoted to class fields. */
  fields: Array<{ name: string; record: SelectorRecord }>;
  /** Map from a locator's intent to its field name on the class. */
  intentToField: Map<string, string>;
  /** Synthesized action methods (e.g. loginAs(user, pass)). */
  methods: ActionMethod[];
  /** Scenarios that belong on this page. */
  scenarios: Scenario[];
}

interface ActionMethod {
  /** camelCase method name. */
  name: string;
  /** Ordered list of parameters (typed string). */
  params: Array<{ name: string; type: string }>;
  /** Steps the method replaces, in order. Each refers to a record on the page. */
  steps: TraceStep[];
  /** Original signature for matching when rewriting scenarios. */
  signatureKey: string;
}

function groupScenariosByPage(report: RunReport): PageGroup[] {
  // For each scenario, find the navigation step (if any) to assign it to a page.
  // If a scenario has no navigate, attribute it to the run's URL.
  const groups = new Map<string, PageGroup>();
  for (const scenario of report.scenarios) {
    const url = pickPageUrl(scenario, report.url);
    const key = pageKey(url);
    const label = pageLabel(url);
    const className = pageClassName(url);
    const existing = groups.get(key);
    if (existing) {
      existing.scenarios.push(scenario);
    } else {
      groups.set(key, { key, label, className, url, scenarios: [scenario] });
    }
  }
  return [...groups.values()];
}

function pickPageUrl(scenario: Scenario, fallback: string): string {
  for (const step of scenario.steps) {
    if (step.kind === 'navigate') return step.url;
  }
  return fallback;
}

function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.split('/').slice(0, 2).join('/')}`;
  } catch {
    return url;
  }
}

function pageLabel(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
    if (seg) return seg.replace(/[-_.]+/g, ' ');
    // No path segment, so derive from the host. e.g. www.saucedemo.com → "saucedemo".
    return u.host.replace(/^www\./, '').split('.')[0] ?? u.host;
  } catch {
    return 'page';
  }
}

function pageClassName(url: string): string {
  const raw = pageLabel(url);
  const cleaned = raw.replace(/[^a-zA-Z0-9 ]+/g, ' ').trim();
  const camel = cleaned
    .split(/\s+/)
    .map((w) => w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : '')
    .join('');
  return (camel || 'Landing') + 'Page';
}

/* ───────────────────────── Selector + action analysis ───────────────────────── */

function buildPageClass(group: PageGroup, _lang: 'ts' | 'js'): PageClassPlan {
  // Collect selector usage across all scenarios for this page.
  // Dedup is case- and noise-word-insensitive: "Username", "username",
  // "username input", and "the Username field" all collapse to one locator.
  const usage = new Map<string, SelectorUsage>();
  for (const scenario of group.scenarios) {
    for (const step of scenario.steps) {
      const target = stepTarget(step);
      if (!target) continue;
      const key = canonicalIntent(target.intent);
      const cur = usage.get(key);
      if (cur) {
        cur.uses += 1;
      } else {
        usage.set(key, { intent: target.intent, level: target.level, arg: target.arg, uses: 1 });
      }
    }
  }

  // Promote any locator used 2+ times to a class field.
  // Locators used exactly once are still promoted so the spec stays clean;
  // the marginal cost is one field declaration.
  const fields: PageClassPlan['fields'] = [];
  const intentToField = new Map<string, string>();
  for (const u of usage.values()) {
    const name = fieldName(u.intent, intentToField);
    fields.push({
      name,
      record: { level: u.level, arg: u.arg, intent: u.intent },
    });
    intentToField.set(canonicalIntent(u.intent), name);
  }
  // Sort fields by name for stable output.
  fields.sort((a, b) => a.name.localeCompare(b.name));

  // Synthesize action methods from common step sequences.
  const methods = synthesizeMethods(group.scenarios, intentToField);

  return {
    className: group.className,
    url: group.url,
    fields,
    intentToField,
    methods,
    scenarios: group.scenarios,
  };
}

/**
 * Normalize an intent string for dedup. Lowercases, strips trailing noise words
 * (input/field/control), and squashes whitespace. So "Username", "username",
 * "Username Input", and "username field" all become the same key.
 */
function canonicalIntent(intent: string): string {
  const NOISE = new Set(['input', 'field', 'control', 'box', 'the', 'a', 'an']);
  return intent
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w))
    .join(' ')
    .trim() || intent.toLowerCase().trim();
}

function stepTarget(step: TraceStep): SelectorRecord | null {
  if (step.kind === 'click' || step.kind === 'fill' || step.kind === 'press') return step.target;
  if (step.kind === 'assert') {
    const a = step.assertion;
    if ('target' in a) return a.target;
  }
  return null;
}

function fieldName(intent: string, taken: Map<string, string>): string {
  // username input → username
  // login button → loginButton
  // error message → errorMessage
  const words = intent.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/);
  if (words.length === 0) return 'element';
  // Drop trailing noise words.
  const noise = new Set(['input', 'field', 'control']);
  const meaningful = words.filter((w, i) => !(i === words.length - 1 && noise.has(w)));
  const useWords = meaningful.length > 0 ? meaningful : words;
  let name = useWords
    .map((w, i) => i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))
    .join('');
  if (/^[0-9]/.test(name)) name = '_' + name;
  if (!name) name = 'element';
  // Disambiguate collisions.
  if ([...taken.values()].includes(name)) {
    let n = 2;
    while ([...taken.values()].includes(name + n)) n++;
    name = name + n;
  }
  return name;
}

/**
 * Look for a "fill + fill + click" sequence that appears at the top of 2+
 * scenarios. When found, synthesize a single action method. This handles the
 * canonical login flow cleanly without trying to be too clever for v1.
 */
function synthesizeMethods(scenarios: Scenario[], intentToField: Map<string, string>): ActionMethod[] {
  const methods: ActionMethod[] = [];
  const seenSignatures = new Set<string>();

  for (const scenario of scenarios) {
    // Find leading sequence of fill/click steps for this scenario.
    const lead: TraceStep[] = [];
    for (const step of scenario.steps) {
      if (step.kind === 'navigate' || step.kind === 'wait' || step.kind === 'checkpoint') continue;
      if (step.kind === 'fill' || step.kind === 'click' || step.kind === 'press') {
        lead.push(step);
      } else break;
    }
    // We only synthesize when there are 2+ steps (a meaningful sequence) and at
    // least one fill (so it carries data).
    if (lead.length < 2 || !lead.some((s) => s.kind === 'fill')) continue;

    const sig = lead.map(stepSignature).join('|');
    if (seenSignatures.has(sig)) continue;

    // Does this signature appear in another scenario?
    let occurrences = 0;
    for (const other of scenarios) {
      const otherLead: TraceStep[] = [];
      for (const step of other.steps) {
        if (step.kind === 'navigate' || step.kind === 'wait' || step.kind === 'checkpoint') continue;
        if (step.kind === 'fill' || step.kind === 'click' || step.kind === 'press') otherLead.push(step);
        else break;
      }
      const otherSig = otherLead.map(stepSignature).join('|');
      if (otherSig === sig) occurrences++;
    }
    if (occurrences < 2) continue;

    seenSignatures.add(sig);
    methods.push(buildMethodFromLead(lead, intentToField, sig));
  }

  return methods;
}

function stepSignature(step: TraceStep): string {
  if (step.kind === 'fill')  return `fill:${canonicalIntent(step.target.intent)}`;
  if (step.kind === 'click') return `click:${canonicalIntent(step.target.intent)}`;
  if (step.kind === 'press') return `press:${canonicalIntent(step.target.intent)}:${step.key}`;
  return '';
}

function buildMethodFromLead(lead: TraceStep[], intentToField: Map<string, string>, signatureKey: string): ActionMethod {
  // Derive a method name from the leading sequence.
  // Heuristic: if there are 2 fills + 1 click, name it after the click target
  // (most often "login button" → loginAs). Otherwise, "<click intent>".
  const fills = lead.filter((s) => s.kind === 'fill');
  const click = lead.find((s) => s.kind === 'click');
  let methodName = 'submit';
  if (click && click.kind === 'click') {
    const word = canonicalIntent(click.target.intent).replace(/\bbutton\b|\blink\b/g, '').trim().split(/\s+/)[0] ?? 'submit';
    methodName = word + (fills.length >= 2 ? 'As' : '');
  }

  // Parameters: one per fill, named after the field (deduped).
  const params: ActionMethod['params'] = [];
  const usedNames = new Set<string>();
  for (const f of fills) {
    if (f.kind !== 'fill') continue;
    let p = (intentToField.get(canonicalIntent(f.target.intent)) || 'value').replace(/^the_?/, '');
    if (usedNames.has(p)) {
      let n = 2; while (usedNames.has(p + n)) n++;
      p = p + n;
    }
    usedNames.add(p);
    params.push({ name: p, type: 'string' });
  }

  return { name: methodName, params, steps: lead, signatureKey };
}

/* ───────────────────────── Emit ───────────────────────── */

function renderBasePage(ext: 'ts' | 'js'): string {
  if (ext === 'ts') {
    return [
      `import { type Page, expect } from '@playwright/test';`,
      ``,
      `/** Base class for every page object. Shared navigation + wait helpers. */`,
      `export abstract class BasePage {`,
      `  protected constructor(protected readonly page: Page) {}`,
      `  abstract readonly url: string;`,
      ``,
      `  async goto(): Promise<void> {`,
      `    await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });`,
      `  }`,
      ``,
      `  async waitReady(): Promise<void> {`,
      `    await this.page.waitForLoadState('networkidle').catch(() => undefined);`,
      `  }`,
      ``,
      `  async expectVisible(locator: import('@playwright/test').Locator): Promise<void> {`,
      `    await expect(locator).toBeVisible();`,
      `  }`,
      `}`,
      ``,
    ].join('\n');
  }
  return [
    `const { expect } = require('@playwright/test');`,
    ``,
    `class BasePage {`,
    `  constructor(page) {`,
    `    this.page = page;`,
    `  }`,
    `  async goto() {`,
    `    await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });`,
    `  }`,
    `  async waitReady() {`,
    `    await this.page.waitForLoadState('networkidle').catch(() => undefined);`,
    `  }`,
    `  async expectVisible(locator) {`,
    `    await expect(locator).toBeVisible();`,
    `  }`,
    `}`,
    `module.exports = { BasePage };`,
    ``,
  ].join('\n');
}

function renderPageClass(plan: PageClassPlan, ext: 'ts' | 'js'): string {
  if (ext === 'ts') {
    const out: string[] = [];
    out.push(`import { type Page, type Locator } from '@playwright/test';`);
    out.push(`import { BasePage } from './BasePage';`);
    out.push(``);
    out.push(`/** Page object for ${q(plan.url)}. Auto-generated from a verified browser session. */`);
    out.push(`export class ${plan.className} extends BasePage {`);
    out.push(`  readonly url = ${q(plan.url)};`);
    for (const f of plan.fields) {
      out.push(`  readonly ${f.name}: Locator;`);
    }
    out.push(``);
    out.push(`  constructor(page: Page) {`);
    out.push(`    super(page);`);
    for (const f of plan.fields) {
      out.push(`    this.${f.name} = ${emitLocatorCall(f.record.level, f.record.arg, f.record.ambiguous === true)};`);
    }
    out.push(`  }`);
    for (const m of plan.methods) {
      out.push(``);
      out.push(...emitMethod(m, plan.intentToField, ext).map((l) => '  ' + l));
    }
    out.push(`}`);
    out.push(``);
    return out.join('\n');
  }
  // JS variant
  const out: string[] = [];
  out.push(`const { BasePage } = require('./BasePage');`);
  out.push(``);
  out.push(`class ${plan.className} extends BasePage {`);
  out.push(`  constructor(page) {`);
  out.push(`    super(page);`);
  out.push(`    this.url = ${q(plan.url)};`);
  for (const f of plan.fields) {
    out.push(`    this.${f.name} = ${emitLocatorCall(f.record.level, f.record.arg, f.record.ambiguous === true)};`);
  }
  out.push(`  }`);
  for (const m of plan.methods) {
    out.push(``);
    out.push(...emitMethod(m, plan.intentToField, ext).map((l) => '  ' + l));
  }
  out.push(`}`);
  out.push(`module.exports = { ${plan.className} };`);
  out.push(``);
  return out.join('\n');
}

function emitMethod(method: ActionMethod, intentToField: Map<string, string>, ext: 'ts' | 'js'): string[] {
  const paramList = method.params.map((p) => ext === 'ts' ? `${p.name}: ${p.type}` : p.name).join(', ');
  const sig = ext === 'ts'
    ? `async ${method.name}(${paramList}): Promise<void> {`
    : `async ${method.name}(${paramList}) {`;
  const body: string[] = [];
  let paramIdx = 0;
  for (const step of method.steps) {
    if (step.kind === 'fill') {
      const field = intentToField.get(canonicalIntent(step.target.intent));
      const valueArg = method.params[paramIdx]?.name ?? q(step.value);
      paramIdx++;
      body.push(field
        ? `await this.${field}.fill(${valueArg});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true)}.fill(${valueArg});`);
    } else if (step.kind === 'click') {
      const field = intentToField.get(canonicalIntent(step.target.intent));
      body.push(field
        ? `await this.${field}.click();`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true)}.click();`);
    } else if (step.kind === 'press') {
      const field = intentToField.get(canonicalIntent(step.target.intent));
      body.push(field
        ? `await this.${field}.press(${q(step.key)});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true)}.press(${q(step.key)});`);
    }
  }
  return [sig, ...body.map((l) => '  ' + l), `}`];
}

function renderSpec(report: RunReport, pageClasses: PageClassPlan[], ext: 'ts' | 'js'): string {
  const out: string[] = [];
  if (ext === 'ts') {
    out.push(`import { test, expect } from '@playwright/test';`);
    for (const pc of pageClasses) {
      out.push(`import { ${pc.className} } from '../pages/${pc.className}';`);
    }
  } else {
    out.push(`const { test, expect } = require('@playwright/test');`);
    for (const pc of pageClasses) {
      out.push(`const { ${pc.className} } = require('../pages/${pc.className}');`);
    }
  }
  out.push(``);
  out.push(`/* Auto-generated by QA-Core. Source URL: ${report.url}`);
  out.push(` * Verified live before transcription.`);
  out.push(` * Page Object Model framework: see ./pages/ for class definitions.`);
  out.push(` */`);
  out.push(``);
  out.push(`test.describe(${q(titleFromUrl(report.url))}, () => {`);

  // Instantiate each page object in beforeEach.
  if (ext === 'ts') {
    for (const pc of pageClasses) {
      out.push(`  let ${camelize(pc.className)}: ${pc.className};`);
    }
  } else {
    for (const pc of pageClasses) {
      out.push(`  let ${camelize(pc.className)};`);
    }
  }
  out.push('');
  out.push(`  test.beforeEach(async ({ context, page }) => {`);
  // Per-test isolation: matches the agent's exploration-time isolation.
  out.push(`    await context.clearCookies();`);
  out.push(`    try { await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); } catch { /* about:blank */ }`);
  for (const pc of pageClasses) {
    out.push(`    ${camelize(pc.className)} = new ${pc.className}(page);`);
  }
  // Navigate to the primary page (first one in pageClasses).
  const primary = pageClasses[0];
  if (primary) out.push(`    await ${camelize(primary.className)}.goto();`);
  out.push(`  });`);
  out.push('');

  // Render each scenario, mapping its steps to page-object calls.
  for (const pc of pageClasses) {
    for (const scenario of pc.scenarios) {
      out.push(...renderScenario(scenario, pc, ext).map((l) => '  ' + l));
      out.push('');
    }
  }

  out.push(`});`);
  out.push('');
  return out.join('\n');
}

function renderScenario(scenario: Scenario, pc: PageClassPlan, ext: 'ts' | 'js'): string[] {
  const handle = camelize(pc.className);
  const tag = scenario.category === 'happy' ? '[happy]'
            : scenario.category === 'negative' ? '[negative]'
            : scenario.category === 'edge' ? '[edge]'
            : '[a11y]';
  const out: string[] = [];
  out.push(`test(${q(tag + ' ' + scenario.name)}, async ({ page }) => {`);

  // Try to match the leading steps to a synthesized method.
  const lead: TraceStep[] = [];
  for (const step of scenario.steps) {
    if (step.kind === 'navigate' || step.kind === 'wait' || step.kind === 'checkpoint') continue;
    if (step.kind === 'fill' || step.kind === 'click' || step.kind === 'press') lead.push(step);
    else break;
  }
  const leadSig = lead.map(stepSignature).join('|');
  const matched = pc.methods.find((m) => m.signatureKey === leadSig);

  const consumed = new Set<TraceStep>();
  if (matched) {
    // Emit the action method call with the fill values as arguments.
    const fillValues = matched.steps
      .filter((s): s is Extract<TraceStep, { kind: 'fill' }> => s.kind === 'fill')
      .map((s) => {
        // Find the corresponding step in THIS scenario to use its actual value.
        const real = scenario.steps.find((x) => x.kind === 'fill' && canonicalIntent(x.target.intent) === canonicalIntent(s.target.intent));
        const val = (real && real.kind === 'fill') ? real.value : s.value;
        return q(val);
      });
    out.push(`  await ${handle}.${matched.name}(${fillValues.join(', ')});`);
    // Mark the lead steps consumed so we don't re-emit them below.
    for (const step of lead) consumed.add(step);
  }

  for (const step of scenario.steps) {
    if (consumed.has(step)) continue;
    if (step.kind === 'navigate') continue; // covered by beforeEach + page.goto
    out.push('  ' + emitStepCall(step, pc, handle));
  }
  out.push(`});`);
  return out;
}

function emitStepCall(step: TraceStep, pc: PageClassPlan, handle: string): string {
  switch (step.kind) {
    case 'click': {
      const field = pc.intentToField.get(canonicalIntent(step.target.intent));
      return field
        ? `await ${handle}.${field}.click();`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true)}.click();`;
    }
    case 'fill': {
      const field = pc.intentToField.get(canonicalIntent(step.target.intent));
      return field
        ? `await ${handle}.${field}.fill(${q(step.value)});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true)}.fill(${q(step.value)});`;
    }
    case 'press': {
      const field = pc.intentToField.get(canonicalIntent(step.target.intent));
      return field
        ? `await ${handle}.${field}.press(${q(step.key)});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true)}.press(${q(step.key)});`;
    }
    case 'wait':
      return `await page.waitForTimeout(${step.ms});`;
    case 'checkpoint':
      return `// ${step.label}`;
    case 'assert':
      return emitAssertion(step.assertion, pc, handle);
    case 'navigate':
      return `await page.goto(${q(step.url)});`;
  }
}

function emitAssertion(a: Assertion, pc: PageClassPlan, handle: string): string {
  switch (a.type) {
    case 'toBeVisible': {
      const field = pc.intentToField.get(canonicalIntent(a.target.intent));
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true);
      return `await expect(${loc}).toBeVisible();`;
    }
    case 'toHaveText':
    case 'toContainText': {
      const field = pc.intentToField.get(canonicalIntent(a.target.intent));
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true);
      const fn = a.type === 'toHaveText' ? 'toHaveText' : 'toContainText';
      return `await expect(${loc}).${fn}(${q(a.text)});`;
    }
    case 'toHaveURL':
      return `await expect(page).toHaveURL(new RegExp(${q(a.pattern)}));`;
    case 'toHaveCount': {
      const field = pc.intentToField.get(canonicalIntent(a.target.intent));
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true);
      return `await expect(${loc}).toHaveCount(${a.count});`;
    }
  }
}

function renderA11ySpec(url: string, ext: 'ts' | 'js'): string {
  const out: string[] = [];
  if (ext === 'ts') {
    out.push(`import { test, expect } from '@playwright/test';`);
    out.push(`import AxeBuilder from '@axe-core/playwright';`);
  } else {
    out.push(`const { test, expect } = require('@playwright/test');`);
    out.push(`const AxeBuilder = require('@axe-core/playwright').default;`);
  }
  out.push('');
  out.push(`test('a11y: landing page has no critical/serious WCAG 2 AA violations', async ({ page }) => {`);
  out.push(`  await page.goto(${q(url)});`);
  out.push(`  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();`);
  out.push(`  const blocking = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');`);
  out.push(`  if (blocking.length) console.error('a11y blocking violations:\\n' + JSON.stringify(blocking, null, 2));`);
  out.push(`  expect(blocking).toEqual([]);`);
  out.push(`});`);
  out.push('');
  return out.join('\n');
}

/* ───────────────────────── helpers ───────────────────────── */

function camelize(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `QA-Core: ${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return `QA-Core: ${url}`;
  }
}

function q(s: string): string {
  return JSON.stringify(s);
}
