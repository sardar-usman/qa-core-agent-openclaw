import fs from 'node:fs';
import path from 'node:path';
import { emitLocatorCall, type CascadeLevel } from './selectors.js';
import { selectOptionExpr, filesArg } from './transcriber.js';
import { uniqueCallExpr, uniqueFnName } from './unique-data.js';
import type { Assertion, CaptureSource, GenerateKind, RunReport, Scenario, SelectorRecord, TraceStep } from './trace.js';

/**
 * How long the emitted assert_compare poll waits for an async state change (a
 * sort, a re-render) to settle before failing. Matches the replay engine's
 * DEFAULT_TIMEOUT_MS so the spec and the in-process check agree.
 */
const COMPARE_POLL_TIMEOUT_MS = 10_000;

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
 *     tests/a11y/
 *       landing.a11y.spec.ts           auto-injected accessibility check
 *                                       (sits inside tests/ so it runs by
 *                                       default — testDir is './tests')
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
  /** All emitted page-object files including BasePage. */
  pageFiles: string[];
  /**
   * One spec file per feature group, located at tests/<feature>/<feature>.spec.{ext}.
   * Order matches the feature group order produced by groupScenariosByFeature.
   */
  specFiles: string[];
  /**
   * The "primary" spec file path — a convenience for code that wants to
   * point at one representative test (e.g. console output "Run: npx
   * playwright test <spec>"). Always equals specFiles[0] when at least one
   * group emitted; empty string when there were no scenarios.
   */
  specFile: string;
  a11yFile: string;
  scenarios: number;
  /** Distinct feature names that produced a page object + spec folder. */
  features: string[];
}

/* ───────────────────────── Entry point ───────────────────────── */

export function transcribePOM(opts: POMTranscribeOptions): POMTranscribeResult {
  const { report, outDir } = opts;
  fs.mkdirSync(path.join(outDir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'tests', 'a11y'), { recursive: true });

  const ext = report.language;
  const pageGroups = groupScenariosByFeature(report);
  const pageClasses = pageGroups.map((pg) => buildPageClass(pg, ext));

  // Emit BasePage (shared).
  const baseFile = path.join(outDir, 'pages', `BasePage.${ext}`);
  fs.writeFileSync(baseFile, renderBasePage(ext));

  // Emit one <feature>-page.{ext} per feature group.
  const pageFiles: string[] = [baseFile];
  for (const pc of pageClasses) {
    const file = path.join(outDir, 'pages', `${pc.pageFileBase}.${ext}`);
    fs.writeFileSync(file, renderPageClass(pc, ext));
    pageFiles.push(file);
  }

  // Emit one spec per feature at tests/<feature>/<feature>.spec.{ext}.
  // Each spec contains only the scenarios for that feature.
  const specFiles: string[] = [];
  const features: string[] = [];
  for (const pc of pageClasses) {
    const specDir = path.join(outDir, 'tests', pc.specFolder);
    fs.mkdirSync(specDir, { recursive: true });
    const specFile = path.join(specDir, `${pc.specFolder}.spec.${ext}`);
    fs.writeFileSync(specFile, renderSpec(report, pc, ext));
    specFiles.push(specFile);
    features.push(pc.feature);
  }

  // a11y test lives under tests/a11y/ so playwright's default testDir picks
  // it up alongside functional tests — no manual `npx playwright test a11y/`
  // needed. Still namespaced into its own subfolder for separation of concern.
  const a11yFile = path.join(outDir, 'tests', 'a11y', `landing.a11y.spec.${ext}`);
  fs.writeFileSync(a11yFile, renderA11ySpec(report.url, ext));

  return {
    rootDir: outDir,
    pageFiles,
    specFiles,
    specFile: specFiles[0] ?? '',
    a11yFile,
    scenarios: report.scenarios.length,
    features,
  };
}

/* ───────────────────────── Page grouping ───────────────────────── */

interface PageGroup {
  /** Logical key: feature slug when scenarios have one, else URL-derived. */
  key: string;
  /** Lowercase kebab-case feature slug, e.g. "login" or "forgot-password". */
  feature: string;
  /** Display name for the page (used in PascalCase class name). */
  label: string;
  /** PascalCase class name, e.g. "LoginPage". */
  className: string;
  /** Filename stem for the page-object file (without extension): "login-page". */
  pageFileBase: string;
  /** Folder name under tests/, equals the feature slug: "login". */
  specFolder: string;
  url: string;
  /** Scenarios whose actions occur primarily on this page. */
  scenarios: Scenario[];
}

