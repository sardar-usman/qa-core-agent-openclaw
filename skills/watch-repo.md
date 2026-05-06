# Skill: watch-repo
# Command: /watch <owner/repo>
# Trigger: User sends "/watch muhammadusman/my-app"

## Purpose
Monitor a GitHub repository for new pull requests, analyze changed files, and automatically generate Playwright test cases covering the modified functionality.

## Prerequisites
- GITHUB_TOKEN must be set in .env with repo read access
- Repo must be public OR token must have private repo access

## Step-by-Step Execution

### Step 1 — Validate Input
- Extract owner/repo from command
- Verify GitHub token exists in environment
- Confirm repo is accessible: "Watching [owner/repo] for new PRs. I'll generate tests whenever a PR opens. I'll notify you here and on Telegram."

### Step 2 — Poll for New PRs
Every 5 minutes, check GitHub API:
```
GET /repos/{owner}/{repo}/pulls?state=open&sort=created&direction=desc
```
- Compare against last known PR list stored in MEMORY.md
- If new PR detected → trigger Step 3

### Step 3 — Analyze the PR
For each new PR:
- Fetch PR metadata: title, description, author, base branch
- Fetch file diff: `GET /repos/{owner}/{repo}/pulls/{pull_number}/files`
- Identify changed files by type:
  - `.tsx / .jsx / .vue / .html` → UI changes → UI tests needed
  - `.ts / .js / .py` → Logic changes → unit/integration test scenarios
  - API route files → API test scenarios needed
  - Config files → skip test generation, note the change

### Step 4 — Generate Test Scenarios
Based on changed files:

**For UI file changes:**
- Identify affected components/pages
- Generate Playwright tests for the modified user flow
- Include regression tests for adjacent unchanged UI

**For API/logic changes:**
- Generate API test scenarios (request/response validation)
- Flag for Postman or Playwright API testing

### Step 5 — Notify User
Send notification via Telegram and web:

```
🧪 QA-Core — New PR Detected

Repo: [owner/repo]
PR #[number]: [title]
Author: [author]
Files changed: [count]

Test generation complete:
✅ [N] Playwright tests generated
📁 Saved to: ./output/pr-[number]/

Key scenarios covered:
- [scenario 1]
- [scenario 2]
- [scenario 3]

⚠️ Manual review needed: [any ambiguous changes]
```

### Step 6 — Save Output
- Save generated tests to `./output/pr-[number]/`
- Update MEMORY.md with PR number and generation summary
- Log: PR number, files changed, tests generated, timestamp

### Step 7 — Stop Watching
User can stop with `/unwatch <owner/repo>`
Confirm: "Stopped watching [owner/repo]."

## Output Files
- `./output/pr-[number]/tests/[affected-feature].spec.ts`
- `./output/pr-[number]/coverage-report.md`

## Error Handling
- Token missing → "GITHUB_TOKEN not found in .env. Add it and retry."
- Repo not found → "Repo [owner/repo] not accessible. Check the name and your token permissions."
- No testable changes → "PR #[N] only contains config/docs changes — no tests generated."
