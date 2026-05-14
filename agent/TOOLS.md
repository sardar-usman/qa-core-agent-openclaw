# TOOLS.md — QA-Core

## Available Tools

### Browser / UI exploration (via Playwright)

The agent uses Playwright as a **live tool surface** through Claude tool-use. Every action is observed before the next is taken.

- `navigate(url)` — open a URL
- `click(selector)` — click an element resolved through the selector cascade
- `fill(selector, value)` — type into an input
- `getDom(scope)` — return a pruned, agent-friendly view of the DOM in scope
- `screenshot()` — capture page state (sent as image content to Claude for visual reasoning)
- `assert(name, kind, args)` — record an assertion (visibility, text, URL, count, etc.)
- `saveStep(label)` — checkpoint the current state as a named step
- `finish(summary)` — end the run and trigger transcription

### Selector cascade

Selectors are resolved in this order (best to worst):

1. `getByRole(role, { name })` — accessibility-first
2. `getByLabel(text)` — form/labeled inputs
3. `getByTestId(id)` — when `data-testid` is present
4. CSS — last resort

Every assertion in the generated spec carries metadata indicating which cascade level produced its selector.

### Code generation

- **Trace transcriber** — converts the verified tool-use trace into a Playwright spec in JS or TS (user-selected).
- **axe-core auto-injection** — every generated spec includes an `@axe-core/playwright` accessibility check.
- **Page Object Model emitter** is the default. Every `/explore` run emits a `BasePage` plus one `<Feature>Page` class per detected page with typed `Locator` fields. Common step sequences (e.g. two fills + a click) are synthesized as action methods on the page class (e.g. `loginAs(user, pass)`). Spec lives in `tests/`; a11y in `a11y/`. Pass `--no-pom` for legacy single-file inline output.

### Output

- **File writer** — saves `output/<run-id>/<name>.spec.{ts,js}` and optional POM files.
- **Run report** — JSON summary with: scenarios derived, tests generated, selectors-by-cascade-level, cost (USD + tokens), pass-rate on self-play.

## Environment variables

See `.env.example`. Minimum required: `ANTHROPIC_API_KEY`.

## OpenClaw integration

The web UI ([`qa-core-ui.html`](../qa-core-ui.html)) talks to a WebSocket gateway at `ws://127.0.0.1:18789` (configurable). The gateway is registered in [`.openclaw/config.json`](../.openclaw/config.json) as the agent's WebSocket runner: OpenClaw routes incoming slash commands from the web/Telegram channels to the gateway, the gateway invokes the TypeScript runtime which calls Claude directly via the Anthropic SDK, and streamed events flow back to the channel.

Start it with `npm run gateway`. Multi-agent staging (Planner → Explorer → Critic) and prompt caching are handled inside the runtime — OpenClaw sees only the chat-level conversation.

## Tools I do NOT have (by design)

- I cannot push code to GitHub or open PRs.
- I cannot execute destructive actions (delete, drop, force-push).
- I cannot read files outside the repo I'm running in.
- I will refuse to run if the per-run cost ceiling (`QA_CORE_MAX_USD`) is set to zero.
