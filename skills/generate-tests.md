# Skill: generate-tests

- Command: `/generate "<user story>" [--lang ts|js] [--base-url <url>]`
- Trigger: User sends `/generate As a user I want to log in...`

## Purpose

Turn a user story (or Jira ticket text, or acceptance criteria) into a Playwright spec covering happy-path, negative, and edge scenarios.

Unlike `/explore`, this skill does **not** drive a browser — it's a single LLM call. The resulting spec is marked `UNVERIFIED` in the file header so the user knows to run it before trusting it.

## Implementation

Backed by [`src/cli/generate.ts`](../src/cli/generate.ts) → [`src/agent/generate.ts`](../src/agent/generate.ts).

### Step 1 — Validate input

- Capture the full story text (everything after `/generate`).
- Read optional `--lang ts|js` (default `ts`) and `--base-url <url>`.
- If the story is fewer than ~20 words and has no acceptance criteria, ask one focused clarifying question before proceeding.

### Step 2 — Derive scenarios

Single LLM call (Sonnet 4.6 by default, override with `QA_CORE_MODEL_TRANSCRIBE`). The model returns the spec body in a `<spec>` block, including at minimum:

- One happy path
- One negative case (invalid input, missing field, error state, locked account)
- One edge case (boundary conditions, special characters, empty submission)
- One a11y test using `@axe-core/playwright`

Selector preference (in order): `getByRole` → `getByLabel` → `getByTestId` → CSS.

### Step 3 — Emit spec

The spec is written to `output/<run-id>/<feature>.spec.{ts,js}` with an UNVERIFIED comment header so the user knows it hasn't been executed against a live page.

### Step 4 — Report

Output to the user:

- Feature name derived from the story
- Number of scenarios written
- Path to the spec
- Command to run it: `npx playwright test <path>`

## Handling vague stories

If the story is unworkable (e.g., "As a user I want a good experience"):

- Do not guess.
- Ask: "This story is too broad. Can you give me one specific acceptance criterion or feature to start with?"

## Output files

- `output/<run-id>/<feature>.spec.{ts,js}` — the generated Playwright spec