interface SelectorUsage {
  /** Original intent (e.g. "username input"). Stable identity for a locator. */
  intent: string;
  level: CascadeLevel;
  arg: SelectorRecord['arg'];
  /** iframe-selector chain the element lives behind (outer→inner), if any. */
  frameChain?: string[];
  /** Count across all scenarios on this page. */
  uses: number;
}

interface PageClassPlan {
  className: string;
  url: string;
  /** Lowercase kebab-case feature slug, mirrored from PageGroup. */
  feature: string;
  /** Filename stem for the page-object file (without extension). */
  pageFileBase: string;
  /** Folder name under tests/. */
  specFolder: string;
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

function groupScenariosByFeature(report: RunReport): PageGroup[] {
  // Prefer the explicit `feature` tag a scenario carries. Fall back to a
  // URL-pathname derivation when none of the scenarios has a feature (this
  // preserves the legacy grouping behaviour for runs where the Planner
  // didn't tag scenarios — e.g. older traces).
  const groups = new Map<string, PageGroup>();
  for (const scenario of report.scenarios) {
    const url = pickPageUrl(scenario, report.url);
    const feature = (scenario.feature && scenario.feature.trim().length > 0)
      ? scenario.feature.toLowerCase()
      : deriveFeatureFromUrl(url, report.url);
    const key = feature;
    const existing = groups.get(key);
    if (existing) {
      existing.scenarios.push(scenario);
      continue;
    }
    groups.set(key, {
      key,
      feature,
      label: feature.replace(/-/g, ' '),
      className: featureToClassName(feature),
      pageFileBase: `${feature}-page`,
      specFolder: feature,
      url,
      scenarios: [scenario],
    });
  }
  return [...groups.values()];
}

/** Derive a feature slug from a URL when no explicit tag is present. */
function deriveFeatureFromUrl(url: string, fallbackUrl: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
    if (seg) {
      const cleaned = seg.toLowerCase()
        .replace(/\.(html?|aspx?|php)$/i, '')
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      if (cleaned) return cleaned;
    }
    // Root path — derive feature from the host's brand name.
    const host = u.host.replace(/^www\./, '').toLowerCase();
    const parts = host.split('.');
    if (parts.length > 1) parts.pop();
    const brand = parts.join('-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return brand || 'main';
  } catch {
    return deriveFeatureFromUrl(fallbackUrl, '') || 'main';
  }
}

/** "login" → "LoginPage"; "forgot-password" → "ForgotPasswordPage". */
function featureToClassName(feature: string): string {
  const parts = feature.split('-').filter(Boolean);
  if (parts.length === 0) return 'LandingPage';
  const camel = parts.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join('');
  return camel.endsWith('Page') ? camel : camel + 'Page';
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
        usage.set(key, { intent: target.intent, level: target.level, arg: target.arg, frameChain: target.frameChain, uses: 1 });
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
      record: { level: u.level, arg: u.arg, intent: u.intent, frameChain: u.frameChain },
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
    feature: group.feature,
    pageFileBase: group.pageFileBase,
    specFolder: group.specFolder,
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
export function canonicalIntent(intent: string): string {
  const NOISE = new Set(['input', 'field', 'control', 'box', 'the', 'a', 'an']);
  return intent
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w))
    .join(' ')
    .trim() || intent.toLowerCase().trim();
}

/** RHS expression for a capture/compare read, emitted inline. */
function captureRhs(source: CaptureSource, target: SelectorRecord, attribute?: string): string {
  if (source === 'count') {
    return `await ${emitLocatorCall(target.level, target.arg, false, target.frameChain)}.count()`;
  }
  const locFirst = emitLocatorCall(target.level, target.arg, true, target.frameChain);
  if (source === 'attribute') return `(await ${locFirst}.getAttribute(${q(attribute!)}))?.trim() ?? ''`;
  return `(await ${locFirst}.textContent())?.trim() ?? ''`;
}

