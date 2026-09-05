# QA-Core — File-by-file reference

This document explains the purpose of every file in the repository, organized by directory. For the high-level architecture and product story, see `DOCUMENTATION.md`. This file is intended for engineers who need to understand what each module does and how the pieces fit together.

Generated: 2026-06-10 (v2 hardening pass complete).

---

## Top-level files

| File | Purpose |
|---|---|
| `package.json` | Node project manifest. Defines the four runtime scripts (`explore`, `generate`, `heal`, `eval`) plus the gateway and MCP server entry points. Dependencies pin Anthropic SDK, Playwright, MCP SDK, axe-core, zod, ws, dotenv. |
| `tsconfig.json` | TypeScript compiler config. Targets ESM modules with strict type-checking. Used only for `tsc --noEmit` validation; runtime execution happens through `tsx`. |
| `playwright.config.ts` | Playwright runner config used by `npm test` and by the eval harness when it re-executes generated specs. Defines the chromium project and the auth-setup project. |
| `setup.sh` | One-shot bootstrapping script. Installs deps, runs `playwright install chromium`, and copies `.env.example` to `.env` if it doesn't exist. |
| `.env.example` | Template for the environment variables QA-Core reads at startup. Copy to `.env` and fill in `ANTHROPIC_API_KEY` at minimum. |
| `qa-core-ui.html` | The full single-page web UI. Connects to the WebSocket gateway, sends slash commands, renders the pipeline animation, dashboard, and run history. Pure HTML/CSS/vanilla-JS — no build step. |
| `README.md` | Public-facing README for GitHub visitors. Quick start, commands, model routing, eval table. |

---

## `src/agent/` — the agent core

The 5-stage pipeline lives here. Each stage is one module. Shared types (trace, scenario, run report) sit in `trace.ts`.

| File | Stage | Purpose |
|---|---|---|
| `runtime.ts` | orchestrator | The main `explore()` function. Wires together Planner → Explorer → Critic → Replay → Stability. Holds the system prompt for the Explorer, sums costs, manages the cost ceiling, and writes the final `run-report.json`. Every CLI / gateway / MCP / eval call ultimately invokes this. |
| `planner.ts` | 1 — Planner | Cheap Haiku pre-pass. Loads the target URL, snapshots the visible DOM, asks Haiku to propose 3–6 scenarios formatted as `[category] name — rationale`, and parses the response with a forgiving regex that accepts four known format variants. Output: `PlannedScenario[]`. |
| `tools.ts` | 2 — Explorer | The tool surface Opus uses to drive the browser. Defines `begin_scenario`, `navigate`, `click`, `fill`, `press`, `wait`, `get_dom`, `assert`, `end_scenario`, `finish`. `runTool()` dispatches each call, enforces budgets, and records trace steps. Also installs console + network listeners that attach errors to each scenario. |
| `critic.ts` | 3 — Critic | Single Sonnet call after exploration. Sends the recorded scenario list (names + step kinds + assertion shapes) and asks for a per-scenario verdict: `pass` / `rework` / `reject` plus reasons and required fixes. `parseVerdicts` extracts the verdict array with a bracket-depth scan; `gateByVerdicts` drops non-pass scenarios before Reality-Check. Does NOT drive a browser. |
| `replay.ts` | 4 — Reality-Check | Zero-LLM stage. Re-executes every recorded scenario once in a fresh Playwright context. Drops scenarios that fail the independent re-run. Exports `replayScenarioOnce` and `baseLocator` for reuse by Stability and tools. |
| `stability.ts` | 5 — Stability | Zero-LLM stage. Re-runs each replay-survivor N times (default 3) in fresh contexts. Classifies each as `stable` / `flaky` / `broken` and reports `flake_rate`. Drops anything that pass-then-fails. |
| `selectors.ts` | shared | The selector cascade. `resolve()` tries role → label → testid → CSS, requires `count === 1` to claim a level, and marks ambiguous matches with `ambiguous: true`. `emitLocatorCall()` and `baseLocator` use the recorded `SelectorRecord` to produce a Playwright-flavored call. Also exports `escapeRegex` for safe `toHaveURL` patterns. |
| `trace.ts` | shared | Type definitions only. `TraceStep`, `Scenario`, `SelectorRecord`, `Assertion`, and `RunReport`. The shape every other agent module reads or writes. |
| `transcriber.ts` | spec output | Deterministic (no LLM) conversion of the verified trace into a single inline Playwright spec file. Emits `beforeEach` that clears cookies + storage. Emits `.first()` only when the cascade marked the record ambiguous. |
| `pom.ts` | spec output | Same role as `transcriber.ts`, but produces a Page Object Model framework: `pages/BasePage.ts`, one page class per pathname, action-method synthesis for repeated step sequences, dedicated `tests/` directory, and an auto-injected a11y check. The default `/explore` output. |
| `generate.ts` | story → spec | The `/generate` command. A single LLM call that converts a user story into a Playwright spec marked UNVERIFIED in the file header. Does not drive a browser. |
| `selector-recovery.ts` | shared | In-run selector recovery (NOT the healer, which is the qa-core-heal package). `recoverResolve()` re-resolves a selector that failed during exploration by its semantic intent alone, dropping the stale hint that suppressed the ladder's match. Called from `resolveAndRecord` in `tools.ts`; each recovery is recorded on `ctx.heals` and surfaced as a `heal` event. Locked by `smoke-selector-recovery.ts`. |
| `memory.ts` | persistence | Per-host fingerprints stored under `.qa-core/sites/<host>.json` (cascade stats, known intents, auth hints) plus a global `.qa-core/memory.json`. Renders a cacheable system-prompt block injected by `runtime.ts`. Failures during save log to stderr. |
| `csv.ts` | utility | Tiny CSV reader and writer used by the `--review` flow (Planner exports `plan.csv`, user edits Approve column, run resumes from the CSV). |
| `eval-shim.ts` | utility | Installs a no-op `globalThis.__name` shim into every browser context via `addInitScript`. Fixes the `tsx` keepNames helper that breaks `page.evaluate()` serialization. Called from `runtime.ts`, `planner.ts`, `replay.ts` immediately after every `browser.newContext()`. |

