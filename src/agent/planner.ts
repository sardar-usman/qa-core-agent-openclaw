import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Frame, type Page } from 'playwright';
import { installEvalShim } from './eval-shim.js';
import { renderRequirementsBlock, type RequirementsMap } from './requirements.js';

/**
 * Planner — Step 1 of the multi-agent pipeline.
 *
 * Cheap pre-pass on Haiku that opens the target URL once, captures the DOM
 * summary, and emits a numbered list of scenarios to cover. The Explorer
 * agent uses this list as a guide instead of deciding what to test on the fly.
 *
 * Why this exists: Opus tool-use loops are expensive. The Planner spends
 * pennies to give Opus a clear plan, which means Opus does less wandering
 * and produces a tighter set of scenarios.
 */

export interface PlannedScenario {
  name: string;
  category: 'happy' | 'negative' | 'edge' | 'a11y';
  rationale: string;
  /**
   * Optional feature tag (e.g. 'login', 'cart'). The Planner outputs this
   * when the caller passed a `features` list, OR when it can confidently
   * infer one from the scenario. Drives per-feature grouping downstream.
   */
  feature?: string;
  /**
   * Requirement rule ids this scenario verifies (e.g. ['R3','R7']), parsed
   * from the third bracket of the rule-driven plan format. An empty array
   * means the scenario was planned with a map present but matches no stated
   * rule ([-] in the plan). Absent entirely in the no-map format.
   */
  ruleIds?: string[];
}

export interface PlanResult {
  scenarios: PlannedScenario[];
  pageTitle: string;
  /** Cost of the planning call in USD. */
  costUsd: number;
  /**
   * Number of fillable form controls on the snapshot (text inputs, textareas,
   * selects, checkboxes, radios, file inputs; not submit/hidden). Drives the
   * form-aware step budget so a long form gets more steps per scenario.
   */
  fillableFields: number;
  /**
   * Near-duplicate scenarios removed by `dedupePlan`. Each entry names the
   * dropped scenario and the kept one it duplicated. Surfaced in the run log so
   * the de-dup is never silent.
   */
  dropped: Array<{ scenario: PlannedScenario; duplicateOf: PlannedScenario }>;
  /**
   * Scenarios removed by `rejectCircular` — a captured value compared to itself
   * with no state-changing action in between, so the assertion can never fail.
   * Each entry names the scenario and why. Surfaced in the run log.
   */
  rejected: Array<{ scenario: PlannedScenario; reason: string }>;
}

const SYSTEM = `You are the Planner. Your job: look at a single web page and propose a focused list of test scenarios for a Playwright suite.

Constraints:
- Propose 3-6 scenarios total.
- At least one happy path, one negative case, one edge case.
- Each scenario name is past-tense and describes the OUTCOME, not the action (good: "rejects invalid password"; bad: "type wrong password").
- Categories: happy, negative, edge, a11y.
- Skip scenarios you cannot verify from a single page (e.g., end-to-end checkout if only the login page is visible).

Falsifiability — the most important rule. A test that passes even when the feature is broken is worthless.
- Every scenario must name the specific regression it would catch. The rationale (the text after the em dash) must read as "fails if X breaks", naming a concrete failure the test detects. Before you plan a scenario, ask: "what exact bug would turn this test red?" If you cannot name one, the scenario is vacuous. Do not plan it.
- Pick the ONE behavior that is the whole point of the page and build the scenario around proving it. The dynamic, stateful, or risky behavior is the signal. Static rendering is noise.

Banned as the PRIMARY assertion of a scenario (each passes whether or not the feature works):
- Visibility of an element that was already visible before the action.
- A bare "the URL did not change" check.
- An "element is still present" check.
- A captured value compared to itself: capture a value, reload the page or do nothing, then assert the value is unchanged. Reloading a static page reproduces the same value, so the assertion can never fail. An "unchanged" assertion is only valid when something happened that could plausibly have changed the value (a progress bar that stopped after animating, a field that stayed put while locked, a row pinned against a re-sort). If nothing could have changed the value, do not plan the scenario.
- The absence of a made-up identifier that never existed: asserting "a frame named nonexistent-frame-xyz is not present" or "a fake-id element is absent". Nothing on any version of the page was ever named that, so the check passes forever and catches no regression. A real absence test asserts that something which WAS there is gone after an action removed, hid, or filtered it. Assert the absence of a real thing after a real action, never the absence of an invented name.
These are fine as a secondary sanity check, never as the main point of a scenario. If the only thing a scenario proves is one of these, drop it or replace it with one that can fail.

No near-duplicate scenarios. Two scenarios are duplicates when they capture the same value and assert the same relation after a near-identical action. Example: "clicked the button, the id changed" and "reloaded the page, the id changed" both capture the id and prove it changed — a click and a reload are the same trigger here. Keep only the single strongest one. This does NOT collapse scenarios that assert a DIFFERENT relation on the same value: "the id changed" and "the old id is now absent after reload" catch different regressions, so keep both.

Match the assertion to what the feature actually does:
- If the behavior is "a value changes" (a regenerating id, a rotating token, an incrementing counter, a shuffled order), the scenario must capture the value before the action and prove it is different after. The regression it catches: the value stopped changing. Name the capture-then-compare in the scenario, e.g. "captured the button id, reloaded, the id changed".
- If the behavior is "a value stays stable" (a stopped progress bar, a locked field, a pinned row), the scenario must prove the value did not change. The regression it catches: the value drifted when it should have held.
- Negative scenarios assert the failure state itself (the error message, the rejected input), not a success URL.
- Happy-path success must be tied to a signal you can actually see on this page, not an assumed redirect. Do not write "lands on /dashboard" or "redirects to /login" unless the snapshot gives you real evidence the page navigates there (a link to it, a stated next step, copy that names it). If you cannot confirm where a successful submit goes, do not invent a destination URL. Assert a plausible on-page success signal instead (a success or confirmation message, the form clearing, a logged-in control appearing) and say in the rationale that the post-submit state should be reviewed. A made-up redirect makes the test impossible to pass, so the Explorer would thrash on it; an observable signal can actually go green or red. The Explorer records the real post-submit state either way, so a wrong guess surfaces as a finding instead of a silent failure.

a11y category guidance — only propose an a11y scenario when one of these is verifiable from the page:
- A keyboard-only flow: Tab through the form, Enter / Space to activate, assert the resulting state. Name it like "completed login using keyboard only".
- Semantic structure: critical content uses a proper role (main, alert, navigation) or accessible name. Name it like "error message is announced via role=alert".
- DO NOT propose an a11y scenario that is merely "page renders" or "heading is visible" — those are happy-path, not accessibility.

Iframes — content inside a frame is the feature, not the chrome around it.
- The snapshot may include a "frames" array: real content found INSIDE iframes on the page (headings, form fields, editors, buttons, a text sample). Treat it as testable content, the same as top-level content.
- When a frame carries meaningful content (any text, a form field, an editor, an interactive element), you MUST plan at least one scenario that reads or interacts with content INSIDE that frame, and you MUST name the iframe in that scenario (use the word "iframe" or "frame") so the Explorer scopes into it.
- Do NOT plan only around the surrounding page chrome (navbar, theme toggle, dropdown menu) when a content-bearing iframe is present. On such a page the iframe content is the whole point.

Return strictly in this format, nothing else. The square brackets are LITERAL — include them in your output exactly as shown:

<plan>
1. [login][happy] logged in with valid credentials — fails if the success path stops landing on the inventory page
2. [login][negative] rejected an invalid password — fails if a wrong password is accepted or the inline error stops appearing
3. [cart][happy] added item to cart and the badge count went up — fails if add-to-cart stops writing state the user can see
4. [identifier][edge] captured the generated id, reloaded, the id changed — fails if the id stops regenerating and becomes a stable value
</plan>

Notice scenario 4: the page's whole point is that the id regenerates, so the test captures the id, forces a fresh load, and proves the new id differs from the old one. A scenario that merely checked the button is visible would pass even if the id were frozen — useless. Always plan the assertion that can actually fail.

The first bracket is the FEATURE tag — a short, lowercase, kebab-case noun (e.g. login, cart, search, checkout, registration, forgot-password). Use the feature names the caller asked for verbatim when steering. When inferring on your own, pick the most natural feature name for that page (e.g. "login" for an authentication form).

The second bracket is the CATEGORY (happy, negative, edge, a11y) — same as before.`;

