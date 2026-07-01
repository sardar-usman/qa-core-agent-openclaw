import type { FrameLocator, Locator, Page } from '@playwright/test';

/**
 * Selector cascade: role (nameless) → role+name → label → placeholder →
 * text → alt → title → testid → CSS → xpath.
 *
 * The agent describes targets in terms of intent ("the email field",
 * "the submit button"). This module resolves that intent to a Locator
 * by trying levels in order of Playwright's recommended robustness.
 *
 * Key invariant: only pass an accessible name to getByRole when the
 * element actually has one. Try getByRole(role) nameless first — this
 * correctly resolves elements like role="progressbar" that have no
 * aria-label or aria-labelledby.
 *
 * Iframes: the cascade runs against a "scope" that is either the top Page
 * or a FrameLocator. If nothing resolves in the main frame, resolve() scans
 * iframes (and nested iframes) and re-runs the SAME cascade inside each frame
 * via page.frameLocator(<iframe>). A hit inside a frame records the chain of
 * iframe selectors on `frameChain` so replay and the emitted spec scope into
 * the frame the same way. Playwright reaches frame content with frameLocator,
 * never a ">>>" piercing selector.
 */

export type CascadeLevel = 'role' | 'label' | 'placeholder' | 'text' | 'alt' | 'title' | 'testid' | 'css' | 'xpath';

/**
 * A cascade scope: the top page or a frame. FrameLocator exposes the same
 * getBy and locator builders as Page, so the cascade body works against either.
 */
export type Scope = Page | FrameLocator;

/** How deep to chase nested iframes, and how many frames to scan per level. */
const MAX_FRAME_DEPTH = 3;
const MAX_FRAMES_PER_LEVEL = 8;

export interface ResolvedLocator {
  locator: Locator;
  level: CascadeLevel;
  /** The argument used to construct the winning locator — emitted into the spec. */
  arg: string | { role: string; name?: string; exact?: boolean };
  /** True when the cascade had to take `.first()` of multiple matches. */
  ambiguous: boolean;
  /**
   * Chain of iframe selectors (outer→inner) the element lives behind. Empty /
   * undefined means the element is in the top frame. When set, replay and the
   * emitted spec scope in with page.frameLocator(chain[0]).frameLocator(...)
   * before applying the cascade level.
   */
  frameChain?: string[];
}

export interface ResolveSpec {
  intent: string;
  role?: string;
  label?: string;
  testid?: string;
  css?: string;
  /**
   * Assertion text. Forwarded by the assert tool (toHaveText/toContainText)
   * so the cascade has a hint to find elements whose only stable identifier
   * IS their visible copy — error messages, toast notifications, headings.
   * Treated as substring (Playwright `getByText` default).
   */
  text?: string;
  /**
   * Explicit XPath expression (without the `xpath=` prefix). Used as a
   * last-resort hint when nothing else resolves. Also auto-detected when
   * the `css` field starts with `//` or `./`.
   */
  xpath?: string;
}

const ROLE_PATTERNS: Array<[RegExp, string]> = [
  [/button|submit|sign\s*(in|up)|log\s*(in|out)|continue|next|cancel/i, 'button'],
  [/(check|tick)box/i, 'checkbox'],
  [/radio/i, 'radio'],
  [/select|dropdown|combo/i, 'combobox'],
  [/link|anchor/i, 'link'],
  [/textbox|input|field|email|password|user(name)?/i, 'textbox'],
];

function guessRole(intent: string): string | undefined {
  for (const [re, role] of ROLE_PATTERNS) {
    if (re.test(intent)) return role;
  }
  return undefined;
}

/**
 * Generic-suffix shortening for the role+name and placeholder cascade
 * retries. Bridges the very common gap between what the agent says
 * ("password input", "submit button") and what the page exposes as the
 * accessible name ("Password", "Submit"). Without this, multi-word
 * intents whose ONLY differentiator is a generic suffix can't substring-
 * match the shorter accessible name.
 *
 *   "password input"      → "password"
 *   "username field"      → "username"
 *   "submit button"       → "submit"
 *   "the username input"  → "the username"
 *   "search"              → null  (single word; nothing to strip)
 *   "input"               → null  (all generic)
 *
 * Returns null when there's nothing left to try so the caller can skip
 * the retry instead of trying the same string twice.
 */