---

## `src/cli/` — terminal interfaces

Three thin command-line front-ends. Each parses argv, calls the appropriate `src/agent/` function, and streams progress to the terminal. None of them contain business logic — they format I/O only.

| File | Command | Purpose |
|---|---|---|
| `explore.ts` | `npm run explore -- <url>` | Drives the 5-stage pipeline against a URL. Flags: `--lang ts\|js`, `--name <basename>`, `--out <dir>`, `--review`, `--from-plan <plan.csv>`, `--no-pom`, `--no-replay`, `--no-stability`, `--stability N`. |
| `generate.ts` | `npm run generate -- "<story>"` | Single-shot story → spec. Flags: `--lang ts\|js`, `--name <basename>`, `--out <dir>`. |
| `heal.ts` | `npm run heal -- <spec-path>` | Thin wrapper around the published qa-core-heal npm package, which owns all healing logic. Parses argv, forwards to the package's `heal()` (deep import `qa-core-heal/dist/heal.js`; the package ships no `main`/`exports`), and prints the report. Also re-exports `heal` for the gateway and MCP server, so every heal path goes through the same package integration. Flags: `--base-url <url>`, `--dry-run`. |

---

## `src/server/` — the WebSocket gateway

| File | Purpose |
|---|---|
| `gateway.ts` | The WebSocket bridge between the static `qa-core-ui.html` and the agent runtime. Listens on `ws://127.0.0.1:18789` by default. Parses slash commands out of incoming chat messages, dispatches to `explore` / `generate` / `heal` / `eval` flows, and streams typed events (`plan_started`, `tool_call`, `replay_done`, etc.) back to the UI as JSON. Also exposes `list_runs` which walks `output/` and `eval-results/` and returns a unified list of historical runs the dashboard renders. |

---

## `src/mcp/` — Model Context Protocol server

| File | Purpose |
|---|---|
| `server.ts` | Exposes QA-Core's three workflows as MCP tools (`qa_explore`, `qa_generate`, `qa_heal`) over stdio JSON-RPC. Lets MCP-aware hosts (Claude Desktop, Cursor, Cline, Continue, Zed) invoke the agent directly. All logging goes to stderr to keep stdout reserved for the MCP wire protocol. |

---

## `scripts/` — eval harness, debug tools, and smoke tests

This directory is mixed: the eval harness is production code, the smoke tests are CI/regression protection, the render scripts are docs generators, and the debug scripts are throwaway diagnostic tools kept for posterity.

### Production