/**
 * Rule-driven planning instructions, appended as a second system block ONLY
 * when a requirements map is present. Adjusts the base constraints: rules
 * come first, scenarios cite rule ids in a third bracket, and the ceiling
 * becomes per-feature. The falsifiability doctrine is unchanged.
 */
const RULE_PLANNING = `Rule-driven planning — these adjust the base constraints when REQUIREMENTS are present:
- Derive scenarios from the STATED rules first, DOM evidence second. A stated rule you can verify from this page always beats a scenario invented from the page alone.
- Every scenario that verifies one or more rules MUST cite the rule ids in a THIRD bracket after the category, comma-separated. Example:
    1. [login][negative][R3,R7] rejected a 5-character password — fails if the length rule stops being enforced
- A scenario discovered from the page that matches NO stated rule uses [-] as the third bracket:
    2. [login][edge][-] password field masks input — fails if the field renders the password as plain text
- Scenario ceiling with a map: up to 4 scenarios per feature listed in REQUIREMENTS (this replaces the 3-6 total constraint). Still at least one happy, one negative, and one edge scenario for every feature whose rules support them; do not force a category a feature's rules give no basis for.
- Never invent rules, features, or URLs beyond the REQUIREMENTS block.
- Falsifiability is unchanged: every scenario must still name the concrete regression it catches, and all the banned vacuous shapes remain banned.`;

const PLANNER_PRICE = { in: 1.0, out: 5.0 }; // Haiku 4.5 default

/** Poll interval for the snapshot settle — same cadence as pollRelation in tools.ts. */
const SETTLE_POLL_MS = 200;
/** Hard cap on how long we wait for the page to render before giving up loudly. */
const SETTLE_CAP_MS = 8_000;
/**
 * The content the Planner actually plans against: form controls and headings.
 * Deliberately EXCLUDES buttons and links — a single-page app ships those in
 * its static shell before it hydrates (the practicesoftwaretesting shell has a
 * "Testing Guide" button and a link at `load`, count never zero), so counting
 * them would make the settle declare victory on the shell and snapshot a page
 * with no form. Form controls and headings only appear once the real content
 * renders, so they are the honest readiness signal.
 */
const SETTLE_CONTENT_SELECTOR = 'input, textarea, select, h1, h2, h3';
/**
 * The readiness selector used INSIDE iframes. A frame-only page (ui.vision and
 * the other frame demos) has a near-empty top document, so the settle signal has
 * to come from frame content or the poll times out as "empty page" even though
 * the snapshot can read the frames. Frames have no SPA-shell problem (that is a
 * top-document concern), so this is broader than SETTLE_CONTENT_SELECTOR — it
 * also counts buttons and contenteditable editors, the content frames carry.
 */
const FRAME_SETTLE_SELECTOR = 'input, textarea, select, h1, h2, h3, button, [contenteditable=""], [contenteditable="true"]';

/**
 * Count the content the settle-poll waits for: top-document content PLUS content
 * inside every child frame. Top and frame counts use different selectors on
 * purpose (see FRAME_SETTLE_SELECTOR). A read that races a frame mid-navigation
 * throws "execution context destroyed"; that frame counts as 0 for this poll and
 * is re-read on the next one.
 */
