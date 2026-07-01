---
name: qa-core-ui-design
description: "Design and visually verify changes to the QA-Core UI (qa-core-ui.html — the dashboard + chat + run-history surface served by the WebSocket gateway at ws://127.0.0.1:18789). Use when planning UI changes, restyling components, adjusting layout/typography/colors, debugging visual regressions, or auditing accessibility on the dashboard. Wraps the workflow: read the design language → make changes → drive the live UI via Playwright/Chrome-DevTools MCP → take screenshots at relevant states → compare against intent → fix → re-verify. Composes with [[ui-ux-pro-max]] (general design intelligence) and the [[shadcn-ui]] MCP (component patterns). Use BEFORE shipping any change that affects qa-core-ui.html, related CSS, or the framework-zip card."
---

# QA-Core UI Design Skill

Project-scoped workflow for designing, modifying, and verifying changes to the QA-Core dashboard UI.

## When to use

**Must use** when the task involves:
- Editing `qa-core-ui.html` (CSS or HTML)
- Adjusting the dashboard layout (recent runs, sites grid, pipeline indicator)
- Changing the run-card / framework-zip-card rendering
- Restyling tokens (`--bg-1`, `--accent`, font sizes, spacing)
- Reviewing the UI for "looks unprofessional"

**Should use** when:
- The user complains about visual issues ("why is this overlapping?", "the spacing looks off")
- Adding a new dashboard panel or component
- Auditing accessibility / contrast / focus states on the dashboard

**Skip** when:
- Changes are purely backend (`src/agent/`, `src/server/`, `src/cli/`)
- Markdown/docs edits only
- The change is captured by an existing smoke test (`smoke-ui*.ts`) and the test passes

## The UI in one paragraph

[`qa-core-ui.html`](../../../qa-core-ui.html) is a single-file dark-mode dashboard for the QA-Core agent. ~4600 lines: top a chat + slash-command bar, middle the dashboard (overall stats, sites tested grid, recent runs), bottom a run-history panel with expandable cards. Connects to the WebSocket gateway at `ws://127.0.0.1:18789` (started via `npm run gateway`). All state lives in localStorage under `qa-core.runs.v1`. Design language: dark, monospace-mixed, accent purple gradient, Geist + Geist Mono typography. Tokens defined at the `:root` of the inline `<style>`.

## Workflow

### 1. Read the design intent

Before touching CSS:
- Skim the relevant section of [`qa-core-ui.html`](../../../qa-core-ui.html) — find the CSS class, e.g. `.recent-run`, `.run-card-summary-preview`, `.framework-zip-card`.
- Note the design tokens in use (`var(--bg-2)`, `var(--text-3)`, etc.).
- Match the existing token vocabulary; do NOT introduce new color values inline.

For broader design decisions (color systems, typography, spacing, component patterns), invoke [[ui-ux-pro-max]] — it has 50+ styles, 161 palettes, 57 font pairings, plus a-11y/animation guidance.

### 2. Make the change

- Prefer additive CSS classes over editing existing ones.
- When inserting a new element into a card, follow the existing one-line-with-ellipsis pattern (see `.recent-run-summary` for the canonical example).
- Touch the JS rendering function (e.g. `recentRunHtml`, `runCardHtml`) in the same edit — never CSS-only or JS-only changes for visible elements.

### 3. Verify visually

This is where the MCPs earn their keep.

**Quick check (no MCP) — headless screenshot via tsx:**
```bash
# Spin a small script that opens qa-core-ui.html, seeds localStorage with
# representative runs, screenshots key states. Mirror the pattern from
# scripts/smoke-ui-brand-label.ts (lines 75-90: handleAgentMessage injection).
npx tsx scripts/<your-screenshot-script>.ts
```
Then `Read` the saved PNG path — Claude renders images inline.

**Interactive check (Playwright MCP) — preferred during active design work:**
- Tool: `mcp__playwright__browser_navigate` → file:// URL of qa-core-ui.html
- Tool: `mcp__playwright__browser_snapshot` → accessibility tree
- Tool: `mcp__playwright__browser_take_screenshot` → PNG
- Tool: `mcp__playwright__browser_click` / `_type` → drive the chat input, trigger states
- Tool: `mcp__playwright__browser_resize` → check responsive breakpoints (1440 / 1024 / 768 / 414)