const GENERIC_SUFFIXES = new Set([
  'input', 'field', 'button', 'link', 'icon', 'control',
  'element', 'item', 'box', 'area', 'label', 'text', 'textbox',
  'dropdown', 'select', 'checkbox', 'radio',
]);

export function stripGenericSuffixes(intent: string): string | null {
  const words = intent.trim().split(/\s+/);
  if (words.length <= 1) return null;
  let end = words.length;
  while (end > 0 && GENERIC_SUFFIXES.has(words[end - 1]!.toLowerCase())) end--;
  if (end === 0) return null;            // every word is generic — nothing distinctive left
  if (end === words.length) return null; // nothing was stripped — no new attempt to make
  return words.slice(0, end).join(' ');
}

async function countOf(locator: Locator): Promise<number> {
  try { return await locator.count(); } catch { return 0; }
}

type Candidate = { locator: Locator; level: CascadeLevel; arg: ResolvedLocator['arg'] };

/**
 * Public resolver. Tries the top frame first, then iframes.
 *
 * Order:
 *  1. If a ">>>" piercing selector slipped into the css hint, split it into a
 *     frame chain plus the inner selector and resolve the inner inside the
 *     frame (the model sometimes emits "iframe#frame1 >>> #el", which is not
 *     how Playwright reaches frames; we convert it to frameLocator).
 *  2. Resolve in the main frame.
 *  3. If nothing resolved, scan iframes (depth-limited) and run the SAME
 *     cascade inside each frame. The winning frame's selector chain is
 *     recorded on `frameChain`.
 *
 * Frame scanning only runs when the main frame fails, so the common path pays
 * no extra cost.
 */
export async function resolve(page: Page, spec: ResolveSpec): Promise<ResolvedLocator | null> {
  // 1. Piercing-selector rescue. When the model passes "iframe... >>> #el", the
  // ">>>" is not a real Playwright selector, so the inner element is what we
  // actually look for. Strip the frame part off the css for EVERY step below,
  // not just the explicit-chain try: otherwise the main-frame and generic-scan
  // fallbacks would search for the raw ">>>" css and never match.
  const pierced = parsePiercingSelector(spec.css);
  const effectiveSpec: ResolveSpec = pierced ? { ...spec, css: pierced.innerCss } : spec;
  if (pierced) {
    const scope = frameLocatorForChain(page, pierced.frameChain);
    const hit = await resolveInScope(scope, effectiveSpec);
    if (hit) { hit.frameChain = pierced.frameChain; return hit; }
    // Fall through: if the explicit chain misses (e.g. the model guessed an
    // <iframe> selector for a frameset <frame>), the generic scan below still
    // finds the element behind the real, auto-detected frame.
  }

  // 2. Main frame.
  const top = await resolveInScope(page, effectiveSpec);
  if (top) return top;

  // 3. Frames (iframe + frameset frame), then nested frames.
  return resolveInFrames(page, page, effectiveSpec, [], MAX_FRAME_DEPTH);
}

/**
 * Recursively scan iframes under `scope`, running the cascade inside each.
 * `chain` is the iframe-selector path from the top page to `scope`.
 */
