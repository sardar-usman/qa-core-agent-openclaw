# 🧪 QA-Core — Autonomous QA Agent for Playwright Test Generation

> An AI agent that writes your Playwright tests so your team doesn't have to.

Built on [OpenClaw](https://openclaw.dev) · Powered by LLMs · Available on Web and Telegram

---

## What Is QA-Core?

QA-Core is an autonomous QA agent with three core capabilities — each available as a simple slash command via web or Telegram:

| Command | What It Does |
|---|---|
| `/explore <url>` | Opens the URL, maps the entire UI, generates a complete Playwright test suite |
| `/generate <story>` | Converts a user story or Jira ticket into test scenarios + Playwright code |
| `/watch <owner/repo>` | Monitors a GitHub repo, detects new PRs, auto-generates tests for changed files |

No boilerplate. No copy-pasting selectors. No writing the same login test for the 40th time.

---

## Demo

### `/explore` — URL to Playwright tests in under 2 minutes

```
You: /explore https://www.saucedemo.com/

QA-Core: Exploring saucedemo.com — mapping UI elements now.

Found: 3 inputs, 1 button, 1 error container
Flows identified: Login (happy path), Login (invalid credentials), Empty submission

Generating tests...

✅ Done.
- Login.page.ts (Page Object Model)
- login.spec.ts (6 tests: 1 happy path, 4 negative, 1 edge case)
- element-map.md (full element inventory)

Saved to ./output/
```

### `/generate` — User story to test code

```
You: /generate As a user I want to add items to my shopping cart so I can purchase them later

QA-Core: Derived 6 scenarios (2 happy path, 2 negative, 2 edge case).
Does this look right? Reply "generate" to proceed.

You: generate

QA-Core: ✅ cart.spec.ts generated — 6 tests ready to run.
Saved to ./output/
```

### `/watch` — Auto-tests for every PR

```
You: /watch muhammadusman/demo-ecommerce

QA-Core: Watching muhammadusman/demo-ecommerce. I'll notify you when a PR opens.

--- 3 hours later ---

QA-Core: 🔔 New PR detected — PR #42: "Add discount code to checkout"
Files changed: 3 testable files
Tests generated: 10
Report saved to ./output/pr-42/
```

---

## Example Output

Real generated files are in the `/examples` folder:

- [`examples/explore-output/`](./examples/explore-output/) — Page Object + spec file from `/explore`
- [`examples/generate-output/`](./examples/generate-output/) — Scenarios + spec file from `/generate`
- [`examples/watch-output/`](./examples/watch-output/) — PR coverage report from `/watch`

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/sardarusmanjutt/qa-core-agent.git
cd qa-core-agent
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` and add your GitHub token (required for `/watch`):

```
GITHUB_TOKEN=your_github_personal_access_token
```

[Create a GitHub token →](https://github.com/settings/tokens) (scopes needed: `repo` or `public_repo`)

### 3. Configure OpenClaw

Copy the config to your OpenClaw directory:

```bash
cp .openclaw/config.json ~/.openclaw/agents/qa-core.json
```

Update the file paths in `qa-core.json` to match where you cloned this repo.

### 4. Add Telegram bot token (optional)

If you want to use QA-Core via Telegram:

```bash
mkdir -p ~/.openclaw/secrets
echo "YOUR_TELEGRAM_BOT_TOKEN" > ~/.openclaw/secrets/telegram-bot-token
chmod 600 ~/.openclaw/secrets/telegram-bot-token
```

[Create a Telegram bot →](https://t.me/BotFather)

### 5. Start QA-Core

```bash
openclaw agent start qa-core
```

---

## Agent Configuration

| File | Purpose |
|---|---|
| [`agent/SOUL.md`](./agent/SOUL.md) | Agent personality, rules, and behavior |
| [`agent/IDENTITY.md`](./agent/IDENTITY.md) | Who QA-Core is and what it does |
| [`agent/TOOLS.md`](./agent/TOOLS.md) | Tools and integrations available |
| [`agent/MEMORY.md`](./agent/MEMORY.md) | Persistent context across sessions |
| [`skills/explore-url.md`](./skills/explore-url.md) | `/explore` command logic |
| [`skills/generate-tests.md`](./skills/generate-tests.md) | `/generate` command logic |
| [`skills/watch-repo.md`](./skills/watch-repo.md) | `/watch` command logic |

---

## Tech Stack

- **[OpenClaw](https://openclaw.dev)** — Agent runtime, channel integrations, skill routing
- **Playwright (TypeScript)** — Test generation and UI exploration
- **GitHub API** — PR monitoring and file diff analysis
- **Telegram** — Mobile access to the agent
- **Page Object Model** — Default test architecture

---

## Requirements

- OpenClaw installed and running
- Node.js 20+
- Playwright: `npm install @playwright/test && npx playwright install chromium`
- GitHub Personal Access Token (for `/watch` only)
- Telegram Bot Token (for Telegram access only)

---

## Built By

**Muhammad Usman**  
Senior QA Automation Engineer & SQA Automation Lead  
ISTQB CTFL Certified · Upwork Top Rated Plus (Top 3% globally)  
10+ years in QA automation across enterprise and startup environments

🌐 [sardarusmanjutt.com](https://sardarusmanjutt.com)  
💼 [LinkedIn](https://linkedin.com/in/sardarusmanjutt)  
📧 muhammad.usman101@hotmail.com

---

## License

MIT — use it, fork it, build on it.