async function countSettleContent(page: Page): Promise<number> {
  const top = await page
    .evaluate((sel) => document.querySelectorAll(sel).length, SETTLE_CONTENT_SELECTOR)
    .catch(() => 0);
  let inFrames = 0;
  const main = page.mainFrame();
  for (const frame of page.frames()) {
    if (frame === main) continue;
    inFrames += await frame
      .evaluate((sel) => document.querySelectorAll(sel).length, FRAME_SETTLE_SELECTOR)
      .catch(() => 0);
  }
  return top + inFrames;
}

/**
 * Wait for a client-rendered page to actually render its content before
 * snapshotting. Single-page apps (Angular, React) fire the `load` event before
 * they render their form, so a snapshot taken at `load` is empty — this is the
 * exact bug behind the 0-scenario plan on practicesoftwaretesting.com/auth/register
 * (0 content elements at load, 13 once the page rendered).
 *
 * This reuses the settle principle already in the codebase (pollRelation in
 * tools.ts): a loop that polls at a fixed small interval, bounded by a deadline,
 * and resolves the instant its condition holds. The condition here is "the count
 * of content elements (top document plus every child frame, see
 * countSettleContent) is non-zero and has stopped growing" — two consecutive
 * equal reads. A frame-only page (ui.vision/demo/webtest/frames) has an empty top
 * document, so the frame count is what lets it settle instead of failing as
 * empty. It is adaptive (a server-rendered page
 * returns on the first stable pair in ~200ms; a client-rendered form returns the
 * moment it mounts, ~1.5s; neither waits the full cap) and capped (the deadline).
 * It is not a hidden fixed sleep, and it does not add a second timing mechanism.
 *
 * Returns settled=false when the deadline passes without any content appearing.
 * The caller turns that into a loud failure rather than planning against a blank
 * or half-rendered page.
 */
export async function settleForSnapshot(page: Page, capMs = SETTLE_CAP_MS): Promise<{ settled: boolean; count: number }> {
  const deadline = Date.now() + capMs;
  let prev = -1;
  for (;;) {
    const cur = await countSettleContent(page);
    // Non-zero and unchanged since the previous poll → content has rendered and
    // the DOM has stopped growing. This is the early exit; a ready page reaches
    // it on the first stable pair rather than after a fixed delay.
    if (cur > 0 && cur === prev) return { settled: true, count: cur };
    if (Date.now() >= deadline) return { settled: false, count: cur };
    prev = cur;
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
}

/** One interactive element as the Planner sees it. */
export interface PickedEl {
  tag: string;
  role?: string;
  label?: string;
  type?: string;
}

/** Content found INSIDE one iframe, with the selector chain to reach it. */
export interface FrameSnapshot {
  /** Selector chain from the top page to this frame, e.g. ['iframe#frame1']. */
  frameChain: string[];
  url: string;
  headings: PickedEl[];
  inputs: PickedEl[];
  buttons: PickedEl[];
  /** Count of contenteditable regions (rich-text editors live in frames). */
  editable: number;
  /** A short sample of the frame's visible text, so plain-text frames register. */
  textSample: string;
}

/** The page summary the Planner plans against (top document + iframe content). */
export interface PageSnapshot {
  title: string;
  url: string;
  headings: PickedEl[];
  inputs: PickedEl[];
  buttons: PickedEl[];
  fillableCount: number;
  /** Content-bearing iframes on the page (empty when there are none). */
  frames: FrameSnapshot[];
}

/** Max frame nesting we will descend into, matches selectors.ts MAX_FRAME_DEPTH. */
const MAX_FRAME_DEPTH = 3;
/** Cap on how many content-bearing frames we record, so a page full of ad iframes can't blow up the snapshot. */
const MAX_FRAMES = 8;

/**
 * Read the top document into a snapshot, then enumerate content inside iframes.
 *
 * The top-document read is the original Planner snapshot (headings, inputs,
 * buttons, fillable count). The frames pass is new: without it the Planner only
 * sees the page chrome and never plans for the content INSIDE a frame, which on
 * an iframe-centric page (letcode.in/frame, demoqa.com/frames) is the actual
 * feature. Exported so the iframe smoke test can drive it against fixtures.
 */
export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  // Function declarations only — tsx injects `__name` wrappers for arrow
  // funcs assigned to consts, which break when serialized to page.evaluate.
  const top = await page.evaluate(() => {
    function pick(el: Element): { tag: string; role?: string; label?: string; type?: string } {
      const r = el as HTMLElement;
      return {
        tag: r.tagName.toLowerCase(),
        role: r.getAttribute('role') ?? undefined,
        label: (r.getAttribute('aria-label') ?? r.getAttribute('placeholder') ?? r.getAttribute('name') ?? (r.textContent ?? '').trim().slice(0, 80)) || undefined,
        type: (r as HTMLInputElement).type ?? undefined,
      };
    }
    // Count the controls the Explorer will actually act on (fill / select /
    // check). Excludes hidden fields and the submit/button/reset/image inputs,
    // which are clicks, not fills. This drives the form-aware step budget, so
    // it counts ALL such controls, not the display-capped `inputs` list below.
    function isFillable(el: Element): boolean {
      const tag = el.tagName.toLowerCase();
      if (tag === 'textarea' || tag === 'select') return true;
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      return !['hidden', 'submit', 'button', 'reset', 'image'].includes(type);
    }
    return {
      title: document.title,
      url: location.href,
      headings: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 8).map(pick),
      inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 25).map(pick),
      buttons: Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 25).map(pick),
      fillableCount: Array.from(document.querySelectorAll('input, textarea, select')).filter(isFillable).length,
    };
  });

  const frames = await enumerateFrames(page);
  return { ...top, frames };
}

