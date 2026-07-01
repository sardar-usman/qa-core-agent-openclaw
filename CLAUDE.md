# QA-Core — project rules for Claude

This file is loaded automatically into Claude Code's context at the start of every conversation in this project. Anything here is "free" context — no need to re-explain.

---

## Project identity

QA-Core is an autonomous QA agent that drives a real browser, reviews its own work, and emits a complete Playwright test framework where every line passes 5 independent executions in fresh browser contexts before the file is written.

Built on:

- **Claude** (via Anthropic SDK) — Opus 4.7 for exploration, Sonnet 4.6 for review/heal/generate, Haiku 4.5 for planning
- **Playwright** + TypeScript — the test framework and the live browser the agent drives
- **OpenClaw** — the persona, channel routing, and slash-command layer
- **MCP** — for native integration in Claude Desktop, Cursor, Cline, etc.

It is also Muhammad Usman's flagship portfolio project, positioning him as an AI Test Engineering Lead. Output quality matters because it ships publicly.

---

## The five-stage pipeline (do not break this order or skip stages)

| Stage | Module | Cost | Job |
|---|---|---|---|
| 1. Planner | `src/agent/planner.ts` | Haiku ~$0.001 | One page snapshot → numbered scenario list |
| 2. Explorer | `src/agent/runtime.ts` + `src/agent/tools.ts` | Opus ~$0.10–$0.30 | Drives Chromium via tool-use, records verified trace |
| 3. Critic | `src/agent/critic.ts` | Sonnet ~$0.005 | Per-scenario verdict — `ship` / `weak` / `fix` |
| 4. Reality-Check Replay | `src/agent/replay.ts` | Zero LLM | Re-runs each scenario once in a fresh context, drops failures |
| 5. Stability Iteration | `src/agent/stability.ts` | Zero LLM | Re-runs each survivor 3× more, drops flakes |

Output is then transcribed by `pom.ts` (default — full POM framework) or `transcriber.ts` (`--no-pom` — single inline file).

---

## Key invariants — every fix must preserve these