function stepTarget(step: TraceStep): SelectorRecord | null {
  if (step.kind === 'click' || step.kind === 'fill' || step.kind === 'press') return step.target;
  if (step.kind === 'select_option' || step.kind === 'set_checked' || step.kind === 'set_input_files') return step.target;
  if (step.kind === 'assert') {
    const a = step.assertion;
    if ('target' in a) return a.target;
  }
  if (step.kind === 'wait_for_state') return step.target;
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
      if (step.kind === 'navigate' || step.kind === 'wait' || step.kind === 'stability_wait' || step.kind === 'checkpoint') continue;
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
        if (step.kind === 'navigate' || step.kind === 'wait' || step.kind === 'stability_wait' || step.kind === 'checkpoint') continue;
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
      out.push(`    this.${f.name} = ${emitLocatorCall(f.record.level, f.record.arg, f.record.ambiguous === true, f.record.frameChain)};`);
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
    out.push(`    this.${f.name} = ${emitLocatorCall(f.record.level, f.record.arg, f.record.ambiguous === true, f.record.frameChain)};`);
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
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain)}.fill(${valueArg});`);
    } else if (step.kind === 'click') {
      const field = intentToField.get(canonicalIntent(step.target.intent));
      body.push(field
        ? `await this.${field}.click();`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain)}.click();`);
    } else if (step.kind === 'press') {
      const field = intentToField.get(canonicalIntent(step.target.intent));
      body.push(field
        ? `await this.${field}.press(${q(step.key)});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain)}.press(${q(step.key)});`);
    }
  }
  return [sig, ...body.map((l) => '  ' + l), `}`];
}

function renderSpec(report: RunReport, pc: PageClassPlan, ext: 'ts' | 'js'): string {
  // Spec lives at tests/<feature>/<feature>.spec.{ext} — two levels deep from
  // the framework root, so the page-object import path is `../../pages/...`.
  const importPath = `../../pages/${pc.pageFileBase}`;
  const handle = camelize(pc.className);
  const describeTitle = `${titleFromUrl(report.url)} / ${pc.feature}`;
  const out: string[] = [];
  // Generated fields (registration email, unique username) call uniqueEmail() /
  // uniqueToken() at the spec call site, so import whichever ones this spec uses.
  const genKinds = new Set<GenerateKind>();
  for (const sc of pc.scenarios) {
    for (const st of sc.steps) {
      if (st.kind === 'fill' && st.generate) genKinds.add(st.generate);
    }
  }
  const genFns = [...genKinds].map(uniqueFnName).sort();
  if (ext === 'ts') {
    out.push(`import { test, expect } from '@playwright/test';`);
    out.push(`import { ${pc.className} } from '${importPath}';`);
    if (genFns.length > 0) out.push(`import { ${genFns.join(', ')} } from '../../helpers/unique-data';`);
  } else {
    out.push(`const { test, expect } = require('@playwright/test');`);
    out.push(`const { ${pc.className} } = require('${importPath}');`);
    if (genFns.length > 0) out.push(`const { ${genFns.join(', ')} } = require('../../helpers/unique-data');`);
  }
  out.push(``);
  out.push(`/* Auto-generated by QA-Core. Source URL: ${report.url}`);
  out.push(` * Feature: ${pc.feature}`);
  out.push(` * Verified live before transcription.`);
  out.push(` */`);
  out.push(``);
  out.push(`test.describe(${q(describeTitle)}, () => {`);

  if (ext === 'ts') {
    out.push(`  let ${handle}: ${pc.className};`);
  } else {
    out.push(`  let ${handle};`);
  }
  out.push('');
  out.push(`  test.beforeEach(async ({ context, page }) => {`);
  // Per-test isolation: matches the agent's exploration-time isolation.
  out.push(`    await context.clearCookies();`);
  out.push(`    try { await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); } catch { /* about:blank */ }`);
  out.push(`    ${handle} = new ${pc.className}(page);`);
  out.push(`    await ${handle}.goto();`);
  out.push(`  });`);
  out.push('');

  for (const scenario of pc.scenarios) {
    out.push(...renderScenario(scenario, pc, ext).map((l) => '  ' + l));
    out.push('');
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
    if (step.kind === 'navigate' || step.kind === 'wait' || step.kind === 'stability_wait' || step.kind === 'checkpoint') continue;
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
        const realFill = (real && real.kind === 'fill') ? real : s;
        // A generated field passes a fresh value on every run, not a literal.
        return realFill.generate ? uniqueCallExpr(realFill.generate) : q(realFill.value);
      });
    out.push(`  await ${handle}.${matched.name}(${fillValues.join(', ')});`);
    // Mark the lead steps consumed so we don't re-emit them below.
    for (const step of lead) consumed.add(step);
  }

  // The beforeEach already navigates to the base URL, so the scenario's FIRST
  // navigate is redundant and dropped. Every LATER navigate is load-bearing
  // (a reload, or a move to another URL) — a capture-and-compare scenario that
  // captures a value, reloads, then asserts it changed needs that reload in the
  // emitted spec, or the test re-reads the same page and can never go red.
  let initialNavSkipped = false;
  for (const step of scenario.steps) {
    if (consumed.has(step)) continue;
    if (step.kind === 'navigate') {
      if (!initialNavSkipped) { initialNavSkipped = true; continue; }
      out.push(`  await page.goto(${q(step.url)});`);
      continue;
    }
    for (const line of emitStepCall(step, pc, handle)) {
      out.push('  ' + line);
    }
  }
  out.push(`});`);
  return out;
}