/**
 * Build the selector chain that reaches a frame from the top page, preferring an
 * id (`iframe#frame1`), then a name (`iframe[name="..."]`), then a positional
 * fallback (`iframe >> nth=i`) — the same precedence selectors.ts uses. Handles
 * both `<iframe>` and frameset `<frame>` elements, emitting the matching tag so
 * the chain drives frameLocator on a frameset page too. Returns null when the
 * chain is deeper than MAX_FRAME_DEPTH or a hop can't be read.
 */
async function frameChainFor(frame: Frame): Promise<string[] | null> {
  const chain: string[] = [];
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    const handle = await f.frameElement();
    try {
      const tag = (await handle.evaluate((el) => (el as Element).tagName.toLowerCase())) === 'frame' ? 'frame' : 'iframe';
      const id = await handle.getAttribute('id');
      const name = await handle.getAttribute('name');
      if (id) chain.unshift(`${tag}#${id}`);
      else if (name) chain.unshift(`${tag}[name="${name}"]`);
      else {
        const idx = await handle.evaluate((el, t) => {
          const e = el as Element;
          return Array.from((e.ownerDocument || document).querySelectorAll(t)).indexOf(e);
        }, tag);
        chain.unshift(`${tag} >> nth=${idx < 0 ? 0 : idx}`);
      }
    } finally {
      await handle.dispose().catch(() => {});
    }
    f = f.parentFrame();
  }
  if (chain.length === 0 || chain.length > MAX_FRAME_DEPTH) return null;
  return chain;
}

/**
 * Read the content of every iframe on the page via Playwright's frame API, which
 * reaches frames regardless of origin (the same access path frameLocator uses).
 * Only content-bearing frames are kept, so tracking/ad iframes drop out.
 */
export async function enumerateFrames(page: Page): Promise<FrameSnapshot[]> {
  const out: FrameSnapshot[] = [];
  const main = page.mainFrame();
  for (const frame of page.frames()) {
    if (frame === main) continue;
    if (out.length >= MAX_FRAMES) break;
    let chain: string[] | null;
    try {
      chain = await frameChainFor(frame);
    } catch {
      continue; // frame detached or unreadable mid-walk
    }
    if (!chain) continue;
    try {
      // Give a still-loading frame a brief moment to render before reading it.
      await frame.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
      const content = await frame.evaluate(() => {
        function pick(el: Element): { tag: string; role?: string; label?: string; type?: string } {
          const r = el as HTMLElement;
          return {
            tag: r.tagName.toLowerCase(),
            role: r.getAttribute('role') ?? undefined,
            label: (r.getAttribute('aria-label') ?? r.getAttribute('placeholder') ?? r.getAttribute('name') ?? (r.textContent ?? '').trim().slice(0, 80)) || undefined,
            type: (r as HTMLInputElement).type ?? undefined,
          };
        }
        const bodyText = document.body ? (document.body.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200) : '';
        return {
          url: location.href,
          headings: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 8).map(pick),
          inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 25).map(pick),
          buttons: Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 25).map(pick),
          editable: document.querySelectorAll('[contenteditable=""], [contenteditable="true"]').length,
          textSample: bodyText,
        };
      });
      const snap: FrameSnapshot = { frameChain: chain, ...content };
      if (frameHasContent(snap)) out.push(snap);
    } catch {
      continue; // cross-origin evaluate blocked, or frame went away
    }
  }
  return out;
}

/**
 * A frame is worth planning against when it holds anything testable: a heading,
 * a form control, a button, an editor, or a meaningful run of text. Empty
 * tracking/ad frames (no headings, no controls, whitespace text) return false.
 */
export function frameHasContent(f: Pick<FrameSnapshot, 'headings' | 'inputs' | 'buttons' | 'editable' | 'textSample'>): boolean {
  return (
    f.headings.length > 0 ||
    f.inputs.length > 0 ||
    f.buttons.length > 0 ||
    f.editable > 0 ||
    f.textSample.trim().length >= 8
  );
}

/** A short human description of a frame's content, for the steering block. */
function describeFrame(f: FrameSnapshot): string {
  const bits: string[] = [];
  const labelled = f.headings.filter((h) => h.label).slice(0, 3).map((h) => JSON.stringify(h.label));
  if (labelled.length) bits.push(`heading(s): ${labelled.join(', ')}`);
  if (f.inputs.length) bits.push(`${f.inputs.length} input${f.inputs.length === 1 ? '' : 's'}`);
  if (f.buttons.length) bits.push(`${f.buttons.length} button${f.buttons.length === 1 ? '' : 's'}`);
  if (f.editable) bits.push(`${f.editable} editable region${f.editable === 1 ? '' : 's'}`);
  if (f.textSample) bits.push(`text: ${JSON.stringify(f.textSample.slice(0, 80))}`);
  return bits.join('; ') || 'content';
}

/**
 * Does a planned scenario already read or interact with content inside a frame?
 * The SYSTEM rule asks the model to name the iframe explicitly, so the presence
 * of "iframe" / "frame" in the name or rationale is the coverage marker.
 */
export function scenarioCoversFrame(s: PlannedScenario): boolean {
  return /\b(iframe|frames?|frame-?locator)\b/i.test(`${s.name} ${s.rationale}`);
}

/** Build one inside-frame scenario from a frame's content as a fallback. */
function synthFrameScenario(f: FrameSnapshot): PlannedScenario {
  const heading = f.headings.find((h) => h.label)?.label;
  const input = f.inputs.find((i) => i.label)?.label;
  if (input) {
    return {
      feature: 'iframe',
      category: 'happy',
      name: `filled "${input}" inside the iframe and the value stuck`,
      rationale: 'fails if the field inside the iframe cannot be reached via frameLocator, so typing into the frame regresses',
    };
  }
  if (heading) {
    return {
      feature: 'iframe',
      category: 'happy',
      name: `read "${heading}" inside the iframe`,
      rationale: 'fails if the iframe content cannot be read from inside the frame (a frameLocator regression) or the frame stops loading',
    };
  }
  return {
    feature: 'iframe',
    category: 'happy',
    name: 'read the content inside the iframe',
    rationale: 'fails if the iframe content cannot be reached from inside the frame (a frameLocator regression)',
  };
}

