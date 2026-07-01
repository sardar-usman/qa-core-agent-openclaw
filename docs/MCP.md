# Using QA-Core as an MCP server

QA-Core ships an MCP (Model Context Protocol) server that exposes its three workflows — `qa_explore`, `qa_generate`, `qa_heal` — to any MCP-aware client. Once installed, you can drive QA-Core directly from Claude Desktop, Cursor, Cline, Continue, Zed, or anything else that speaks MCP.

## What this unlocks

- **No gateway, no UI, no clone-and-run.** Your AI editor talks to the QA-Core server directly.
- **Composition.** In Claude Desktop you can chain QA-Core with other MCP servers — e.g., *"explore https://staging.example.com, then create a Linear ticket with the test plan."*
- **The same multi-agent pipeline** (Planner → Explorer → Critic + Healer) runs under the hood. The MCP client just sees three tools.

## Prerequisites

- Node.js 20+
- The QA-Core repo checked out somewhere on disk
- `npm install` has been run inside the repo
- `npx playwright install chromium` (the server drives a real browser)
- An `ANTHROPIC_API_KEY` — set in the MCP client's env block (NOT the `.env` file; MCP launches the server in its own env)

## Installing in Claude Desktop

Open `claude_desktop_config.json` and add a `qa-core` entry under `mcpServers`. Replace `/absolute/path/to/qa-core-agent` with the actual checkout path.

```json
{
  "mcpServers": {
    "qa-core": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/qa-core-agent/src/mcp/server.ts"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "QA_CORE_PROJECT_ROOT": "/absolute/path/to/qa-core-agent",
        "QA_CORE_MAX_USD": "2.00"
      }
    }
  }
}
```

**Config locations:**

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Restart Claude Desktop. You should see `qa-core` appear in the tools menu (🔌 icon).

## Installing in Cursor

Cursor uses `~/.cursor/mcp.json`. Same shape:

```json
{
  "mcpServers": {
    "qa-core": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/qa-core-agent/src/mcp/server.ts"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "QA_CORE_PROJECT_ROOT": "/absolute/path/to/qa-core-agent"
      }
    }
  }
}
```

## Installing in Cline (VS Code)

Open the Cline panel → MCP Servers → Edit configuration. Same JSON shape as above.

## Tools the server exposes

| Tool | What it does | Typical duration |
|---|---|---|
| `qa_explore` | Drive a real browser through a URL, run the 3-stage pipeline, return a Playwright spec generated from the verified session. | 30–120s |
| `qa_generate` | Single-shot user-story → spec. Faster but UNVERIFIED — must be run before trusting. | 5–15s |
| `qa_heal` | Open the live page an existing spec targets, probe every locator, and re-resolve the broken ones against it (same ladder as exploration, same-element confirmed). Writes fixes back, reports the rest. Deterministic — no model. | 15–40s |

## Resources the server exposes

| URI | Contents |
|---|---|
| `qa-core://runs` | List of recent run directories under `output/` |
| `qa-core://memory` | All per-host site fingerprints from `.qa-core/sites/` |

## Trying it out

In Claude Desktop, after restart, just chat:

> "Use qa-core to explore https://www.saucedemo.com/ and show me the generated spec."

Claude will:

1. Call the `qa_explore` MCP tool with `url=https://www.saucedemo.com/`
2. The server launches the Planner → Explorer → Critic pipeline (this takes ~60s)
3. The server transcribes the verified trace into a `.spec.ts` file under `output/`
4. The tool result includes the run summary + the full spec content
5. Claude shows you the spec and offers to run it

## Configuration env vars

All optional except `ANTHROPIC_API_KEY`. Sensible defaults are baked in.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(required)* | Your Anthropic API key — used for Planner / Explorer / Critic |
| `QA_CORE_PROJECT_ROOT` | `process.cwd()` | Where `output/` and `.qa-core/` are written |
| `QA_CORE_MODEL_PLANNER` | `claude-haiku-4-5` | Override the Planner's model |
| `QA_CORE_MODEL_EXPLORE` | `claude-opus-4-7` | Override the Explorer's model |
| `QA_CORE_MODEL_CRITIC` | `claude-sonnet-4-6` | Override the Critic's model |
| `QA_CORE_MODEL_TRANSCRIBE` | `claude-sonnet-4-6` | Override the model used by `qa_generate` |
| `QA_CORE_MAX_STEPS` | `40` | Hard ceiling on tool calls per `qa_explore` |
| `QA_CORE_MAX_USD` | `2.00` | Hard ceiling on cost per `qa_explore` run |

## Troubleshooting

**The server doesn't appear in my client.** Check the client's log — Claude Desktop logs to `~/Library/Logs/Claude/mcp*.log` on macOS. The most common cause is a wrong absolute path in `args`.

**`ANTHROPIC_API_KEY is not set` error.** The MCP client launches the server in an isolated env. The key in your shell's `.zshrc` or the project's `.env` file is **not** inherited. Put it in the `env` block of the MCP config.

**Tool times out.** `qa_explore` legitimately takes 30–120s. Most clients accept this. If yours doesn't, run `npm run gateway` and use the web UI instead.

**Chromium not found.** Run `npx playwright install chromium` once inside the project root.

## Running the server standalone (for debugging)

```bash
npm run mcp
```

Then pipe MCP-formatted JSON-RPC into stdin. Easier: use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector npx tsx src/mcp/server.ts
```

That opens a UI where you can list tools, call them, and inspect resource reads.