function emitStepCall(step: TraceStep, pc: PageClassPlan, handle: string): string[] {
  switch (step.kind) {
    case 'click': {
      const field = pc.intentToField.get(canonicalIntent(step.target.intent));
      return [field
        ? `await ${handle}.${field}.click();`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain)}.click();`];
    }
    case 'fill': {
      const field = pc.intentToField.get(canonicalIntent(step.target.intent));
      const valueArg = step.generate ? uniqueCallExpr(step.generate) : q(step.value);
      return [field
        ? `await ${handle}.${field}.fill(${valueArg});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain)}.fill(${valueArg});`];
    }
    case 'press': {
      const field = pc.intentToField.get(canonicalIntent(step.target.intent));
      return [field
        ? `await ${handle}.${field}.press(${q(step.key)});`
        : `await ${emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain)}.press(${q(step.key)});`];
    }
    case 'select_option': {
      const field = pc.intentToField.get(canonicalIntent(step.target.intent));
      const base = field ? `${handle}.${field}` : emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain);
      return [`await ${base}.${selectOptionExpr(step.by, step.option)};`];
    }
    case 'set_checked': {
      const field = pc.intentToField.get(canonicalIntent(step.target.intent));
      const base = field ? `${handle}.${field}` : emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain);
      return [`await ${base}.${step.checked ? 'check' : 'uncheck'}();`];
    }
    case 'set_input_files': {
      const field = pc.intentToField.get(canonicalIntent(step.target.intent));
      const base = field ? `${handle}.${field}` : emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain);
      return [`await ${base}.setInputFiles(${filesArg(step.files)});`];
    }
    case 'wait':
      return [`await page.waitForTimeout(${step.ms});`];
    case 'stability_wait':
      return [`await page.waitForTimeout(${step.ms}); // stability comparison wait`];
    case 'checkpoint':
      return [`// ${step.label}`];
    case 'assert':
      return [emitAssertion(step.assertion, pc, handle)];
    case 'navigate':
      return [`await page.goto(${q(step.url)});`];
    case 'capture': {
      // Capture-and-compare emits inline locators (no page-object field): the
      // read needs .first() for attribute/text and the full multi-match locator
      // for count, neither of which the field handle exposes cleanly.
      return [`const ${step.varName} = ${captureRhs(step.source, step.target, step.attribute)}; // captured ${step.source} for compare`];
    }
    case 'assert_compare': {
      if (step.relation === 'absent') {
        if (step.source === 'attribute' && step.attribute) {
          return ['await expect(page.locator(`[' + step.attribute + '="${' + step.varName + '}"]`)).toHaveCount(0);'];
        }
        return [`await expect(page.getByText(${step.varName}, { exact: true })).toHaveCount(0);`];
      }
      // Poll the after-action read with expect.poll, not a one-shot const read.
      // A sort or re-render settles asynchronously, so a single read races it and
      // flakes. expect.poll re-reads until the relation holds or the timeout
      // expires, the web-first wait Playwright already uses for locators.
      const readRhs = captureRhs(step.source, step.target, step.attribute);
      const pollOpts = `{ timeout: ${COMPARE_POLL_TIMEOUT_MS} }`;
      const lines: string[] = [];
      switch (step.relation) {
        case 'changed':
          lines.push(`await expect.poll(async () => ${readRhs}, ${pollOpts}).not.toBe(${step.varName}); // value changed after the action`);
          break;
        case 'unchanged':
        case 'equal':
          lines.push(`await expect.poll(async () => ${readRhs}, ${pollOpts}).toBe(${step.varName}); // value held`);
          if (step.bounds) {
            const locFirst = emitLocatorCall(step.target.level, step.target.arg, true, step.target.frameChain);
            lines.push(
              `const ${step.readVar}Now = Number(${readRhs});`,
              `const ${step.readVar}Min = Number(await ${locFirst}.getAttribute(${q(step.bounds.min)}));`,
              `const ${step.readVar}Max = Number(await ${locFirst}.getAttribute(${q(step.bounds.max)}));`,
              `expect(${step.readVar}Now).toBeGreaterThan(${step.readVar}Min);`,
              `expect(${step.readVar}Now).toBeLessThan(${step.readVar}Max);`,
            );
          }
          break;
        case 'greater':
          lines.push(`await expect.poll(async () => Number(${readRhs}), ${pollOpts}).toBeGreaterThan(Number(${step.varName}));`);
          break;
        case 'less':
          lines.push(`await expect.poll(async () => Number(${readRhs}), ${pollOpts}).toBeLessThan(Number(${step.varName}));`);
          break;
      }
      return lines;
    }
    case 'wait_for_state': {
      const field = pc.intentToField.get(canonicalIntent(step.target.intent));
      const locExpr = field
        ? `${handle}.${field}`
        : emitLocatorCall(step.target.level, step.target.arg, step.target.ambiguous === true, step.target.frameChain);
      return [`await ${locExpr}.waitFor({ state: '${step.state}' });`];
    }
  }
}