/**
 * Guarantee that a page with content-bearing iframes gets at least one scenario
 * that reads or interacts with content INSIDE a frame. If the model already
 * planned one (it named the iframe), nothing changes. Otherwise one inside-frame
 * scenario, synthesized from the first content frame, is prepended. When the
 * page has no content-bearing frame, the plan is returned untouched.
 */
export function ensureIframeCoverage(
  scenarios: PlannedScenario[],
  frames: FrameSnapshot[],
): { scenarios: PlannedScenario[]; injected: PlannedScenario | null } {
  const contentFrames = (frames ?? []).filter(frameHasContent);
  if (contentFrames.length === 0) return { scenarios, injected: null };
  if (scenarios.some(scenarioCoversFrame)) return { scenarios, injected: null };
  const injected = synthFrameScenario(contentFrames[0]!);
  return { scenarios: [injected, ...scenarios], injected };
}

export async function plan(opts: {
  url: string;
  model?: string;
  apiKey?: string;
  /**
   * Optional feature list (e.g. ['login', 'cart']). When present, the Planner
   * is steered to propose scenarios ONLY for these features instead of
   * inferring 2-3 highest-signal flows from the homepage. Empty array or
   * undefined → infer-from-homepage (legacy behaviour).
   */
  features?: string[];
  /**
   * Optional requirements map built from an SRS (--srs). When present, a
   * REQUIREMENTS system block lists every stated rule, planning becomes
   * rule-first (scenarios cite rule ids in a third bracket), and the scenario
   * ceiling rises to up to 4 per map feature. When absent, the Planner's
   * input and output format are byte-identical to the pre-SRS behaviour.
   */
  requirements?: RequirementsMap;
}): Promise<PlanResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  const model = opts.model ?? process.env.QA_CORE_MODEL_PLANNER ?? 'claude-haiku-4-5';
  const client = new Anthropic({ apiKey });

  // Take one snapshot — title + visible interactive elements.
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    await installEvalShim(ctx);
    const page = await ctx.newPage();
    await page.goto(opts.url, { waitUntil: 'load' });
    // SPAs render their form after `load` fires. Wait for the DOM to populate
    // and stop growing before snapshotting, otherwise the Planner plans against
    // a blank page and returns nothing. If it never settles within the cap, that
    // is a loud failure with a reason, not a silent snapshot of a partial page.
    const settle = await settleForSnapshot(page);
    if (!settle.settled) {
      throw new Error(
        `Planner could not capture a stable snapshot of ${opts.url} within ${SETTLE_CAP_MS}ms. ` +
          `The page may not have rendered its content (saw ${settle.count} form control${settle.count === 1 ? '' : 's'}/heading${settle.count === 1 ? '' : 's'}). ` +
          `Confirm the URL loads in a browser, then try again.`,
      );
    }
    const snapshot = await snapshotPage(page);

    // When the caller passed a feature list, append explicit steering text so
    // the Planner produces scenarios ONLY for those features. This makes
    // `--features login,cart` actually change what the agent tests, instead
    // of just decorating the README.
    const features = (opts.features ?? []).filter((f) => f && f.trim().length > 0);
    const steeringBlock = features.length > 0
      ? `\n\nThe user has asked for scenarios covering THESE features ONLY:\n${features.map((f) => `  - ${f}`).join('\n')}\n\n` +
        `Rules when steering:\n` +
        `- Propose 1-3 scenarios per listed feature.\n` +
        `- Do NOT propose scenarios for other features visible on the page (e.g. don't add a search scenario if the user only asked for login).\n` +
        `- If a requested feature is not visible on this homepage snapshot (e.g., a checkout flow only reachable after login), STILL propose scenarios for it — the Explorer can navigate to find it.\n` +
        `- Across all listed features combined, stay within the 3-6 scenarios overall constraint.`
      : '';

    // When the page has content-bearing iframes, anchor the Planner on that
    // content explicitly. The SYSTEM rule already forbids planning only around
    // chrome, but listing the real frame content here makes Haiku act on it.
    const contentFrames = snapshot.frames.filter(frameHasContent);
    const iframeBlock = contentFrames.length > 0
      ? `\n\nThis page has ${contentFrames.length} content-bearing iframe${contentFrames.length === 1 ? '' : 's'}. ` +
        `The iframe content is the feature of this page, not the surrounding chrome. ` +
        `You MUST include at least one scenario that reads or interacts with content INSIDE an iframe, and name the iframe in that scenario. Frame contents:\n` +
        contentFrames.map((f, i) => `  frame ${i + 1} (${f.frameChain.join(' > ')}): ${describeFrame(f)}`).join('\n')
      : '';

    // Rule-driven planning: when a requirements map is present, a second system
    // block lists the stated rules and switches the constraints to rule-first.
    // It is appended AFTER the cached base SYSTEM block so the cache prefix is
    // untouched, and it is absent entirely without a map, so the no-SRS prompt
    // stays byte-identical to the pre-SRS behaviour.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam,
    ];
    if (opts.requirements) {
      systemBlocks.push({ type: 'text', text: `${renderRequirementsBlock(opts.requirements)}\n\n${RULE_PLANNING}` } as Anthropic.TextBlockParam);
    }

    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: systemBlocks,
      messages: [
        {
          role: 'user',
          content: `URL: ${opts.url}\n\nPage snapshot:\n${JSON.stringify(snapshot, null, 2)}${steeringBlock}${iframeBlock}\n\nPropose scenarios.`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const parsed = parsePlan(text);
    // Reject circular unchanged-assertions (capture a value, reload/no-op, assert
    // it equals itself) before de-dup, so a vacuous test never reaches the plan.
    const { kept: notCircular, rejected } = rejectCircular(parsed);
    const { kept, dropped } = dedupePlan(notCircular);
    // Guarantee iframe coverage deterministically. The SYSTEM rule + steering
    // block ask the model to plan an inside-frame scenario, but a prompt nudge
    // can miss. When the page has content-bearing iframes and the plan still
    // ignores them, synthesize one inside-frame scenario so the frameLocator
    // path is always exercised on such a page. Runs last so the injected
    // scenario is not dropped by dedup or rejected as circular.
    const { scenarios: covered, injected } = ensureIframeCoverage(kept, snapshot.frames);
    if (injected) {
      console.log(`Planner: injected an inside-frame scenario (no model scenario covered the iframe): ${injected.name}`);
    }
    const u = response.usage;
    const costUsd = (u.input_tokens * PLANNER_PRICE.in + u.output_tokens * PLANNER_PRICE.out) / 1_000_000;

    return { scenarios: covered, pageTitle: snapshot.title, costUsd, dropped, rejected, fillableFields: snapshot.fillableCount };
  } finally {
    await browser.close();
  }
}