1. **Every emitted scenario contains at least one assertion.** Enforced in `tools.ts` (`end_scenario`, `finish`) and `runtime.ts` (force-push guard at the end of the explore loop).
2. **The selector cascade only claims a level when it resolves to exactly one element.** When ambiguous, the `ambiguous` flag is set on `SelectorRecord` and `.first()` is honestly emitted by both replay and the transcriber.
3. **`toHaveCount` uses the multi-match locator, NOT the `.first()`-wrapped one.** Uses `baseLocator` from `replay.ts` and strips `ambiguous` from the recorded step.
4. **Every scenario starts from a clean state.** `begin_scenario` clears cookies + storage. The transcribed spec emits a matching `beforeEach`.
5. **All `page.evaluate` calls work under `tsx`.** `installEvalShim(ctx)` from `src/agent/eval-shim.ts` must be called on every new browser context, immediately after `browser.newContext()`. Without it, `tsx`'s `__name` keepNames helper crashes the evaluated function.
6. **The Planner parser accepts the v3.1 `[feature][category]` format AND all 4 legacy variants.** Don't tighten the regex without re-running `scripts/smoke-planner-parse.ts`.
7. **Dashboard per-site math divides by `runsWithPass`, not total runs** ([qa-core-ui.html#L4044](qa-core-ui.html)). Don't revert this.
8. **Framework dir name is `<brand>-automation-framework`.** Brand is the hostname with `www.` stripped and the TLD dropped (e.g. `www.saucedemo.com` → `saucedemo`). Use the `frameworkDirName()` / `brandSlug()` helpers exported from `src/agent/scaffold.ts`; do not hand-roll.
9. **Page objects are grouped by `feature`, not by URL pathname.** The Planner tags each scenario with a feature (e.g. `login`, `cart`). `pom.ts` emits one `pages/<feature>-page.{ts,js}` (kebab-case filename, PascalCase class) per feature and one spec per feature at `tests/<feature>/<feature>.spec.{ts,js}`. The a11y audit lives at `tests/a11y/landing.a11y.spec.{ts,js}` (inside `tests/` so it's picked up by the default `testDir: './tests'` — no manual `--testDir` flag needed). Scenarios without a feature fall back to URL-pathname grouping (legacy traces).
10. **Both TypeScript AND JavaScript output paths must stay clean.** TS emits `playwright.config.ts` + `tsconfig.json` + TS syntax. JS emits `playwright.config.js` (CommonJS) + NO `tsconfig.json` + `// @ts-check` JSDoc helpers. The agent must produce a fully runnable project in either language — `cd <out> && npm install && npx playwright test` must work for both.
12. **Each form control gets the action Playwright supports for it.** You cannot `fill()` a `<select>` (it throws "Element is not an <input>"), a checkbox, or a file input. The Explorer detects the real element type before acting (`controlKind` in `tools.ts`, via `loc.evaluate`): `<select>` → `selectOption` (by value, label, or index), checkbox/radio → `check`/`uncheck`, file input → `setInputFiles`, text input/textarea → `fill`. There are dedicated tools (`select_option`, `set_checked`, `set_input_files`), AND `fill` itself auto-routes to the right one as a safety net and records the matching TraceStep kind (`select_option` / `set_checked` / `set_input_files`), so the emitted spec is correct in both the inline transcriber and POM paths. `get_dom` lists each `<select>`'s options so the agent passes a real value. Radios are only ever checked (you cannot uncheck a radio).
11. **Runtime values are captured, never invented.** The `capture` tool reads a real value off the page (an attribute, text, or count) into a named var; `assert_compare` re-reads after an action and asserts a relation against the captured var (`changed` / `unchanged` / `equal` / `greater` / `less` / `absent`). The captured value is always the live page value, never a literal the model writes. This is the ONE mechanism for "value at runtime" assertions. The old `assert_freeze` TraceStep kind is gone — `assert_freeze` survives only as a model-facing tool whose handler records the general `capture` + `stability_wait` + `assert_compare(unchanged, bounds)` sequence (for aria-valuenow the bounds prove the bar stopped mid-range). Do not re-add a special-case two-sample path. The emitted spec must keep the action (click/reload) between the two reads, or the compare can never go red — `pom.ts` emits the first navigate as the `beforeEach` goto and every later navigate as an inline `page.goto`.

13. **An outcome assertion that keeps failing becomes a finding, it does not thrash.** Each assert is counted by signature (type + expected value + target hint) in `ctx._assertFailures`. The count is keyed by signature and PERSISTS across `begin_scenario` on purpose: a happy path that keeps not redirecting is restarted by the model (its own choice, or a gate rejection), and if the count reset on every restart the cap could never accumulate. A signature's count is cleared only when that exact assertion finally PASSES. The first failure returns `ok:false` so the model gets one honest retry. On the `OUTCOME_RETRY_CAP`-th failure of the SAME assertion (cap = 2, in `tools.ts`), the Explorer stops: `captureActualState` reads the real URL plus any visible alert/validation/toast/status text, a finding is pushed to `ctx.findings`, the half-built scenario is dropped (`ctx.current = null`, never shipped green), and `ctx._blockUntilNewScenario` is set so every action tool is rejected cheaply until the next `begin_scenario` or `finish`. This is the cost lever that stops the Explorer re-filling a whole form against a success signal that was assumed, not verified. Findings flow through `RunReport.findings` into reconciliation, so the funnel is `planned === generated + dropped + incomplete + findings`. The matching Planner principle (in `planner.ts` SYSTEM) forbids asserting an assumed redirect for a happy path: assert an observable on-page success signal, or record the post-submit state for review. The companion cost lever: `wait()` is rejected inside a scenario (a recorded hard sleep is always gate-rejected at `end_scenario`, which forces a full re-fill); the model is steered to `wait_for_text` or a timeout assertion. `wait()` outside a scenario (orientation/settling) is still allowed. Locked by `smoke-retry-cap`.

14. **Creation-flow fields are generated, not hard-coded; data the model invents is overridden at the tool.** A registration happy path cannot reuse a fixed email (the second run hits a duplicate) or a fixed password (a strength / data-leak check rejects a weak or breached value). `src/agent/unique-data.ts` is the single source of truth in three places that must agree: exploration (`tools.ts` fill handler), replay + 3x stability (`replay.ts`), and the emitted spec (`helpers/unique-data.{ts,js}`, imported by `pom.ts`; inlined by `transcriber.ts`). `detectUniqueField` fires ONLY on a happy creation flow (`regist|sign up|create|join|...`): an email field generates `uniqueEmail()` (fresh per call, so each scenario gets a distinct email), a username/handle generates `uniqueToken()`, a password generates `uniquePassword()` (memoized once per process so a confirm-password field matches, strong enough to clear a data-leak gate). Negative/edge scenarios and login flows keep their literals on purpose (a deliberate duplicate-email or weak-password test must stay literal). The fill tool generates the real value and records it on the TraceStep (`generate` kind), so a value the model typed is overridden, never trusted. Locked by `smoke-unique-data`.

15. **A scenario that finished its expensive work may close out a few steps past the budget.** The step budget (`6 + 14n`, in `runtime.ts`) assumes ~14 calls per scenario, but a 12-field form spends 12 on fills alone, so a full-form scenario reaching its closing assertion right at the budget line would be thrown away for one or two cheap steps. The `CLOSEOUT_GRACE` window (4, in `tools.ts`) lets the CURRENT scenario's closing calls (`assert` / `assert_compare` / `capture` / `end_scenario`) run just past the budget so the fill work ships. It does NOT widen the budget for new work: `begin_scenario` and every action tool stay blocked over budget, so the grace can never start a scenario or re-fill a form, and beyond the window only `finish()` runs. A scenario still mid-fill when the budget hits is NOT salvaged (it has no assertion yet), which is correct. Do not raise the step budget number to fix form-heavy pages; that only inflates cost. Locked by `smoke-closeout-grace`.

16. **Inside a table, positional selectors are a valid address, not a fragility.** Gate RULE 3 rejects positional CSS (`:nth-child`, `:nth-of-type`, `:first-child`, `:last-child`) on capture/assert_compare because such selectors drift when the DOM re-renders. But a table cell HAS no role or id of its own: "row 1, column 1" is inherently positional, and its content changes by design when you sort, which is exactly what a sort test must read. `isTablePositionalSelector()` in `gate.ts` carves a scoped exception: when the selector targets a table (a `table`/`thead`/`tbody`/`tfoot`/`tr`/`td`/`th` structural element, or a `row`/`cell`/`columnheader`/`rowheader`/`gridcell`/`grid`/`table` ARIA role), positional pseudo-classes and deep table chains are ALLOWED for capture/assert_compare (RULE 3a) and dynamic CSS assertions (RULE 3b). The exception is scoped, not global: positional selectors OUTSIDE a table stay fragile and rejected, and a hashed/auto-generated class (`.css-1a2b3c`) is fragile even inside a table, so it is still rejected. Prefer table-scoping the selector (`#table2 ...`) and role-based row/cell locators where they resolve, but do NOT drop the scenario when positional CSS within a known table is the only path. Locked by `smoke-table-gate`.

17. **A captured value compared to itself is rejected at plan time as circular.** A scenario that captures a value, reloads the page or does nothing, then asserts the value is unchanged compares the value to itself: the assertion can never go red, so it catches no regression (the Critic flags it, but that is after the cost is spent). `circularUnchangedReason()` / `rejectCircular()` in `planner.ts` drop it before the plan reaches the Explorer, alongside the dedup pass. The rule is general: an "unchanged"/equality assertion on a captured value (`value`, `id`, `count`, `cell`, `text`, ...) is circular UNLESS the scenario names a force that could plausibly have changed the value (a stopped progress bar, a locked field, a row pinned against a re-sort, an animation) OR a real state-changing action other than a reload (click/edit/sort/toggle/...). Reloading a static page reproduces the same value, so it is NOT such an action. Rejected scenarios are logged (`Rejected circular scenario: ...`) and, like dedup drops, removed before `report.plan` so the reconciliation funnel stays balanced. The Planner SYSTEM prompt also bans the shape as a primary assertion. The same `rejectCircular()` pass also drops a second unfalsifiable shape: a vacuous absence assertion (`vacuousAbsenceReason()`), where the scenario asserts a hardcoded fake identifier is absent (`nonexistent-frame-xyz is not present`, `a fake-id element is absent`). It was never on any version of the page, so the check passes forever and catches no regression. The detector needs BOTH an absence phrasing (`ABSENCE_RE`) AND a fake-identifier marker (`FAKE_IDENTIFIER_RE`: `nonexistent`/`fake`/`bogus`/`xyz`/`foobar`/...), and it keeps a REAL absence test where a removal action (`REMOVAL_ACTION_RE`: removed/deleted/hidden/filtered/...) made a real thing go away. The removal set is narrower than the general mutating-action set on purpose, so a verify verb (`check`) or a selector noun (`selector`) is not mistaken for a removal. The SYSTEM prompt bans the shape too. Locked by `smoke-circular`.

18. **`assert_compare` polls the after-action read, it does not read once.** A sort, a re-render, or any async state change settles after the click that triggered it, so a single immediate `getAttribute`/`textContent`/`count` read races the operation and flakes (the tables "last name ascending" sort flaked F-F-F at stability because the cell was re-read before the JS sort settled). The replay engine (`runStep` in `replay.ts`) re-reads inside `pollUntil` until the relation holds or `timeoutMs` expires, the same web-first wait the completion assertions use for aria-valuenow. The emitted spec matches: `pom.ts` and `transcriber.ts` emit `await expect.poll(async () => <read>, { timeout })` for `changed`/`unchanged`/`equal`/`greater`/`less` (the `absent` relation already polled via `toHaveCount(0)`). The capture step still emits a one-shot `const`; only the compare polls. The `unchanged` bounds check (the refactored assert_freeze) reads once more after the poll confirms the value held. `COMPARE_POLL_TIMEOUT_MS` (10000, matches replay's `DEFAULT_TIMEOUT_MS`) is the emitted wait. Locked by `smoke-compare-poll`.

19. **An element inside an iframe is reached with `frameLocator`, never a `>>>` piercing selector.** Playwright does not pierce frames with `>>>`; that is what failed on demoqa.com/frames (the Explorer tried `iframe#frame1 >>> #sampleHeading`, could not read a real `h1#sampleHeading`, and dropped the scenario as a finding). The resolver (`resolve` in `selectors.ts`) now tries the main frame first, and only if nothing resolves does it scan iframes and re-run the SAME cascade (role → label → ... → css) INSIDE each frame via `page.frameLocator(<iframe>)`, scoped by `resolveInScope(scope, spec)` where `scope` is a `Page | FrameLocator`. Nested frames chain: `page.frameLocator(outer).frameLocator(inner)`, up to `MAX_FRAME_DEPTH` (3). The winning iframe-selector chain (id-based `iframe#frame1` preferred, then `iframe[name=...]`, then positional `iframe >> nth=i`) is recorded on `SelectorRecord.frameChain`. Everything downstream scopes through that chain: `baseLocator`/`absenceLocatorFor` in `replay.ts` (so reads/types/asserts and the 5x stability re-runs hit the frame, not the top document), and `emitLocatorCall(level, arg, ambiguous, frameChain)` in `selectors.ts` (so both the inline transcriber and the POM page-object fields emit `page.frameLocator("iframe#frame1").getByRole(...)`). Form-control routing follows in automatically because it runs off the resolved in-frame locator. A `>>>` selector the model emits anyway is split by `parsePiercingSelector()` into a frame chain plus the inner selector and resolved in-frame, so the mistake is converted, never passed through. The frame scan covers frameset `<frame>` elements too, not only `<iframe>` (see invariant 22). General for any site with iframes. Locked by `smoke-iframe`.

20. **When a page has a content-bearing iframe, the Planner must plan at least one scenario that reads or interacts with content INSIDE the frame.** The iframe content is the feature of such a page (letcode.in/frame, demoqa.com/frames), not the navbar or theme toggle around it. The old snapshot read only the top document (`page.evaluate` on `document`), so the Planner never saw inside a frame and planned only around page chrome, leaving the `frameLocator` path from invariant 19 untested live. `snapshotPage(page)` in `planner.ts` now also enumerates iframe content via `enumerateFrames(page)`, which walks `page.frames()` (origin-independent, the same access path `frameLocator` uses, so it sidesteps the same-origin policy that `contentDocument` is bound by), records each content-bearing frame's headings/inputs/buttons/editable-count/text-sample plus its selector chain (id `iframe#frame1` preferred, then `iframe[name=...]`, then `iframe >> nth=i`, capped at `MAX_FRAME_DEPTH` 3 and `MAX_FRAMES` 8), and drops empty tracking frames via `frameHasContent`. The settle-poll that runs BEFORE the snapshot (`settleForSnapshot` → `countSettleContent`) counts content the same way: top-document content PLUS content inside every child frame (`FRAME_SETTLE_SELECTOR`, broader than the top selector because frames have no SPA-shell problem). A frame-only page (ui.vision/demo/webtest/frames) has an empty top document, so without the frame count the poll would time out as "saw 0 form controls/headings" even though the snapshot can read the frames. The SYSTEM prompt and a per-page steering block tell Haiku to plan an inside-frame scenario and name the iframe, but the guarantee is deterministic, not prompt-only: `ensureIframeCoverage(scenarios, frames)` runs last in `plan()` (after dedup and circular rejection) and, when a content-bearing frame exists and no planned scenario names a frame (`scenarioCoversFrame`), prepends one synthesized from the frame's real content. Do NOT make this a prompt-only nudge; the injected fallback is what keeps the frameLocator path exercised on every iframe page. Locked by `smoke-planner-iframe`.

21. **The current value of a form field is asserted with `toHaveValue`, never `toHaveAttribute("value", ...)`.** Typed text and a selected option live on the element's value PROPERTY, not the static `value` ATTRIBUTE, so `toHaveAttribute('value', ...)` reads empty after a `fill` and the Explorer used to thrash through `toHaveAttribute` → `toBeVisible` → `wait_for_text` with no valid option (it blew the $2 ceiling on the ui.vision run). `toHaveValue` is a first-class assertion type end to end: the `Assertion` union in `trace.ts`, the assert tool enum + handler in `tools.ts` (`await expect(loc).toHaveValue(value)`), both emitters (`transcriber.ts` + `pom.ts` emit `expect(locator).toHaveValue(expected)`), and replay (`replay.ts` polls `loc.inputValue()`, which reads the property). The assert tool description and the runtime SYSTEM prompt steer the model to `toHaveValue` for any input/textarea/select value check. Use it whenever asserting what a field currently holds. Locked by `smoke-frame-value`.

22. **A frameset `<frame>` is entered with `frameLocator`, exactly like an `<iframe>`.** ui.vision/demo/webtest/frames is a `<frameset>` with `<frame>` children (no id/name on most, only `src`), NOT `<iframe>`. The resolver's `enumerateFrameSelectors` in `selectors.ts` used to query only `scope.locator('iframe')`, so it found zero frames on a frameset, the in-frame element resolved to null, the Explorer fell back to a `>>>` piercing selector, and on failure it navigated to the frame's standalone URL as a top-level page (testing the wrong thing). `enumerateFrameSelectors` now enumerates BOTH `iframe` and `frame` elements, emitting a tag-matched selector per element (`frame#id` / `frame[name=...]` / positional `frame >> nth=i`, indexed within that tag's set), all of which Playwright's `page.frameLocator()` drives. `frameChainFor` in `planner.ts` detects the tag the same way so the snapshot reports the right chain. And `resolve()` strips the frame part off a `>>>` css for EVERY fallback step (not just the explicit-chain try), so a wrong-tag guess the model makes (`iframe#frame1 >>> ...` for a real `<frame>`) still resolves through the generic frame scan instead of poisoning it with the raw `>>>` string. The resolver never navigates to a frame URL and never passes `>>>` through. Locked by `smoke-frame-value`.

23. **A `toHaveValue` assertion asserts the EXACT string that was filled, and it finds that string by the element's own stable key, never by intent text.** A fill-and-verify assertion is only correct if the asserted value is identical to the filled value. On the ui.vision run a negative long-text scenario shipped a recording defect (fill string unclosed, asserted value longer than the text typed), and a multi-field scenario collapsed every assertion to the last fill. The recorded `fill` TraceStep is the single source of truth: in the `toHaveValue` handler (`tools.ts`) `fillValueForTarget(ctx.current.steps, record)` returns the most recent fill on the SAME element and the assertion both checks and records THAT value, ignoring whatever string the model passed. The model's value is used only when the field was never filled in the scenario (asserting a pre-existing default). This also fixes the generated-field case, where the model cannot know the value: a registration email field fills a fresh `uniqueEmail()` and the assertion records the generated value, not the literal the model typed. **The binding is by `SelectorRecord.elementKey`, a per-element identity read off the LIVE DOM element at resolve time (`elementKeyFor` in `tools.ts`): the frame chain plus a structural DOM path (tag + id/name + same-tag sibling index) from the frame root down to the element.** It is NOT derived from the cascade tier, the locator arg, or the intent string, so the SAME physical field yields the SAME key however it was located, and two DIFFERENT fields always yield different keys (their DOM paths or frames differ). `fillValueForTarget` matches on `elementKey` and nothing else: field 1's assertion can only ever read a fill on field 1's element, so three assertions collapse to one value ONLY when three fills wrote that same value into the same element. No key on either side means no bind (the assertion keeps the model value, never borrows another field's). This replaced the earlier intent-matching approach (`sameIntent` / `subsetModuloVerifyNoise` / `VERIFY_NOISE` / per-tier ranking), which kept failing across three ui.vision runs by letting a later field's fill leak into an earlier field's assertion; that whole path is gone. Once bound, the recorded value round-trips with no mutation because both emitters serialize every string literal with `JSON.stringify`, so the `fill` literal and the `toHaveValue` literal are byte-identical even for quotes, backslashes, angle brackets, and non-ascii. General for every fill-and-verify test on any site. Locked by `smoke-fill-verify` (includes a live three-fill / three-assert isolation test where the model re-supplies one value for all three yet each assertion records its own field's value, and swapping any two would fail).

24. **A selector that FAILS TO RESOLVE during exploration is healed automatically; an assertion that fails is NEVER healed.** The two failures live on two structurally separate paths, and healing is scoped to the first only. A locator that cannot be found throws from `resolveAndRecord` (`tools.ts`) — that is always a locator problem, never a real bug, so it is safe to re-resolve. An assertion whose element was found but whose value/state is wrong throws from `expect(...)` inside `executeAssertion` and is handled by `assertWithRetryCap` (bounded retry, then a finding) — healing it would hide a real regression, which is forbidden. **Healing lives entirely inside `resolveAndRecord` and never touches the `expect()` path.** When the normal resolve + poll returns null, `healOrFinding` runs `healResolve`, which re-resolves against the live page by the semantic intent ALONE (the specific hint the model gave — a stale/wrong role, label, testid, or css — is dropped, because an explicit hint can suppress the ladder's semantic match; dropping it lets the element be found a different, stable way). On success the healed locator is used, the failure streak resets, and a distinct heal event is recorded on `ctx.heals` (`{ scenario, intent, from, to }`) and surfaced as a `heal` AgentEvent (`↺ healed: <from> re-resolved to <to>`) in both the CLI and the gateway, and carried into `RunReport.heals` so a human can see exactly what was healed. Heal attempts per selector are capped by `HEAL_CAP` (2, keyed by `selectorSignature`): the first failure to heal is an honest retry (the model may try different hints), and on the cap-th failure of the SAME selector the run records a locator finding (real URL + a "could not be resolved or healed" message), drops the half-built scenario (`ctx.current = null`), and sets `_blockUntilNewScenario` — a finding, never a silent pass. That terminal case throws `LocatorFindingError`, which `assertWithRetryCap` passes straight through so a locate failure inside an assertion is not double-counted as an assertion regression. The reconciliation funnel is unchanged: a locator finding is an ordinary `findings` entry, so `planned === generated + dropped + incomplete + findings` still balances. Locked by `smoke-heal` (unresolvable selector heals and re-resolves by a different stable locator; a resolvable selector does not heal; a failed assertion is never healed and becomes a finding; a selector that cannot be healed becomes a finding after the cap).

25. **`/heal <spec-path>` repairs an existing spec's broken selectors deterministically, reusing the exploration ladder — no LLM.** `npm run heal -- <spec-path> [--base-url <url>] [--dry-run]` → `heal()` in `src/agent/heal.ts`. It loads the spec AND, when the spec is POM, the page-object files it imports (the locators live there, not in the spec — `gatherFiles` resolves relative `import ... from` paths, trying `.ts`/`.js`). It finds the target URL from `--base-url`, else a `page.goto("http…")`, else a page-object `readonly url = "http…"`. It opens the live page once, then for EACH locator (parsed from the source, including `frameLocator(...)` chains) it rebuilds the real Playwright locator and asks the live page `.count()`: a locator that still resolves is left untouched. A broken one is re-resolved by `healResolve` (exported from `tools.ts` — the SAME semantic-intent ladder the Explorer uses; not duplicated here), where the intent is the human token the original locator carried (role name, label, placeholder, text, alt, title, testid, or a token derived from a css id/class). Two guards make a wrong heal impossible: an `ambiguous` re-resolution is refused (cannot know which element was meant), and `confirmSameElement` reads the re-resolved element's accessible name / text / value / id and requires it to still carry the original token — a loose match to a DIFFERENT element (e.g. `input[type=email]` smart-css matching a field whose real name is "Contact" when the locator wanted "Email") is refused. Confirmed heals are written back in place with the shared `emitLocatorCall` emitter (per-file, right-to-left edits so offsets stay valid; `--dry-run` previews without writing), preserving a `this.page` root. The report names every heal (`was` → `now`) and every unhealable selector with its reason (`could not be re-resolved` / `ambiguous` / `re-resolved to a different element` / `no semantic identity`); an unhealable selector is reported and left unchanged, never silently dropped or wrongly rewritten. The parser handles JSON-emitted quoted option keys (`{"name":"…","exact":true}`) as well as unquoted ones. The gateway `/heal` and MCP `qa_heal` call the same `heal()` and no longer run the spec or call a model. Locked by `smoke-heal-command` (a button that became a link heals to the link and is written back; an intact locator is left alone; a missing element and a wrong-element loose match are both reported unhealable; a POM spec heals the locator inside the imported page object and finds the URL from the page object's `url`).

---

## Standard verification (run before claiming "done")

Whole project:

```bash
npx tsc --noEmit
```

Full smoke-test suite:

```bash
for s in smoke-tools smoke-finish smoke-hascount smoke-planner-parse \
         smoke-abandoned smoke-ui smoke-dashboard-math smoke-retry-cap \
         smoke-feature-grouping smoke-scaffold smoke-scaffold-js smoke-parse-features \
         smoke-zip smoke-ui-download smoke-slim-dir smoke-ui-brand-label \
         smoke-placeholder-cascade smoke-cascade-coverage smoke-capture-compare \
         smoke-plan-dedup smoke-form-controls smoke-aria-assertion smoke-gate \
         smoke-unique-data smoke-closeout-grace smoke-step-budget \
         smoke-table-gate smoke-circular smoke-compare-poll smoke-iframe \
         smoke-planner-iframe smoke-frame-value smoke-fill-verify smoke-heal \
         smoke-heal-command; do
  echo "=== $s ==="
  npx tsx scripts/$s.ts
done
```

Every script should print `OK:` on its last line. `tsc --noEmit` should print nothing.

---

## Environment quirks (real bugs you'll trip on without warning)

### tsx + page.evaluate

`tsx 4.21+` injects `__name(fn, "x")` helper calls into arrow functions and function declarations inside `page.evaluate` bodies. The helper is defined at module scope but does NOT travel with the serialized function into the browser. Result: `ReferenceError: __name is not defined`.

**Fix:** `installEvalShim(ctx)` from `src/agent/eval-shim.ts` on every new browser context, before any `page.evaluate` runs. This is non-negotiable — see `runtime.ts`, `planner.ts`, `replay.ts`, `heal.ts` for the call sites.

### Gateway restart required after every code change

The WebSocket gateway loads modules at start time. After any change to the agent code, the gateway will keep serving the old version until restarted:

```bash
lsof -ti :18789 | xargs kill -9 2>/dev/null; sleep 1; npm run gateway
```

Then refresh the UI tab so the WebSocket reconnects.

### Pre-existing markdown lint warnings

`docs/DOCUMENTATION.md` and other large docs have MD060 (`table-column-style`) warnings throughout. These are stylistic, not functional. **Do NOT mass-reformat tables to fix them.** That's busywork that adds no value. Only fix lint warnings introduced by the current edit.

### Saucedemo is sometimes unreachable

`https://www.saucedemo.com/` occasionally fails with `ERR_ADDRESS_UNREACHABLE` from certain networks. If a test/eval run mysteriously fails on saucedemo, verify reachability first (`curl -I https://www.saucedemo.com/`) before suspecting agent code.

### Skills + MCPs

Project-scoped configuration lives in `.mcp.json` (three MCPs: `playwright`, `chrome-devtools`, `shadcn-ui`) and `.claude/skills/qa-core-ui-design/SKILL.md` (UI design + visual verification workflow). Both load on Claude Code start. **Restart Claude Code** after editing `.mcp.json` or adding new skill files — they are NOT hot-reloaded. Verify with `/mcp` (lists registered servers) and `/skills` (lists invocable skills). First MCP invocation per session may take 10-30s as `npx` downloads the package.

The Playwright MCP is the canonical "see + interact with the live UI" tool — use it during design work via the `qa-core-ui-design` skill. The global [[ui-ux-pro-max]] skill at `~/.claude/skills/` provides comprehensive design intelligence (palettes, typography, component patterns).

---

## Configuration defaults

| Env var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required. Without it the agent errors at start. |
| `QA_CORE_MAX_USD` | `2.00` | Hard ceiling per run. Cost is tracked per stage. Loop aborts if exceeded. **Do not raise without explicit discussion** — it's the runaway-loop safety rail. |
| `QA_CORE_MAX_STEPS` | `40` | Hard ceiling on Explorer tool calls per run. |
| `QA_CORE_MODEL_PLANNER` | `claude-haiku-4-5` | Override Planner model. |
| `QA_CORE_MODEL_EXPLORE` | `claude-opus-4-7` | Override Explorer model. |
| `QA_CORE_MODEL_CRITIC` | `claude-sonnet-4-6` | Override Critic model. |
| `QA_CORE_MODEL_HEAL` | `claude-sonnet-4-6` | Override Healer model (used by `/heal`). |
| `QA_CORE_MODEL_STABILIZER` | `claude-sonnet-4-6` | Override Stabilizer model (Stage 5b — LLM-guided flake recovery). |
| `QA_CORE_MODEL_TRANSCRIBE` | `claude-sonnet-4-6` | Override `/generate` model. |
| `QA_CORE_GATEWAY_PORT` | `18789` | WebSocket gateway port. UI defaults to the same. |
| `QA_CORE_GATEWAY_HOST` | `127.0.0.1` | Bind host (local only by default). |
| `QA_CORE_GATEWAY_TOKEN` | — | Optional shared token; if set, clients must pass `?token=` query param. |

---

## Output directory layout

| Path | Created by | Status |
|---|---|---|
| `output/<brand>-automation-framework/` | Every `/explore` run (POM mode — default) | Gitignored. After zip is emitted, the directory is slimmed to just `run-report.json` so the dashboard's run-history scan still works. The zip alongside is the canonical deliverable. |
| `output/<brand>-automation-framework.zip` | Sibling of above; written by both CLI and gateway | Gitignored. Self-contained Playwright project the user can extract anywhere and `npm install && npx playwright test`. |
| `output/<runId>-<slug>/` | `/explore --no-pom` (legacy inline mode only) | Gitignored. Timestamped, never overwrites. Used only by power users who want single-file output. |
| `eval-results/<timestamp>/<site>/` | `npm run eval` | Gitignored. Contains `run-report.json`, spec, `pw-results.json`, plus eval-level `summary.md`. |
| `docs/v2-eval-summary.md` | Manually copied from `eval-results/<latest>/summary.md` | **Committed** — stable reference for the README link. |
| `.qa-core/sites/<host>.json` | `memory.ts` after each run | Gitignored. Per-host fingerprint. |
| `.qa-core/memory.json` | `memory.ts` after each run | Gitignored. Project-wide aggregate. |
| `playwright/.auth/user.json` | `tests/auth.setup.ts` | Gitignored. Storage state after a successful login; reused by explorer/replay/stability. |

---

## Backup convention

Before any major refactor (new command, pipeline change, multi-file rewrite), take a defensive backup:

```bash
BACKUP="/Users/osman/Downloads/qa-core-agent-backup-<reason>-$(date +%Y-%m-%d)"
rsync -a \
  --exclude='node_modules/' \
  --exclude='output/' \
  --exclude='eval-results/' \
  --exclude='.qa-core/' \
  --exclude='playwright/.auth/' \
  --exclude='test-results/' \
  --exclude='playwright-report/' \
  --exclude='.DS_Store' \
  /Users/osman/Downloads/qa-core-agent/ \
  "$BACKUP/"
```

Backups live under `~/Downloads/qa-core-agent-backup-*`. Restore is the same rsync with source and destination swapped, plus `--delete`.

---

## What NOT to do

- **Do not push v2 to LinkedIn separately.** The plan is to ship one polished v3 release (with framework output + zip download) as the single LinkedIn launch. No incremental version posts.
- **Do not hard-code "login + register" as default `/explore` scenarios.** Let the Planner infer the 2-3 highest-signal flows from a homepage snapshot. The Planner already does this — just don't override it with a forced default.
- **Do not add a stand-alone HTTP server for the zip download.** WebSocket + base64 (chosen as design option B1) is sufficient for typical framework sizes (~50–200 KB).
- **Do not write to user files outside the framework directory without validation.** This rule will become critical when `/extend` is eventually built — path validation, read budget, atomic writes are all required.
- **Do not flip the selector cascade order to ID-first.** Role-first (role → label → testid → CSS) is the accessibility-first default and one of the LinkedIn-credibility moats. ID-first would undo it.
- **Do not commit `eval-results/` or `output/` files.** Both are runtime data. The canonical eval snapshot lives at `docs/v2-eval-summary.md` (manually copied).

---

## Writing style for test descriptions, comments, and docs

Punctuation (strict)

- The em dash (—) and en dash (–) are banned. Where one would fit, use a comma, a full stop, or split into two sentences.
- The double hyphen (--) is banned. Same replacements.
- A single hyphen in compound words is fine (for example "self-healing").
- This applies to code comments, test descriptions, commit messages, and docs.

Plain English

- Write in plain, simple English. Short and direct.
- No AI-sounding words: delve, leverage, robust, seamless, comprehensive, ensure,
  utilize, foster, in today's fast-paced world, it's worth noting.
- No formulaic intros or padding. Say the thing.
- Descriptions should read like a developer wrote them quickly, not like marketing copy.

Examples of the test description style I want

- "checks the cart total updates after removing an item"
- "login fails with a wrong password and shows the right error"
- "filter by category returns only matching products"

## v3 — SHIPPED (what's built and verified)

All v3 work is complete. Documented here for future Claude sessions that need the context.

**What ships:**

1. **`--features` flag** — accepts comma-separated (`--features login,cart`) OR natural-language (`test login and cart`) via a small Haiku parser. If omitted, Planner infers 2-3 highest-signal flows from homepage scan. Parser lives in `src/agent/parse-features.ts`.
2. **Planner feature steering** — when features are provided, Planner output uses the `[feature][category]` two-bracket format; runtime passes those tags through to the Explorer; Explorer sets them on `begin_scenario` calls.
3. **Per-feature framework output** — replaces the single `.spec.ts`. Now produces:
   - `pages/<feature>-page.{ts,js}` per feature (kebab-case filename, PascalCase class inside)
   - `tests/<feature>/<feature>.spec.{ts,js}` per feature
   - `pages/BasePage.{ts,js}` shared
   - `tests/a11y/landing.a11y.spec.{ts,js}` auto-injected (inside `tests/` so it runs by default)
4. **Dual-language support** — `--lang ts` (default) OR `--lang js`. JS path emits CommonJS, skips `tsconfig.json`, strips TypeScript devDeps. Both produce frameworks where `cd <out> && npm install && npx playwright test` works immediately.
5. **Framework dir naming** — `<brand>-automation-framework/` using the `brandSlug()` helper (`www.saucedemo.com` → `saucedemo-automation-framework`).
6. **Zip output + UI download card** — gateway streams base64 zip over WebSocket; UI renders a download card with one-click `<a download>`.
7. **Slim-dir after zip** — on-disk framework directory is reduced to just `run-report.json` after the zip is written; the zip is the canonical deliverable.

**Smoke test coverage (17 deterministic tests):** `smoke-feature-grouping`, `smoke-scaffold`, `smoke-scaffold-js`, `smoke-parse-features`, `smoke-planner-parse`, `smoke-zip`, `smoke-ui-download`, `smoke-slim-dir`, `smoke-ui-brand-label` (locks brand-slug display on site cards / run history / recent runs / download filenames — full host stays in `r.host` for identity + tooltip), `smoke-placeholder-cascade` (locks the role+name last-word retry, the new `placeholder` cascade level, and `get_dom` extracting `data-test` alongside `data-testid`), `smoke-cascade-coverage` (24 common form-field patterns: labelled inputs, placeholder-only, aria-label, type-only inputs, submit/icon/link buttons, data-test, checkboxes, radios, textareas, selects — every pattern must resolve to the right element via the cascade), `smoke-capture-compare` (locks the capture-and-compare primitive: capture a real attribute then assert it changed, capture a count then assert it increased, capture a value then assert the old value is absent, the falsifiability check that `changed` goes red on a static value, rejection of an unknown capture name, and the emitted spec reading real values with no placeholder strings), plus the v2 invariant tests. `smoke-plan-dedup` (locks Planner-level de-duplication: two scenarios that capture the same value and assert the same relation under the same feature collapse to one, keeping the first in plan order; a different relation on the same value, a different value, a different feature, or a non-capture scenario all survive). `smoke-form-controls` (locks form-control routing: `fill` on a `<select>` auto-routes to `selectOption` with no "Element is not an <input>" error and the value actually moves, `fill` on a checkbox/radio routes to `check`, explicit `select_option` works by value, label, and index and is rejected when no option is given, `set_checked` ticks then unticks, a textarea still fills, and the emitted spec uses `selectOption`/`check`/`uncheck` while never filling the combobox). `smoke-aria-assertion` and `smoke-gate` now exercise the refactored `assert_freeze` path, which records `capture` + `stability_wait` + `assert_compare(unchanged)` instead of the removed `assert_freeze` TraceStep kind. `smoke-retry-cap` (locks the outcome-assertion retry cap: the first failure of an assertion is an honest retry, the second failure of the SAME assertion records a finding with the real URL and the visible page message, drops the half-built scenario instead of shipping it green, and blocks every further action tool until the next `begin_scenario`, so the Explorer cannot re-fill the form and thrash; the counter is per-signature so two different assertions failing once each do not trip it, and the counter PERSISTS across `begin_scenario` so the SAME assertion failing once, then once more after a restart, trips the cap on the second failure, the real-world case a gate-forced restart used to reset; `begin_scenario` lifts the block but does not wipe the counts).

**`/extend` command is still DEFERRED.** Designed in detail (see conversation history). Would let users add new tests to an existing framework. Not in scope for v3; would build on `/explore` framework output.

---

## File-by-file reference

For the precise purpose of every source file, see [`docs/CODEBASE.md`](./docs/CODEBASE.md). For the high-level architecture and feature catalogue, see [`docs/DOCUMENTATION.md`](./docs/DOCUMENTATION.md).

---

## Quick orientation for new conversations

If you're a Claude instance starting fresh in this project:

1. The agent works. v2 hardening pass is complete. All 7 smoke tests pass. `tsc --noEmit` is clean.
2. The next planned work is the v3 `/explore` upgrade (see "Active work" above).
3. The codebase is **not** under git in this directory — there is no `.git/`. The public repo lives at `https://github.com/sardarusmanjutt/qa-core-agent.git`.
4. Before making any structural change, take a backup using the snippet in the "Backup convention" section above.
5. After any change, run `npx tsc --noEmit` and the full smoke-test suite.