function emitAssertion(a: Assertion, pc: PageClassPlan, handle: string): string {
  switch (a.type) {
    case 'toBeVisible': {
      const field = pc.intentToField.get(canonicalIntent(a.target.intent));
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true, a.target.frameChain);
      const opts = a.timeout ? `{ timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).toBeVisible(${opts});`;
    }
    case 'toHaveText':
    case 'toContainText': {
      const field = pc.intentToField.get(canonicalIntent(a.target.intent));
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true, a.target.frameChain);
      const fn = a.type === 'toHaveText' ? 'toHaveText' : 'toContainText';
      const opts = a.timeout ? `, { timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).${fn}(${q(a.text)}${opts});`;
    }
    case 'toHaveURL':
      return `await expect(page).toHaveURL(new RegExp(${q(a.pattern)}));`;
    case 'toBeHidden': {
      // Absence assertion. Force .first() so a selector matching several hidden
      // nodes (or none) never trips strict mode. An absent element has no page
      // object field, so always emit the inline locator.
      const loc = emitLocatorCall(a.target.level, a.target.arg, true, a.target.frameChain);
      const opts = a.timeout ? `{ timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).toBeHidden(${opts});`;
    }
    case 'toHaveCount': {
      const field = pc.intentToField.get(canonicalIntent(a.target.intent));
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true, a.target.frameChain);
      const opts = a.timeout ? `, { timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).toHaveCount(${a.count}${opts});`;
    }
    case 'toHaveAttribute': {
      const field = pc.intentToField.get(canonicalIntent(a.target.intent));
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true, a.target.frameChain);
      const opts = a.timeout ? `, { timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).toHaveAttribute(${q(a.attribute)}, ${q(a.value)}${opts});`;
    }
    case 'toHaveValue': {
      const field = pc.intentToField.get(canonicalIntent(a.target.intent));
      const loc = field ? `${handle}.${field}` : emitLocatorCall(a.target.level, a.target.arg, a.target.ambiguous === true, a.target.frameChain);
      const opts = a.timeout ? `, { timeout: ${a.timeout} }` : '';
      return `await expect(${loc}).toHaveValue(${q(a.value)}${opts});`;
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
