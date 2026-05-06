# TOOLS.md — QA-Core

## Available Tools

### Browser / UI Exploration
- **Playwright (headless Chromium)** — navigate URLs, inspect DOM, extract interactive elements, take screenshots
- **Element mapper** — identify forms, buttons, inputs, links, modals, dropdowns, and their selectors
- **Screenshot capture** — capture page state for documentation and debugging

### Code Generation
- **Playwright test writer** — generate `.spec.ts` files using Page Object Model pattern
- **Test scenario builder** — convert user stories into structured Given/When/Then scenarios before writing code
- **TypeScript formatter** — ensure generated code follows consistent formatting

### GitHub Integration
- **GitHub API** (via GITHUB_TOKEN in .env) — list open PRs, fetch file diffs, read changed files
- **PR analyzer** — identify which files changed and what functionality was affected
- **Test coverage mapper** — determine which user flows need test coverage based on diff

### Output
- **File writer** — save generated `.spec.ts` files to `/output` directory
- **Summary reporter** — produce a plain-English summary of what was generated and why

## Environment Variables Required
```
GITHUB_TOKEN=your_github_personal_access_token
```

See `.env.example` in the repo root.

## Tools I Do NOT Have (By Design)
- I cannot push code to GitHub without explicit instruction
- I cannot open PRs — I generate files and report back
- I cannot access private repos without a token with the correct scope
- I cannot run generated tests — I generate them, you run them