**Performance + DOM forensics (Chrome DevTools MCP):**
- Tool: `mcp__chrome-devtools__list_console_messages` → catch console errors
- Tool: `mcp__chrome-devtools__performance_start_trace` / `_stop_trace` → measure render cost
- Tool: `mcp__chrome-devtools__list_network_requests` → confirm WebSocket handshake

**Component lookup (shadcn-ui MCP):**
- Tool: `mcp__shadcn-ui__get_components` → list available shadcn primitives
- Tool: `mcp__shadcn-ui__get_component_demo` → see usage examples
- Use sparingly — current UI is hand-rolled, not shadcn. Only invoke when explicitly migrating a section to shadcn or comparing patterns.

### 4. Verify regressions

Always re-run:
```bash
npx tsc --noEmit
npx tsx scripts/smoke-ui.ts
npx tsx scripts/smoke-ui-brand-label.ts
npx tsx scripts/smoke-ui-download.ts
```

If you added a new persistent element (card, panel, badge), add a corresponding smoke assertion. The existing brand-label / framework-zip-card patterns are the templates to follow.

### 5. Restart the gateway when JS changed

If the change touches anything under `src/`, the gateway must be restarted before the UI will reflect it:

```bash
lsof -ti :18789 | xargs kill -9 2>/dev/null; sleep 1; npm run gateway
```

Then refresh the browser tab so the WebSocket reconnects. Pure CSS/HTML changes in `qa-core-ui.html` only require a browser refresh.

## Design invariants (do not violate)

Cross-referenced from [`CLAUDE.md`](../../../CLAUDE.md):

1. **Brand display, not host display.** Site cards / run cards / recent runs render `brandFromHost(host)` (e.g. `saucedemo`), never the raw URL. Full host stays as a `title=` tooltip.
2. **Per-feature naming.** UI labels reflect `<brand> · <feature1>, <feature2>` from the run's feature tags.
3. **One-line summary previews.** Both `recent-run-summary` and `run-card-summary-preview` use single-line ellipsis with the full text in a `title=` attribute.
4. **Dashboard per-site math divides by `runsWithPass`, not total runs.** [qa-core-ui.html:4044](../../../qa-core-ui.html). Do not revert.
5. **No new color hex values.** Use existing CSS custom properties (`--bg-1` through `--bg-3`, `--text` / `--text-2` / `--text-3`, `--accent`, `--brand`, etc.). New tokens go in the `:root` block at the top of `<style>`.
6. **No emojis in UI text** unless the user explicitly asks. Use inline SVG icons matching the existing pattern (see `iconForType` at line ~4248).

## Files this skill touches most

- [`qa-core-ui.html`](../../../qa-core-ui.html) — the single-file dashboard
- [`scripts/smoke-ui*.ts`](../../../scripts/) — visual regression locks
- [`src/server/gateway.ts`](../../../src/server/gateway.ts) — what the UI receives via WebSocket
- [`CLAUDE.md`](../../../CLAUDE.md) — invariants 1, 7 directly relevant

## MCP setup

This skill assumes three MCPs are registered in [`.mcp.json`](../../../.mcp.json):

| MCP | Purpose | Tool prefix |
|---|---|---|
| `playwright` | Drive a real browser, screenshot, click, type | `mcp__playwright__` |
| `chrome-devtools` | Console, network, performance traces | `mcp__chrome-devtools__` |
| `shadcn-ui` | Component pattern lookup | `mcp__shadcn-ui__` |

If MCP tools aren't appearing, the user must **restart Claude Code** — `.mcp.json` is read at session start, not hot-reloaded. After restart, run `/mcp` in the chat to list registered servers.

## Composition with other skills

- **For visual design language decisions** (palette, typography, spacing, motion), defer to [[ui-ux-pro-max]] — it has the comprehensive guide.
- **For shadcn-specific component implementation**, the shadcn-ui MCP provides component code; combine with [[ui-ux-pro-max]]'s "shadcn/ui" stack guidance.
- **For accessibility audits**, [[ui-ux-pro-max]]'s 99 UX guidelines + the existing `tests/a11y/landing.a11y.spec.ts` pattern (axe-core) are the references.