/**
 * Parse the Planner's response into scenarios. Accepts the rule-driven
 * three-bracket format, the v3.1 two-bracket format, and all four legacy
 * variants. Exported so smoke-plan-rule-tags locks the REAL parser (the older
 * smoke-planner-parse predates the export and tests a mirror).
 */
export function parsePlan(text: string): PlannedScenario[] {
  const m = text.match(/<plan>([\s\S]*?)<\/plan>/i);
  const body = m && m[1] ? m[1] : text;
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+[.)]/.test(l));
  const out: PlannedScenario[] = [];
  for (const raw of lines) {
    // First try the feature-tagged formats:
    //   v4 (rule-driven): "1. [feature][category][R1,R3] name — rationale"
    //                     "1. [feature][category][-] name — rationale"
    //   v3.1:             "1. [feature][category] name — rationale"
    // The third bracket is OPTIONAL: without a requirements map the model never
    // emits it and this regex parses the v3.1 lines exactly as before.
    const withFeature = raw.match(
      /^\d+[.)]\s*\[([a-z][a-z0-9-]*)\]\s*\[?(happy|negative|edge|a11y)\]?\s*(?:\[\s*(-|[Rr]\d+(?:\s*,\s*[Rr]\d+)*)\s*\])?\s*[:\-—–]?\s*(.+?)\s*[—–]+\s*(.+)$/i,
    );
    if (withFeature && withFeature[1] && withFeature[2] && withFeature[4] && withFeature[5]) {
      const ruleBracket = withFeature[3];
      const ruleIds = ruleBracket === undefined
        ? undefined
        : ruleBracket.trim() === '-'
          ? []
          : ruleBracket.split(',').map((r) => r.trim().toUpperCase()).filter((r) => /^R\d+$/.test(r));
      out.push({
        feature: withFeature[1].toLowerCase(),
        category: withFeature[2].toLowerCase() as PlannedScenario['category'],
        name: withFeature[4].trim(),
        rationale: withFeature[5].trim(),
        ...(ruleIds !== undefined ? { ruleIds } : {}),
      });
      continue;
    }
    // Forgiving fallback. Haiku has shown four distinct format variants across
    // older runs (kept for back-compat):
    //   "1. [happy] name — rationale"     ← what the prompt used to ask for
    //   "1. happy name — rationale"       ← drops the brackets
    //   "1. happy — name — rationale"     ← em-dash after the category
    //   "1. happy: name — rationale"      ← colon after the category
    // All carry the same meaning. We accept any of them. Hyphen is NOT allowed
    // as the name-rationale separator (it appears inside many real words like
    // "well-formed"); only em-dash / en-dash count.
    const match = raw.match(/^\d+[.)]\s*\[?(happy|negative|edge|a11y)\]?\s*[:\-—–]?\s*(.+?)\s*[—–]+\s*(.+)$/i);
    if (match && match[1] && match[2] && match[3]) {
      out.push({
        name: match[2].trim(),
        category: match[1].toLowerCase() as PlannedScenario['category'],
        rationale: match[3].trim(),
      });
    }
  }
  return out;
}

/**
 * The relation a capture-and-compare scenario asserts, read from the plan text.
 * Order matters: checked top to bottom, first match wins. `absent` comes before
 * the count relations so "no longer found" is not misread as "decreased", and
 * `changed` is last because its keyword set is the broadest.
 */
const RELATION_CLASSES: Array<{ cls: string; patterns: RegExp[] }> = [
  { cls: 'absent', patterns: [/\bno longer (?:match|exist|present|found|appear)/, /\bnot found\b/, /\bgone\b/, /\bdisappear/, /\babsent\b/] },
  { cls: 'increased', patterns: [/\bincreas/, /\bwent up\b/, /\bgreater\b/, /\bincrement/, /\bgrew\b/] },
  { cls: 'decreased', patterns: [/\bdecreas/, /\bwent down\b/, /\bfewer\b/, /\bdecrement/] },
  { cls: 'unchanged', patterns: [/\bunchanged\b/, /\bdid ?n.?t change\b/, /\bstays?\b/, /\bstayed\b/, /\bheld\b/, /\bremained\b/, /\bstable\b/, /\bfrozen\b/, /\bpinned\b/, /\blocked\b/] },
  { cls: 'changed', patterns: [/\bchanged\b/, /\bregenerat/, /\bdiffer/, /\brotat/, /\bshuffl/, /\bnew (?:id|value|token|order)\b/, /\bre-?render/] },
];

