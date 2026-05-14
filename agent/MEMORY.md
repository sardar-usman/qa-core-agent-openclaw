# MEMORY.md — QA-Core

## Persistent context

### Project defaults

- Test framework: Playwright
- Output language: TypeScript by default; `--lang js` for JavaScript
- Test pattern: Page Object Model when 3+ tests share a target
- Output directory: `./output/<run-id>/`
- Auth strategy: storage-state via `tests/auth.setup.ts`

### Session log

_This file is updated automatically as QA-Core learns about your project._

### Site fingerprints

_Cached element maps and auth strategies per origin. Speeds up repeat runs against the same target._

### Team preferences

_Added as you give QA-Core feedback on generated tests (e.g., "prefer getByText over getByRole for this codebase")._

### Notes

- QA-Core does not retain memory between OpenClaw sessions by default
- Add project-specific context here manually for consistent behavior across sessions
- Example entry: "Project: MyApp — uses `data-qa-*` attributes, prefers describe/it structure, no POM needed"