| File | Purpose |
|---|---|
| `eval.ts` | The `npm run eval` harness. Runs `/explore` against the three baseline target sites (saucedemo, the-internet, practice-todo), executes the generated specs through Playwright, and writes `eval-results/<timestamp>/{results.json,summary.md}` with per-site metrics including the v2 columns (Replay pass/fail, Stable/Flaky/Broken, flake_rate). |

### Smoke tests (regression protection)

These run with `npx tsx scripts/<name>.ts`. They are deterministic and fast. Each one locks in a specific bug fix from the v2 hardening pass so future changes don't silently regress it.

| File | What it locks in |
|---|---|
| `smoke-tools.ts` | `get_dom` surfaces `required` + `disabled` + `validation` form-state fields. Runs against real Chromium. |
| `smoke-finish.ts` | `finish()` drops abandoned assert-less scenarios but keeps complete ones. |
| `smoke-hascount.ts` | `toHaveCount(N)` succeeds on multi-match selectors. Recorded step has `ambiguous` flag stripped so transcribed spec emits without `.first()`. |
| `smoke-planner-parse.ts` | Five known Haiku output formats (with/without brackets, em-dash vs colon after category, hyphen-in-name edge case) all parse correctly. |
| `smoke-abandoned.ts` | The runtime's exit-path force-push drops in-progress scenarios with no assertions. |
| `smoke-ui.ts` | `qa-core-ui.html` loads in real Chromium with zero JS console errors. Critical pipeline DOM nodes (Stability row, stats container) are present. |
| `smoke-dashboard-math.ts` | Compares the old (buggy) vs new (fixed) per-site dashboard math against real on-disk runs. Confirms the fix produces sensible numbers, not just "different" numbers. |

---

## `tests/` — Playwright auth setup

| File | Purpose |
|---|---|
| `auth.setup.ts` | Authenticates once and saves the storage state to `playwright/.auth/user.json`. Reads `QA_CORE_AUTH_URL` / `QA_CORE_AUTH_USER` / `QA_CORE_AUTH_PASS` from env. Skipped cleanly if those env vars are missing. The Explorer, Replay, and Stability stages all pick up this storage state automatically when present. |

---

## `skills/` — OpenClaw skill definitions

Markdown files that describe QA-Core's commands to the OpenClaw skill router. Each one is a small frontmatter + body describing what the skill does, what arguments it takes, and the local command to run.

| File | Skill |
|---|---|
| `explore-url.md` | `/explore` — give it a URL, get a Playwright suite. |
| `generate-tests.md` | `/generate` — give it a user story, get a spec. |

---

## `docs/` — documentation and assets

| File | Purpose |
|---|---|
| `DOCUMENTATION.md` | The high-level product / architecture documentation. Start here. |
| `CODEBASE.md` | This file — file-by-file reference for engineers. |
| `MCP.md` | Setup guide for using QA-Core's MCP server with Claude Desktop / Cursor / Cline / Continue / Zed. |
| `architecture.html` | Editable HTML source for the architecture diagram. |
| `architecture.png` / `architecture.svg` | Rendered architecture diagrams. Used in the README. |
| `linkedin-card.svg` | LinkedIn share card image. |
| `linkedin-drafts.md` | Drafts of LinkedIn posts (v1, v2, video script). |
| `claude_desktop_config.example.json` | Example MCP server config to paste into Claude Desktop's settings. |

---

## Runtime data directories (gitignored)

| Path | Created by | Purpose |
|---|---|---|
| `output/<timestamp>-<host>/` | `explore.ts` and `gateway.ts` | One directory per `/explore` run. Contains `run-report.json` plus the generated spec (or the POM framework subdirectories). |
| `eval-results/<timestamp>/<site>/` | `eval.ts` | One directory per eval run, one subdirectory per target site. Contains `run-report.json`, the generated spec, `pw-results.json` from the Playwright execution, plus the eval-wide `results.json` and `summary.md` at the root. |
| `playwright/.auth/user.json` | `tests/auth.setup.ts` | Persisted storage state from a successful login. Reused by every subsequent agent context that finds this file. |
| `.qa-core/sites/<host>.json` | `memory.ts` | Per-host fingerprint. Cascade distribution, known intents, auth hints. Read at the start of a run, refreshed at the end. |
| `.qa-core/memory.json` | `memory.ts` | Project-wide memory: recent runs, prevailing cascade distribution, any user-pinned overrides. |
| `node_modules/` | npm | Dependencies. |
| `test-results/` | Playwright runner | Per-test artifacts (traces, videos, screenshots) when the runner is invoked directly. |

---