/** Concrete nouns that name the value a scenario captures. */
const VALUE_NOUNS = ['id', 'count', 'token', 'order', 'badge', 'total', 'price', 'quantity', 'qty', 'value', 'number', 'timestamp', 'nonce', 'position', 'index'];

/**
 * A signature for capture-and-compare scenarios: feature + relation + value
 * noun. Returns null when the scenario does not read as a capture-and-compare
 * (no relation or no value noun found), so non-capture scenarios are never
 * treated as duplicates of each other.
 */
function captureSignature(s: PlannedScenario): string | null {
  // Read the relation and value from the NAME only — the name states the
  // outcome the scenario asserts. The rationale states "fails if X", which
  // names the opposite relation (e.g. "fails if it becomes a stable value")
  // and would invert the signal.
  const hay = s.name.toLowerCase();
  let rel: string | null = null;
  for (const r of RELATION_CLASSES) {
    if (r.patterns.some((p) => p.test(hay))) { rel = r.cls; break; }
  }
  if (!rel) return null;
  let noun: string | null = null;
  for (const n of VALUE_NOUNS) {
    if (new RegExp(`\\b${n}\\b`).test(hay)) { noun = n; break; }
  }
  if (!noun) return null;
  const feat = (s.feature ?? '').toLowerCase() || '∅';
  return `${feat}|${rel}|${noun}`;
}

/**
 * The assertion reads "the value stayed the same" (unchanged / equal / persists).
 * Broader than the dedup `unchanged` class on purpose: it also catches "equals
 * itself", "same value", "identical", "no change" — the phrasings a circular
 * test uses.
 */
const UNCHANGED_RE = /\bunchanged\b|\bdid ?n.?t change\b|\bno change\b|\bstays?\b|\bstayed\b|\bheld\b|\bhold\b|\bremain\w*|\bstable\b|\bfrozen\b|\bpinned\b|\blocked\b|\bequals?\b|\bidentical\b|\bsame\b|\bmatches?\s+itself\b|\bpersist\w*/i;

/**
 * A context where a real force could plausibly have changed the value, so an
 * "unchanged" assertion is meaningful (it proves the value HELD against that
 * force). The progress bar that stopped, a field that is locked/read-only, a
 * row pinned against a re-sort, a value read during/after an animation.
 */
const DYNAMIC_HELD_RE = /\bprogress\b|\banimat\w*|\bspinner\b|\bcountdown\b|\btimer\b|\bstop(?:ped|ping|s)?\b|\bhalt\w*|\bsettl\w*|\bfroze\b|\bfrozen\b|\bfreez\w*|\bloading\b|\bpinned\b|\block(?:ed|s|ing)?\b|\bdisabl\w*|\breadonly\b|\bread-only\b|\battempt\w*|\btried?\b|\bwhile\b|\bduring\b/i;

/**
 * A trigger that reproduces the SAME value rather than changing it: a reload or
 * refresh of a static page, revisiting/re-opening the page, or phrasing that
 * literally compares the value to itself. Reloading a static page is not a
 * state-changing action.
 */
const RELOAD_NOOP_RE = /\breload\w*|\brefresh\w*|\bre-?visit\w*|\bre-?open\w*|\bre-?navigat\w*|\bnavigat\w*\s+back\b|\bequals?\s+itself\b|\bto\s+itself\b|\bagainst\s+itself\b|\bsame\s+(?:value|id|text|content|cell|row|count|number)\b/i;

/** A genuine state-changing action that could have altered the captured value. */
const MUTATING_ACTION_RE = /\bclick\w*|\bpress\w*|\bsubmit\w*|\bfill\w*|\bpopulat\w*|\btype\w*|\benter\w*|\bedit\w*|\bsort\w*|\bfilter\w*|\btoggl\w*|\bcheck\w*|\bunchecked?\b|\bselect\w*|\bdrag\w*|\bdrop\w*|\bdelete\w*|\bremov\w*|\badd\w*|\bupdat\w*|\bchang\w*|\bmodif\w*|\bsav\w*|\bupload\w*|\bclear\w*|\bresize\w*/i;

/** Nouns that mark a scenario as a value-capture (scopes the circular check to capture-compare tests). */
const CAPTURE_VALUE_NOUNS = [...VALUE_NOUNS, 'cell', 'text', 'content', 'row', 'field', 'attribute', 'amount'];

/**
 * Returns a reason string when the scenario is a circular unchanged-assertion:
 * it captures a value and asserts the value did not change, but nothing between
 * the capture and the compare could have changed it (a reload of a static value,
 * or no action at all). Such an assertion compares a value to itself, so it can
 * never fail and catches no regression. Returns null for a valid scenario.
 *
 * An "unchanged" assertion is valid when the scenario names a force that could
 * plausibly have changed the value (a stopped animation, a locked field, a row
 * pinned against a re-sort) or a real state-changing action other than a reload.
 */
export function circularUnchangedReason(s: PlannedScenario): string | null {
  const hay = s.name.toLowerCase();
  // Only a value-capture scenario can be circular in this sense.
  const hasValueNoun = CAPTURE_VALUE_NOUNS.some((n) => new RegExp(`\\b${n}\\b`).test(hay));
  if (!hasValueNoun) return null;
  // Only an unchanged/equality assertion can compare a value to itself.
  if (!UNCHANGED_RE.test(hay)) return null;
  // A real force could have changed it → the unchanged assertion is meaningful.
  if (DYNAMIC_HELD_RE.test(hay)) return null;
  const isReloadOrNoop = RELOAD_NOOP_RE.test(hay);
  const hasMutatingAction = MUTATING_ACTION_RE.test(hay) && !isReloadOrNoop;
  if (hasMutatingAction) return null;
  return 'circular unchanged-assertion: the captured value is compared to itself with no state-changing action in between (a reload of a static value or a no-op), so it can never fail';
}

