# Skill: explore-url

- Command: `/explore <url> [--lang ts|js]`
- Trigger: User sends `/explore https://example.com`

## Purpose

Drive a real browser through the given URL using a Claude tool-use loop, then transcribe the verified session into a Playwright test suite. The generated tests have already passed once — every action in the spec corresponds 1:1 to an action the agent executed live.

## Implementation

This skill is backed by code in [`src/cli/explore.ts`](../src/cli/explore.ts) → [`src/agent/runtime.ts`](../src/agent/runtime.ts).

### Step 1 — Validate input

- Extract `<url>` from the command. Must start with `http://` or `https://`.
- Read optional `--lang ts|js` (default `ts`) and `--name <basename>` flags.
- Confirm: "Exploring `<url>` — driving a real browser. ~30–90s."

### Step 2 — Tool-use loop

The runtime spawns a Chromium browser (reusing storage state from [`tests/auth.setup.ts`](../tests/auth.setup.ts) if available) and exposes these tools to Claude:

- `navigate(url)` — go to a URL
- `get_dom()` — return a pruned snapshot of interactive elements
- `click(intent, …)` / `fill(intent, value, …)` / `press(intent, key, …)`
- `assert(type, …)` — `toBeVisible` / `toHaveText` / `toContainText` / `toHaveURL` / `toHaveCount`
- `begin_scenario(name, category)` / `end_scenario()`
- `finish(summary)`

Selectors are resolved via cascade: `getByRole` → `getByLabel` → `getByTestId` → CSS. The cascade level that wins is recorded for the transcriber.

### Step 3 — Enforce budgets

- Step ceiling: `QA_CORE_MAX_STEPS` (default 40).
- Cost ceiling: `QA_CORE_MAX_USD` (default $2.00). Loop aborts if exceeded.
- Prompt caching is applied to the system prompt — repeat runs reuse the cache (~90% cheaper).

### Step 4 — Transcribe

The verified trace is handed to [`src/agent/transcriber.ts`](../src/agent/transcriber.ts) which emits a Playwright spec in the chosen language. Every spec includes an auto-injected `@axe-core/playwright` accessibility check on the landing page.

### Step 5 — Report

Output to the user:

- Number of scenarios recorded
- Number of tests in the generated spec
- Cost (USD) and tokens consumed
- Cascade distribution (how many selectors hit `role` vs `label` vs `testid` vs `css`)
- Path to the generated spec
- Command to run it: `npx playwright test <path>`

## Output files

- `output/<run-id>/<name>.spec.{ts,js}` — the generated Playwright spec
- `output/<run-id>/run-report.json` — scenarios, cost, cascade stats, timings