## How a single `/explore` request flows through the codebase

For new contributors, this is the call stack from a user pressing Enter to the final spec landing on disk:

1. User types `/explore https://example.com/` in `qa-core-ui.html`.
2. UI sends a WebSocket message to `gateway.ts`.
3. `gateway.ts` parses the slash command and calls `explore()` from `runtime.ts`.
4. `runtime.ts` calls `installEvalShim()` (`eval-shim.ts`) on the browser context.
5. **Stage 1 — Planner** (`planner.ts`): opens the URL, snapshots the DOM, asks Haiku for scenarios, parses with the forgiving regex.
6. **Stage 2 — Explorer** (`runtime.ts` + `tools.ts`): Opus drives the browser through the tool surface. Each tool call records a step in the trace. State is reset between scenarios.
7. **Stage 3 — Critic** (`critic.ts`): Sonnet reviews each recorded scenario and produces a `pass` / `rework` / `reject` verdict. Non-pass scenarios are dropped before replay and named in the reconciliation funnel.
8. **Stage 4 — Reality-Check Replay** (`replay.ts`): every scenario is re-executed in a fresh context. Failures get dropped.
9. **Stage 5 — Stability** (`stability.ts`): replay-survivors run 3 more times. Anything that pass-then-fails is dropped as flaky.
10. `runtime.ts` builds the final `RunReport` and writes `run-report.json`.
11. `transcriber.ts` (or `pom.ts` if POM mode) consumes the verified scenarios and writes the runnable spec.
12. `memory.ts` updates the per-host fingerprint.
13. `gateway.ts` sends the final `Done.` message and the spec contents back over the WebSocket.
14. UI renders the response, persists the run to localStorage, updates the dashboard.

---

## Key invariants the codebase relies on

These are the rules anyone modifying the agent should preserve. Every smoke test enforces one of these.

1. **Every emitted scenario contains at least one assertion.** Enforced in `tools.ts` (`end_scenario`, `finish`) and `runtime.ts` (force-push guard). Tested by `smoke-finish.ts` and `smoke-abandoned.ts`.
2. **The selector cascade only claims a level when it resolves to exactly one element.** When ambiguous, the `ambiguous` flag is set on the `SelectorRecord` and `.first()` is honestly emitted by both replay and the transcriber. Enforced in `selectors.ts`. Tested implicitly by spec-runs.
3. **`toHaveCount` uses the multi-match locator, not the `.first()`-wrapped one.** Enforced in `tools.ts` (uses `baseLocator` from `replay.ts`). Tested by `smoke-hascount.ts`.
4. **`page.evaluate` calls work under tsx.** Enforced by `eval-shim.ts` installed in every browser context. Tested by `smoke-tools.ts` and `smoke-ui.ts`.
5. **Every scenario starts from a clean state.** `begin_scenario` clears cookies + storage. The transcribed spec emits a matching `beforeEach`. Enforced in `tools.ts`, `transcriber.ts`, and `pom.ts`.
6. **Planner parser accepts any of the four known Haiku format variants.** Enforced in `planner.ts`. Tested by `smoke-planner-parse.ts`.
7. **Dashboard per-site math divides by `runsWithPass`, not total runs.** Enforced in `qa-core-ui.html` (`renderDashboard`). Tested by `smoke-dashboard-math.ts`.

---

## How to run the smoke suite

```bash
# All seven
for s in smoke-tools smoke-finish smoke-hascount smoke-planner-parse \
         smoke-abandoned smoke-ui smoke-dashboard-math; do
  echo "=== $s ==="
  npx tsx scripts/$s.ts
done

# Or just typecheck the whole project
npx tsc --noEmit
```

All seven should print `OK:` on the last line. `tsc --noEmit` should print nothing.

---

## Footnote on what's NOT in this codebase

For clarity — features that are listed in the LinkedIn v3 roadmap but are not yet built:

- **PR-aware test selection** — would read a git diff and propose which existing scenarios to re-run vs extend.
- **Multi-role auth** — single `playwright/.auth/user.json` exists today; a multi-role scheme (`admin.json`, `user.json`, `guest.json` with CLI flag) is not yet implemented.
- **Visual regression** — `expect(page).toHaveScreenshot()` is not emitted by the transcriber.
- **Network mocking** — the Explorer's tool surface has no `route()` tool.
- **GitHub Action** — no workflow file ships with the repo today.

These belong to the v3 surface and will be added in their own scoped passes.
