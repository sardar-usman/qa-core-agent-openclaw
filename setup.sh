#!/usr/bin/env bash
set -euo pipefail

REPO_PATH=$(pwd)
echo "Setting up QA-Core at: $REPO_PATH"

# OpenClaw agent registration
mkdir -p "$HOME/.openclaw/agents"
if [ -f .openclaw/config.json ]; then
  cp .openclaw/config.json "$HOME/.openclaw/agents/qa-core.json"
fi

# .env scaffolding
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  → .env created. Open it and add ANTHROPIC_API_KEY before running."
fi

# Output directory for generated specs
mkdir -p output

# Node dependencies
if [ -f package.json ] && command -v npm >/dev/null 2>&1; then
  echo "  → Installing Node dependencies..."
  npm install
  echo "  → Installing Playwright browsers..."
  npx playwright install --with-deps chromium
fi

cat <<'EOF'

✅ QA-Core setup complete.

Next steps:
  1. Add ANTHROPIC_API_KEY to .env

  CLI:
    npm run explore  -- https://www.saucedemo.com/
    npm run generate -- "As a user I want to log in..."
    npm run heal     -- output/<run-id>/<name>.spec.ts
    npm test                     # execute generated suite
    npm run eval                 # eval harness across 3 public sites

  Web UI:
    npm run gateway              # starts WebSocket gateway on :18789
    open qa-core-ui.html         # in another terminal / browser tab
    click Connect, type /explore <url>

EOF