/**
 * The assertion checks that something is NOT there: not present, not found, no
 * longer exists, absent, gone, removed.
 */
const ABSENCE_RE = /\bnot\s+(?:exist\w*|present|found|there|visible|displayed|render\w*)\b|\bdoes\s?n.?t\s+exist\b|\bdoes\s+not\s+exist\b|\bis\s?n.?t\s+(?:present|there|found|visible)\b|\bno\s+longer\b|\babsent\b|\bnot\s+found\b|\bdoes\s?n.?t\s+(?:appear|show|render)\b|\bnonexistent\b|\bnon-existent\b|\bgone\b|\bdisappear\w*/i;

/**
 * The target named in the scenario is an invented, never-real identifier: a
 * "nonexistent" / "fake" / "bogus" / "made-up" thing, or a junk literal nobody
 * expected to find (xyz, foobar, asdf). Asserting such a thing is absent can
 * never fail, because it was never there to begin with.
 */
const FAKE_IDENTIFIER_RE = /\bnonexistent\b|\bnon-existent\b|\bnon-?existing\b|\bdoes-?not-?exist\w*\b|\bfake\b|\bbogus\b|\bdummy\b|\bgarbage\b|\bmade-?up\b|\bmadeup\b|\bimaginary\b|\bnot-?real\b|\bnotreal\b|\bnonsense\b|\bfictional\b|\binvented\b|\brandom-?(?:name|id|frame|string|value|word|text)\b|\binvalid-?(?:name|id|frame|selector)\b|\bxyz\b|\bfoobar\b|\bfoo-?bar\b|\basdf\w*\b|\bqwerty\b|\bzzz+\b|\b\w*-xyz\b|\b\w*-?doesnotexist\b/i;

/**
 * An action that makes a REAL element go away: removed, deleted, hidden,
 * filtered out, cleared, dismissed, closed, logged out, collapsed, unchecked.
 * Narrower than the general mutating-action set so a verify verb ("check") or a
 * selector noun ("selector") is not read as a removal.
 */
const REMOVAL_ACTION_RE = /\bremov\w*|\bdelet\w*|\bhid\w*|\bhidden\b|\bfilter\w*|\bclear\w*|\bdismiss\w*|\bclos\w*|\blogged?\s?out\b|\bsigned?\s?out\b|\bcollaps\w*|\bcancel\w*|\bunchecked?\b|\buncheck\w*/i;

/**
 * Returns a reason when the scenario asserts the absence of a hardcoded fake
 * identifier that was never expected to exist. "the nonexistent-frame-xyz frame
 * does not exist" can never go red, because nothing on any version of the page
 * was ever named that, so the test catches no regression. Returns null for a
 * real absence test (something that existed and was removed, hidden, or filtered
 * out), which is a legitimate negative test.
 */
export function vacuousAbsenceReason(s: PlannedScenario): string | null {
  const hay = s.name.toLowerCase();
  if (!ABSENCE_RE.test(hay)) return null;
  if (!FAKE_IDENTIFIER_RE.test(hay)) return null;
  // A real thing that an action removed, hid, or filtered out is a valid absence
  // test, even if the scenario also uses a junk-looking word somewhere. The
  // removal is what makes the absence meaningful: it WAS there, then it went
  // away. This is narrower than the general mutating-action set on purpose, so a
  // verify verb ("check") or a selector noun ("selector") is not mistaken for a
  // real removal.
  if (REMOVAL_ACTION_RE.test(hay)) return null;
  return 'vacuous absence assertion: the scenario asserts a hardcoded fake identifier is absent, but it was never expected to exist, so the assertion can never fail and catches no regression';
}

/**
 * Remove unfalsifiable scenarios at plan time. Two shapes catch no regression:
 * a circular unchanged-assertion (capture a value, reload or do nothing, assert
 * it did not change) and a vacuous absence assertion (assert a hardcoded fake
 * identifier is absent when it never existed). The kept list preserves plan
 * order; rejected entries name why.
 */
export function rejectCircular(scenarios: PlannedScenario[]): {
  kept: PlannedScenario[];
  rejected: Array<{ scenario: PlannedScenario; reason: string }>;
} {
  const kept: PlannedScenario[] = [];
  const rejected: Array<{ scenario: PlannedScenario; reason: string }> = [];
  for (const s of scenarios) {
    const reason = circularUnchangedReason(s) ?? vacuousAbsenceReason(s);
    if (reason) rejected.push({ scenario: s, reason });
    else kept.push(s);
  }
  return { kept, rejected };
}

/**
 * Drop near-duplicate scenarios. Two scenarios are near-duplicates when they
 * capture the same value and assert the same relation under the same feature —
 * for example a click-regenerates-id and a reload-regenerates-id pair that both
 * prove the id changed. The first one in plan order is kept; later matches are
 * dropped. Scenarios that assert a different relation on the same value (changed
 * vs absent) have different signatures and both survive. Scenarios that are not
 * capture-and-compare (no signature) are never dropped.
 */
export function dedupePlan(scenarios: PlannedScenario[]): {
  kept: PlannedScenario[];
  dropped: Array<{ scenario: PlannedScenario; duplicateOf: PlannedScenario }>;
} {
  const kept: PlannedScenario[] = [];
  const dropped: Array<{ scenario: PlannedScenario; duplicateOf: PlannedScenario }> = [];
  const seen = new Map<string, PlannedScenario>();
  for (const s of scenarios) {
    const sig = captureSignature(s);
    if (sig && seen.has(sig)) {
      dropped.push({ scenario: s, duplicateOf: seen.get(sig)! });
      continue;
    }
    if (sig) seen.set(sig, s);
    kept.push(s);
  }
  return { kept, dropped };
}
