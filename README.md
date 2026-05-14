# QA-Core

**Autonomous Playwright test generation, powered by Claude.**

QA-Core is an AI agent that opens a real browser, explores your app, reviews its own work, and writes a Playwright test suite. Every test runs and passes once inside the agent before it is saved to disk, so you get specs that already work on day one.

Built on [Claude](https://www.anthropic.com/) by Anthropic. Distributed through [OpenClaw](https://openclaw.dev). Drives [Playwright](https://playwright.dev/).

## Table of contents

1. [What it does](#what-it-does)
2. [Why this is different](#why-this-is-different)
3. [How it works](#how-it-works)
4. [Quick start](#quick-start)
5. [Commands](#commands)
6. [Web UI](#web-ui)
7. [MCP server](#mcp-server-for-claude-desktop-cursor-cline-continue)
8. [Model routing and budgets](#model-routing-and-budgets)
9. [Evaluation results](#evaluation-results)
10. [Project layout](#project-layout)
11. [Configuration files](#configuration-files)
12. [Requirements](#requirements)
13. [About the author](#about-the-author)
14. [License](#license)

## What it does

QA-Core exposes three commands. Each one solves a different problem in test automation.

| Command | What you give it | What you get back |
| ------- | ---------------- | ----------------- |
| `npm run explore` | A live URL | A full Playwright suite written from a verified browser session, with a Page Object Model framework |
| `npm run generate` | A user story or Jira ticket | A Playwright spec built from acceptance criteria. You can run it to verify |
| `npm run heal` | A spec that broke because the page changed | A patched copy with re-resolved selectors and confidence scores |

Generated files land under `output/<run-id>/`.

## Why this is different

Most "AI test generators" take a single DOM snapshot, hand it to an LLM, and hope the output works. QA-Core does not do that.

It runs a real agent pipeline:

* The **Planner** uses Haiku to read one page snapshot and write a numbered scenario list.
* The **Explorer** uses Opus and a tool-use loop to drive the browser. It navigates, clicks, fills, and asserts against the live page. Every action is verified before the next one.
* The **Critic** uses Sonnet to review the trace and label each scenario as ship, weak, or fix.
* The **Transcriber** is deterministic. It turns the verified trace into Playwright code.
* The **Healer** is on-demand. When a real Playwright run fails because the page changed, it re-resolves the broken selectors live.

This means every line in the final spec corresponds to an action that already worked once against your real app.

## How it works

```text
                         ┌── per-host memory ──┐
                         │  (loaded as cached  │
                         │   system block)     │
                         └──────────┬──────────┘
                                    │
[1] Planner   (Haiku)  ─────────────┘
    1 page snapshot then numbered scenario list

[2] Explorer  (Opus)  ◀─ tool-use loop with prompt caching
    navigate / click / fill / assert / get_dom / finish
    every action verified against the live page

[3] Critic    (Sonnet)
    reads the trace, returns ship / weak / fix verdicts

       ↓

  trace transcriber then output/<run-id>/<name>.spec.ts
                       then run-report.json (plan, verdicts, cost, cascade)
```

```mermaid
flowchart LR
    classDef stage fill:#1a1a22,stroke:#b9a6ff,color:#f5f5f7
    classDef optional fill:#131318,stroke:#f4c560,stroke-dasharray:5 5,color:#f4c560
    classDef io fill:#0d0d10,stroke:#5b5b66,color:#9d9da7
    classDef memory fill:#0d0d10,stroke:#5dd5a4,color:#5dd5a4

    URL[URL or Story]:::io
    P[Planner Haiku 4.5 ~$0.001]:::stage
    REV[Review checkpoint --review plan.csv]:::optional
    E[Explorer Opus 4.7 tool-use loop]:::stage
    C[Critic Sonnet 4.6 ship/weak/fix]:::stage
    T[Transcriber deterministic + axe-core]:::stage
    H[Healer Sonnet 4.6 on-demand]:::stage
    SPEC[.spec.ts or .spec.js]:::io
    CI[CI / GitHub Actions]:::io

    MEM[Per-host memory .qa-core/sites/]:::memory

    URL --> P
    P -.optional.-> REV
    REV -.--from-plan.-> E
    P --> E
    E --> C
    C --> T
    T --> SPEC
    SPEC --> CI
    SPEC -.on failure.-> H
    H -.patched.-> SPEC

    MEM -.cached prompt.-> P
    MEM -.cached prompt.-> E
    E -.observed intents.-> MEM
```

### The selector cascade

QA-Core picks selectors in this order: `getByRole`, then `getByLabel`, then `getByTestId`, then CSS as a last resort. The level that resolved each call is logged. The transcriber emits the most resilient selector available, and the Critic can flag overuse of CSS.

### Auto-injected accessibility checks

Every generated spec ships with an `@axe-core/playwright` accessibility check against the landing page. You get WCAG 2 AA coverage by default.

### Per-host memory

After each run, the agent saves what it learned about that site to `.qa-core/sites/<host>.json`. This includes the intents it observed and the selector cascade level that worked. The next run against the same host loads this memory into the system prompt as a cached block. Repeat runs are typically 90 percent cheaper than the cold path.

### Self-healing

When a spec fails because the page changed, `npm run heal` re-resolves the broken selectors on the live page. Each replacement is verified to resolve to exactly one element before it lands in the patched copy at `<spec>.healed.<ext>`. A comment annotation shows the original call and the model's confidence.

### More reference material

* Full reference: [`docs/DOCUMENTATION.md`](./docs/DOCUMENTATION.md). Every component, flag, env var, and file format.
* Flow diagram in SVG: [`docs/architecture.svg`](./docs/architecture.svg).
* Interactive HTML page: [`docs/architecture.html`](./docs/architecture.html).
* MCP install guide: [`docs/MCP.md`](./docs/MCP.md).

## Quick start

```bash
git clone https://github.com/sardarusmanjutt/qa-core-agent.git
cd qa-core-agent
cp .env.example .env          # then add your ANTHROPIC_API_KEY
bash setup.sh                 # installs dependencies and Playwright Chromium
```

Required environment variable: `ANTHROPIC_API_KEY`. Get one at [console.anthropic.com](https://console.anthropic.com/settings/keys).

Optional: `QA_CORE_AUTH_URL`, `QA_CORE_AUTH_USER`, `QA_CORE_AUTH_PASS` if you want a stored auth session reused across tests. See [`tests/auth.setup.ts`](./tests/auth.setup.ts).

## Commands

### Explore a URL

```bash
npm run explore -- https://www.saucedemo.com/
npm run explore -- https://www.saucedemo.com/ --lang js      # JavaScript output
npm run explore -- https://www.saucedemo.com/ --name login   # custom filename
```

By default `/explore` emits a full Page Object Model framework. Output lands under `output/<timestamp>-<host>/`:

```text
output/20260514-160000-saucedemo-com/
  pages/
    BasePage.ts                    # base class with goto + waitReady helpers
    SaucedemoPage.ts               # typed Locator fields + loginAs(user, pass)
  tests/
    saucedemo.spec.ts              # spec that uses the page object
  a11y/
    landing.a11y.spec.ts           # auto-injected WCAG 2 AA check
  run-report.json                  # cost, cascade stats, scenario list
```

The page class looks like this:

```typescript
export class SaucedemoPage extends BasePage {
  readonly url = "https://www.saucedemo.com/";
  readonly username: Locator;
  readonly password: Locator;
  readonly loginButton: Locator;
  readonly loginError: Locator;

  constructor(page: Page) {
    super(page);
    this.username    = page.getByRole("textbox", { name: "Username" });
    this.password    = page.getByRole("textbox", { name: "Password" });
    this.loginButton = page.getByRole("button",  { name: "Login" });
    this.loginError  = page.locator("[data-test=error]");
  }

  async loginAs(username: string, password: string): Promise<void> {
    await this.username.fill(username);
    await this.password.fill(password);
    await this.loginButton.click();
  }
}
```

And the spec that uses it:

```typescript
test("[happy] logged in with valid credentials", async ({ page }) => {
  await saucedemoPage.loginAs("standard_user", "secret_sauce");
  await expect(page).toHaveURL(/inventory/);
});
```

If you prefer a single-file output without the page object, pass `--no-pom`.

### Review mode (sign-off before automation)

For team workflows where a lead needs to approve scenarios before the Explorer runs:

```bash
npm run explore -- https://www.saucedemo.com/ --review
# writes output/<run-id>/plan.csv and exits
```

Open `plan.csv` in Excel, Numbers, or Google Sheets. Set `Approve=no` on any row you want to skip. Then resume:

```bash
npm run explore -- --from-plan output/<run-id>/plan.csv
# skips Planner, runs Explorer + Critic + Transcriber on approved scenarios only
```

The Planner cost is paid only once. The CSV header preserves the target URL, so the resume command needs no extra arguments.

### Generate tests from a user story

```bash
npm run generate -- "As a user I want to log in so I can access my dashboard"
npm run generate -- "..." --lang js --base-url https://staging.example.com
```

This one does not open a browser. It produces code from acceptance criteria. Run the spec to verify it works against your real app.

### Heal a spec that broke

```bash
npm run heal -- output/<run-id>/<name>.spec.ts
```

QA-Core runs the spec, finds selector-style failures, opens the URL in a fresh browser, and proposes replacements. Each replacement is verified to resolve to exactly one element before it is written to `<spec>.healed.<ext>`. The patched file includes a comment with the original call and the model's confidence score.

### Run the suite

```bash
npx playwright test output/<run-id>/<name>.spec.ts
```

Playwright is configured with Chromium, Firefox, WebKit, and mobile projects. CI mode adds retries, trace on first retry, and an HTML report.

## Web UI

The chat-style UI at [`qa-core-ui.html`](./qa-core-ui.html) talks to a WebSocket gateway that bridges the OpenClaw web surface to the agent runtime.

```bash
npm run gateway              # starts ws://127.0.0.1:18789
open qa-core-ui.html         # in your browser
```

Click **Connect** in the header. Then type a slash command:

* `/explore https://...`
* `/generate "user story"`
* `/heal output/<run-id>/<name>.spec.ts`

The gateway streams progress messages as the Planner, Explorer, and Critic stages run. It then sends the generated spec as a final message that the UI renders as a copy and save code block. The Activity panel on the right has three tabs: Results (run history), Files (list of generated files with copy and download), and Log (live event stream). The refresh button re-syncs runs from the gateway.

Optional auth: set `QA_CORE_GATEWAY_TOKEN` in your environment. The UI accepts the token via the page URL fragment, for example `qa-core-ui.html#token=<value>`.

## MCP server (for Claude Desktop, Cursor, Cline, Continue)

QA-Core ships an MCP (Model Context Protocol) server. Any MCP-aware client can use the three workflows as first-class tools, with no gateway, no UI, and no clone-and-run setup.

```bash
npm run mcp                  # standalone, useful for debugging via MCP Inspector
```

For real use, point your AI client at the server through its config file. The full install guide is [`docs/MCP.md`](./docs/MCP.md). An example Claude Desktop config is at [`docs/claude_desktop_config.example.json`](./docs/claude_desktop_config.example.json).

Once installed, in Claude Desktop you can just chat:

> "Use qa-core to explore `https://www.saucedemo.com/` and show me the generated spec."

Claude calls the `qa_explore` MCP tool. The server runs the multi-agent pipeline and returns the verified spec.

**Tools exposed:** `qa_explore`, `qa_generate`, `qa_heal`.
**Resources exposed:** `qa-core://runs`, `qa-core://memory`.

## Model routing and budgets

Each stage of the pipeline uses a different model so cost stays low and quality stays high. You can override any of them with environment variables.

| Setting | Default | Purpose |
| ------- | ------- | ------- |
| `QA_CORE_MODEL_PLANNER` | `claude-haiku-4-5` | Cheap scenario derivation pre-pass |
| `QA_CORE_MODEL_EXPLORE` | `claude-opus-4-7` | Browser-driving tool-use loop. Use Opus for hard sites |
| `QA_CORE_MODEL_CRITIC` | `claude-sonnet-4-6` | Post-run review with per-scenario verdicts |
| `QA_CORE_MODEL_HEAL` | `claude-sonnet-4-6` | Selector re-resolution in `npm run heal` |
| `QA_CORE_MODEL_TRANSCRIBE` | `claude-sonnet-4-6` | Story to spec in `npm run generate` |
| `QA_CORE_MAX_STEPS` | `40` | Hard ceiling on tool calls per `/explore` |
| `QA_CORE_MAX_USD` | `2.00` | Hard ceiling on cost per run. The agent aborts if exceeded |

Prompt caching is enabled on three cached blocks: the frozen behavior rules, the site memory for the target host, and the planner output. Repeat runs against the same host reuse the first two. Cost is typically 90 percent lower than a cold run.

## Evaluation results

QA-Core ships an evaluation suite that runs the agent against three public test sites, executes the generated specs, and publishes pass-rate, flake-rate, cost, and selector cascade distribution.

```bash
npm run eval
# writes eval-results/<timestamp>/summary.md
```

Latest run is from 2026-05-14. First-run unfiltered, no self-healing applied.

The first column below shows the original inline output from the eval harness. The second column shows the same agent trace re-emitted through the Page Object Model framework. Same scenarios. Same browser session. Better code emission target.

| Site | Pass-rate (inline) | Pass-rate (POM) |
| ---- | -----------------: | --------------: |
| saucedemo | 50% | 83% |
| the-internet | 29% | 43% |
| practice-todo | 17% | 67% |
| **Aggregate** | **6 of 19 = 32%** | **12 of 19 = 63%** |

POM almost doubles the first-run pass-rate. The reason is consistency. When locators live as typed class fields, the same selector is used in every scenario and across reruns. Inline emission was free to pick a different selector flavour per test, and that introduced flake.

Total cost: $0.7697 across the three sites in 5 minutes 38 seconds. Remaining failures fall into three buckets: selector drift in dynamic DOMs (TodoMVC), strict URL assertions, and unhandled timing on JS-heavy widgets. Each one is a candidate for `npm run heal` to repair, or for the next round of Critic policy tuning. Full breakdown: [`eval-results/2026-05-14T08-04-45-447Z/summary.md`](./eval-results/2026-05-14T08-04-45-447Z/summary.md).

> **A note on absolute pass-rates.** Single-run aggregate numbers are noisy. Public test sites sometimes rate-limit, sleep (Heroku free tier), or rotate selectors. A different eval run in our history showed saucedemo at 80 percent but the-internet at 0 percent, purely because a Heroku cold-start exceeded the default 15 second navigation timeout. The signal worth quoting is the inline-vs-POM delta on identical traces, because that comparison controls for site flakiness. The jump from 32 percent to 63 percent is real and reproducible. Any headline like "we got X percent today" is not. Treat any single eval run as one data point, not the truth.

## Project layout

```text
src/
  agent/
    runtime.ts        # multi-agent pipeline (Planner, Explorer, Critic) + budgets
    planner.ts        # Haiku pre-step: scenario derivation from one DOM snapshot
    critic.ts         # Sonnet post-step: per-scenario ship/weak/fix verdicts
    memory.ts         # per-host fingerprints + project memory, cached into prompt
    heal.ts           # selector self-healing, re-resolves broken calls live
    tools.ts          # Playwright tool surface exposed to Claude
    selectors.ts      # role, label, testid, CSS cascade resolver
    transcriber.ts    # legacy single-file emission (verified trace to inline spec)
    pom.ts            # Page Object Model emitter (default): BasePage + per-page classes
    trace.ts          # types: Scenario, TraceStep, Assertion, RunReport
    generate.ts       # /generate: story to spec, no browser
  cli/
    explore.ts        # npm run explore
    generate.ts       # npm run generate
    heal.ts           # npm run heal
  server/
    gateway.ts        # WebSocket bridge between qa-core-ui.html and the runtime
  mcp/
    server.ts         # MCP server: exposes qa_explore, qa_generate, qa_heal
docs/
  DOCUMENTATION.md    # full reference
  architecture.html   # full-page architecture infographic
  architecture.svg    # single-image flow diagram
  MCP.md              # MCP install guide for Claude Desktop, Cursor, Cline
scripts/
  eval.ts             # npm run eval
tests/
  auth.setup.ts       # storage-state fixture for auth-gated apps
.qa-core/             # per-host memory cache (gitignored)
qa-core-ui.html       # web UI client
playwright.config.ts
.github/workflows/qa-core.yml
```

## Configuration files

The agent's behavior is defined in plain markdown so OpenClaw can load it.

| File | Purpose |
| ---- | ------- |
| [`agent/SOUL.md`](./agent/SOUL.md) | Operating principles, hard rules, defaults |
| [`agent/IDENTITY.md`](./agent/IDENTITY.md) | What QA-Core is and what it does |
| [`agent/TOOLS.md`](./agent/TOOLS.md) | Tool surface and selector cascade |
| [`agent/MEMORY.md`](./agent/MEMORY.md) | Per-project persistent context |
| [`skills/explore-url.md`](./skills/explore-url.md) | `/explore` command behavior |
| [`skills/generate-tests.md`](./skills/generate-tests.md) | `/generate` command behavior |

## Requirements

* Node.js 20 or newer
* `ANTHROPIC_API_KEY`
* Playwright Chromium (`npx playwright install chromium`)

## About the author

**Muhammad Usman**
Senior QA Automation Engineer. AI Test Engineering Lead.
ISTQB CTFL Certified. Upwork Top Rated Plus (Top 3 percent).
10+ years in QA automation.

* Website: [sardarusmanjutt.com](https://sardarusmanjutt.com)
* LinkedIn: [linkedin.com/in/sardarusmanjutt](https://linkedin.com/in/sardarusmanjutt)
* Email: [muhammad.usman101@hotmail.com](mailto:muhammad.usman101@hotmail.com)

## License

MIT. Use it, fork it, build on it.
