# Skill: heal-spec

- Command: `/heal <spec-path>`
- Trigger: User sends `/heal output/<run-id>/<name>.spec.ts`

## Purpose

Re-resolve selectors in a generated Playwright spec that has started failing because the target page changed. The healed spec is written next to the original as `<spec>.healed.<ext>`, with inline comment annotations showing the original call and the model's confidence in the replacement.

## Implementation

Backed by [`src/cli/heal.ts`](../src/cli/heal.ts) → [`src/agent/heal.ts`](../src/agent/heal.ts).

### Step 1 — Run the spec

Runs the target spec with the Playwright JSON reporter and parses the report. Only failures that match selector-style errors (`element not found`, timeout, count mismatch) are eligible for healing — logic failures (wrong text content, wrong URL) are left for a human.

### Step 2 — Re-resolve

For each eligible failure:

- Open the test URL in a fresh browser context.
- Take a DOM snapshot of visible interactive elements.
- Ask the heal model (Sonnet 4.6 by default) for a replacement that matches the original intent.
- **Verify** the proposal resolves to exactly one element via the cascade — if it doesn't, the heal is rejected.
- Reject low-confidence proposals (< 0.4).

### Step 3 — Patch the spec

Surviving proposals are applied to a copy of the spec at `<spec>.healed.<ext>`. Each patched call is preceded by a comment showing the original call so a human reviewer can audit before merging.

### Step 4 — Report

Tell the user:

- Total failures detected vs healed
- Path to the patched spec
- Command to run it: `npx playwright test <healed-spec>`

## Output files

- `<spec>.healed.<ext>` — patched spec with confidence-scored heals inline