async function resolveInFrames(
  page: Page,
  scope: Scope,
  spec: ResolveSpec,
  chain: string[],
  depthLeft: number,
): Promise<ResolvedLocator | null> {
  if (depthLeft <= 0) return null;
  const frameSels = await enumerateFrameSelectors(scope);
  for (const fsel of frameSels.slice(0, MAX_FRAMES_PER_LEVEL)) {
    const childChain = [...chain, fsel];
    const frame = frameLocatorForChain(page, childChain);
    const hit = await resolveInScope(frame, spec);
    if (hit) { hit.frameChain = childChain; return hit; }
    const deeper = await resolveInFrames(page, frame, spec, childChain, depthLeft - 1);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Build the per-frame selectors directly inside `scope`. Covers BOTH `<iframe>`
 * and frameset `<frame>` elements: a frameset page (the ui.vision frames demo)
 * has no `<iframe>` at all, only `<frame>`, and Playwright's frameLocator drives
 * either one. Prefers a stable id/name selector; falls back to a positional
 * `<tag> >> nth=i` (per tag, so the index matches the right element set). The
 * returned strings are valid for BOTH page.frameLocator(sel) at runtime and the
 * emitted spec.
 */
async function enumerateFrameSelectors(scope: Scope): Promise<string[]> {
  const sels: string[] = [];
  for (const tag of ['iframe', 'frame'] as const) {
    const frames = scope.locator(tag);
    let n = 0;
    try { n = await frames.count(); } catch { continue; }
    for (let i = 0; i < n && i < MAX_FRAMES_PER_LEVEL; i++) {
      let sel = `${tag} >> nth=${i}`;
      try {
        // getAttribute (not evaluate) so this never depends on the tsx eval shim.
        const id = (await frames.nth(i).getAttribute('id'))?.trim();
        const name = (await frames.nth(i).getAttribute('name'))?.trim();
        if (id && /^[A-Za-z_][\w-]*$/.test(id)) sel = `${tag}#${id}`;
        else if (id) sel = `${tag}[id="${id.replace(/"/g, '\\"')}"]`;
        else if (name) sel = `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
      } catch {
        // keep the positional fallback
      }
      sels.push(sel);
    }
  }
  return sels;
}

/** Build a FrameLocator by chaining frameLocator() through the selector chain. */
export function frameLocatorForChain(page: Page, chain: string[]): FrameLocator {
  let fl = page.frameLocator(chain[0]!);
  for (let i = 1; i < chain.length; i++) fl = fl.frameLocator(chain[i]!);
  return fl;
}

/**
 * Split a ">>>" piercing selector into a frame-selector chain plus the inner
 * element selector. "iframe#a >>> iframe#b >>> #el" → { frameChain:
 * ['iframe#a','iframe#b'], innerCss: '#el' }. Returns null when there is no
 * ">>>" (the normal case). Playwright does not support ">>>" for frames; this
 * converts the model's mistake into a real frameLocator chain.
 */
export function parsePiercingSelector(css?: string): { frameChain: string[]; innerCss: string } | null {
  if (!css || css.indexOf('>>>') < 0) return null;
  const parts = css.split('>>>').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const innerCss = parts[parts.length - 1]!;
  const frameChain = parts.slice(0, -1);
  return { frameChain, innerCss };
}

/**
 * Cascade resolver against a single scope (the page or one frame). Prefers
 * unique matches; falls back to ambiguous-first only after every level has
 * been tried. Never returns a unique-looking result for what is actually a
 * multi-match — the spec we transcribe gets to know whether `.first()` is
 * needed.
 */
async function resolveInScope(page: Scope, spec: ResolveSpec): Promise<ResolvedLocator | null> {
  const role = spec.role ?? guessRole(spec.intent);
  const name = spec.label ?? spec.intent;
  const ambiguousCandidates: Candidate[] = [];

  const tryCandidate = async (c: Candidate): Promise<ResolvedLocator | null> => {
    const n = await countOf(c.locator);
    if (n === 1) return { locator: c.locator, level: c.level, arg: c.arg, ambiguous: false };
    if (n > 1) ambiguousCandidates.push(c);
    return null;
  };

  // 1. getByRole — named variants first, then nameless as a final fallback.
  //    Named variants cover elements with an accessible name (aria-label,
  //    aria-labelledby, associated text). Nameless covers elements that have
  //    a role but no accessible name (e.g. role="progressbar" without aria-label):
  //    trying nameless after all named variants fail gracefully picks those up
  //    without forcing the intent string as a fake accessible name.
  {
    // 1a. Named variants: guessed role first, then common fallback roles
    if (name) {
      const rolesToTry: string[] = [];
      if (role) rolesToTry.push(role);
      for (const alt of ['link', 'button', 'textbox', 'checkbox', 'combobox']) {
        if (!rolesToTry.includes(alt)) rolesToTry.push(alt);
      }
      for (const r of rolesToTry) {
        const w = await tryRoleNameVariants(page, r, name, tryCandidate);
        if (w) return w;
      }
    }

    // 1b. Nameless fallback — only for the guessed role, only when all named
    //     variants failed. Resolves elements like role="progressbar" that have
    //     no accessible name on the page. Only wins when exactly one element
    //     has that role (otherwise pushed to ambiguousCandidates as usual).
    if (role) {
      const r0 = role as Parameters<Page['getByRole']>[0];
      const wn = await tryCandidate({
        locator: page.getByRole(r0),
        level: 'role',
        arg: { role },
      });
      if (wn) return wn;
    }
  }

  // 2. getByLabel — explicit hint, then intent
  if (spec.label) {
    const exact = page.getByLabel(spec.label, { exact: true });
    const w = await tryCandidate({ locator: exact, level: 'label', arg: spec.label });
    if (w) return w;
    const fuzzy = page.getByLabel(spec.label);
    const w2 = await tryCandidate({ locator: fuzzy, level: 'label', arg: spec.label });
    if (w2) return w2;
  }
  const byLabelFromIntent = page.getByLabel(spec.intent);
  const labelW = await tryCandidate({ locator: byLabelFromIntent, level: 'label', arg: spec.intent });
  if (labelW) return labelW;

  // 3. getByPlaceholder — covers modern forms that use placeholder text instead
  //    of <label>. Tries the explicit label hint first (because the agent
  //    typically passes the visible string there), then the bare intent,
  //    then a generic-suffix-stripped form for each.
  {
    const placeholderCandidates: string[] = [];
    const addPh = (s: string | null | undefined): void => {
      if (s && !placeholderCandidates.includes(s)) placeholderCandidates.push(s);
    };
    addPh(spec.label);
    addPh(spec.intent);
    addPh(spec.label ? stripGenericSuffixes(spec.label) : null);
    addPh(spec.intent ? stripGenericSuffixes(spec.intent) : null);
    for (const ph of placeholderCandidates) {
      const exact = page.getByPlaceholder(ph, { exact: true });
      const w = await tryCandidate({ locator: exact, level: 'placeholder', arg: ph });
      if (w) return w;
      const fuzzy = page.getByPlaceholder(ph);
      const w2 = await tryCandidate({ locator: fuzzy, level: 'placeholder', arg: ph });
      if (w2) return w2;
    }
  }

  // 4. getByText — semantic locator for visible text content (error messages,
  //    headings, toast content, links identified only by their copy).
  //    Tries the assertion text hint (spec.text) and the accessible name
  //    hint (spec.label) as text targets. Intent is NOT tried here to avoid
  //    matching unrelated elements — intent is tried as a last resort below.
  {
    const textCandidates: string[] = [];
    const addTxt = (s: string | null | undefined): void => {
      const t = s?.trim();
      if (t && t.length >= 3 && !textCandidates.includes(t)) textCandidates.push(t);
    };
    addTxt(spec.text);
    addTxt(spec.label);
    for (const txt of textCandidates) {
      const exact = page.getByText(txt, { exact: true });
      const w = await tryCandidate({ locator: exact, level: 'text', arg: txt });
      if (w) return w;
      const fuzzy = page.getByText(txt);
      const w2 = await tryCandidate({ locator: fuzzy, level: 'text', arg: txt });
      if (w2) return w2;
    }
  }

  // 5. getByAltText — for images with alt text. Tries label hint, then intent.
  {
    const altCandidates: string[] = [];
    const addAlt = (s: string | null | undefined): void => {
      if (s && !altCandidates.includes(s)) altCandidates.push(s);
    };
    addAlt(spec.label);
    addAlt(spec.intent);
    for (const alt of altCandidates) {
      const exact = page.getByAltText(alt, { exact: true });
      const w = await tryCandidate({ locator: exact, level: 'alt', arg: alt });
      if (w) return w;
      const fuzzy = page.getByAltText(alt);
      const w2 = await tryCandidate({ locator: fuzzy, level: 'alt', arg: alt });
      if (w2) return w2;
    }
  }

  // 6. getByTitle — for elements with a title attribute (icon buttons, tooltips).
  //    Tries label hint, then intent.
  {
    const titleCandidates: string[] = [];
    const addTitle = (s: string | null | undefined): void => {
      if (s && !titleCandidates.includes(s)) titleCandidates.push(s);
    };
    addTitle(spec.label);
    addTitle(spec.intent);
    for (const t of titleCandidates) {
      const byTitle = page.getByTitle(t);
      const w = await tryCandidate({ locator: byTitle, level: 'title', arg: t });
      if (w) return w;
    }
  }

  // 7. getByTestId — try BOTH attribute conventions:
  //    a) Playwright's default `data-testid` via getByTestId()
  //    b) The very common `data-test` (Saucedemo, many React apps) via CSS
  //    When (b) wins, we record it as level='css' with the full
  //    `[data-test="..."]` selector so the emitted spec also resolves it.
  if (spec.testid) {
    const byTestId = page.getByTestId(spec.testid);
    const w = await tryCandidate({ locator: byTestId, level: 'testid', arg: spec.testid });
    if (w) return w;
    const escaped = spec.testid.replace(/"/g, '\\"');
    const cssArg = `[data-test="${escaped}"]`;
    const byDataTest = page.locator(cssArg);
    const w2 = await tryCandidate({ locator: byDataTest, level: 'css', arg: cssArg });
    if (w2) return w2;
  }

  // 8. CSS — explicit hint first, then smart attribute fallback from intent.
  //    Also handles XPath expressions passed through the css field
  //    (detected by the // or ./ prefix).
  if (spec.css) {
    const cleanedCss = normalizeCssQuotes(spec.css);
    if (cleanedCss.startsWith('//') || cleanedCss.startsWith('./') || cleanedCss.startsWith('(//')) {
      // XPath expression smuggled through the css field
      const byXPath = page.locator(`xpath=${cleanedCss}`);
      const w = await tryCandidate({ locator: byXPath, level: 'xpath', arg: cleanedCss });
      if (w) return w;
    } else {
      const byCss = page.locator(cleanedCss);
      const w = await tryCandidate({ locator: byCss, level: 'css', arg: cleanedCss });
      if (w) return w;
    }
  }

  const smartCss = buildSmartCssFromIntent(spec.intent);
  if (smartCss) {
    const byCss = page.locator(smartCss);
    const w = await tryCandidate({ locator: byCss, level: 'css', arg: smartCss });
    if (w) return w;
  }

  // 9. getByText with intent as last resort (for elements whose only stable
  //    identifier is their visible text and no explicit text hint was given).
  if (spec.intent.trim().length >= 4 && !spec.text && !spec.label) {
    const txt = spec.intent.trim();
    const exact = page.getByText(txt, { exact: true });
    const w = await tryCandidate({ locator: exact, level: 'text', arg: txt });
    if (w) return w;
    const fuzzy = page.getByText(txt);
    const w2 = await tryCandidate({ locator: fuzzy, level: 'text', arg: txt });
    if (w2) return w2;
  }

  // 10. XPath — explicit xpath hint (absolute last resort)
  if (spec.xpath) {
    const byXPath = page.locator(`xpath=${spec.xpath}`);
    const w = await tryCandidate({ locator: byXPath, level: 'xpath', arg: spec.xpath });
    if (w) return w;
  }

  // Nothing resolved uniquely. If we have ambiguous candidates, take the
  // best (most-preferred level) and mark it ambiguous so the spec emits
  // `.first()` honestly.
  if (ambiguousCandidates.length > 0) {
    const priority: CascadeLevel[] = ['role', 'label', 'placeholder', 'text', 'alt', 'title', 'testid', 'css', 'xpath'];
    ambiguousCandidates.sort((a, b) => priority.indexOf(a.level) - priority.indexOf(b.level));
    const best = ambiguousCandidates[0]!;
    return { locator: best.locator.first(), level: best.level, arg: best.arg, ambiguous: true };
  }

  return null;
}

/**
 * Try role+name with the standard four variants: exact full, fuzzy full,
 * exact short, fuzzy short. Hoisted so the cascade can try this for the
 * guessed role AND for fallback roles without duplicating the body.
 */
async function tryRoleNameVariants(
  page: Scope,
  role: string,
  name: string,
  tryCandidate: (c: Candidate) => Promise<ResolvedLocator | null>,
): Promise<ResolvedLocator | null> {
  const r = role as Parameters<Page['getByRole']>[0];
  const exact = page.getByRole(r, { name, exact: true });
  const w1 = await tryCandidate({ locator: exact, level: 'role', arg: { role, name, exact: true } });
  if (w1) return w1;
  const fuzzy = page.getByRole(r, { name });
  const w2 = await tryCandidate({ locator: fuzzy, level: 'role', arg: { role, name } });
  if (w2) return w2;
  const shortName = stripGenericSuffixes(name);
  if (shortName) {
    const shortExact = page.getByRole(r, { name: shortName, exact: true });
    const w3 = await tryCandidate({ locator: shortExact, level: 'role', arg: { role, name: shortName, exact: true } });
    if (w3) return w3;
    const shortFuzzy = page.getByRole(r, { name: shortName });
    const w4 = await tryCandidate({ locator: shortFuzzy, level: 'role', arg: { role, name: shortName } });
    if (w4) return w4;
  }
  return null;
}

/**
 * Strip over-escaped quotes from CSS attribute selectors. Models occasionally
 * emit `[data-test=\"foo\"]` when they should emit `[data-test="foo"]`. Only
 * normalises ASCII single + double quotes; everything else is left alone.
 */
export function normalizeCssQuotes(css: string): string {
  if (!css || (css.indexOf('\\"') < 0 && css.indexOf("\\'") < 0)) return css;
  return css.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

/**
 * Smart CSS fallback. Builds a deterministic attribute selector when the
 * intent contains a keyword with an unambiguous HTML type mapping.
 */
function buildSmartCssFromIntent(intent: string): string | null {
  const lc = intent.toLowerCase();
  if (/\bpassword\b/.test(lc))                      return 'input[type="password"]';
  if (/\bemail\b/.test(lc))                         return 'input[type="email"]';
  if (/\bsearch\b/.test(lc))                        return 'input[type="search"]';
  if (/\b(phone|telephone|tel)\b/.test(lc))         return 'input[type="tel"]';
  if (/\burl\b/.test(lc))                           return 'input[type="url"]';
  if (/\bsubmit\b/.test(lc))                        return 'button[type="submit"], input[type="submit"]';
  return null;
}

/**
 * Build the root scope expression for the emitted spec. With no frame chain it
 * is just `page`; with a chain it is
 * `page.frameLocator("iframe#a").frameLocator("iframe#b")`.
 */
export function frameScopeExpr(frameChain?: string[]): string {
  if (!frameChain || frameChain.length === 0) return 'page';
  return 'page' + frameChain.map((f) => `.frameLocator(${JSON.stringify(f)})`).join('');
}

/**
 * Emit a Playwright call expression for the resolved cascade level.
 * When `ambiguous`, the emitter appends `.first()` so the runtime spec
 * survives strict-mode. When `frameChain` is set, the call scopes into the
 * frame first via frameLocator so it works under real `playwright test`.
 */
export function emitLocatorCall(
  level: CascadeLevel,
  arg: ResolvedLocator['arg'],
  ambiguous = false,
  frameChain?: string[],
): string {
  const tail = ambiguous ? '.first()' : '';
  const root = frameScopeExpr(frameChain);
  switch (level) {
    case 'role': {
      const a = arg as { role: string; name?: string; exact?: boolean };
      if (!a.name) return `${root}.getByRole(${JSON.stringify(a.role)})${tail}`;
      const opts: Record<string, unknown> = { name: a.name };
      if (a.exact) opts.exact = true;
      return `${root}.getByRole(${JSON.stringify(a.role)}, ${JSON.stringify(opts)})${tail}`;
    }
    case 'label':
      return `${root}.getByLabel(${JSON.stringify(arg as string)})${tail}`;
    case 'placeholder':
      return `${root}.getByPlaceholder(${JSON.stringify(arg as string)})${tail}`;
    case 'text':
      return `${root}.getByText(${JSON.stringify(arg as string)})${tail}`;
    case 'alt':
      return `${root}.getByAltText(${JSON.stringify(arg as string)})${tail}`;
    case 'title':
      return `${root}.getByTitle(${JSON.stringify(arg as string)})${tail}`;
    case 'testid':
      return `${root}.getByTestId(${JSON.stringify(arg as string)})${tail}`;
    case 'css':
      return `${root}.locator(${JSON.stringify(arg as string)})${tail}`;
    case 'xpath':
      return `${root}.locator(${JSON.stringify(`xpath=${arg as string}`)})${tail}`;
  }
}

/** Escape a string for safe use inside a `new RegExp(...)` pattern. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
