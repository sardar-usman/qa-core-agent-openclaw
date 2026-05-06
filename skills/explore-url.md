# Skill: explore-url
# Command: /explore <url>
# Trigger: User sends "/explore https://example.com"

## Purpose
Open a URL, map all testable UI elements, and generate a complete Playwright test suite.

## Step-by-Step Execution

### Step 1 — Confirm Input
- Extract the URL from the command
- Confirm back to the user: "Exploring [URL] — I'll map the UI and generate Playwright tests. Give me a moment."

### Step 2 — Open and Explore the Page
Using Playwright headless browser:
- Navigate to the URL
- Wait for page to fully load (networkidle)
- Take a screenshot for reference
- Extract all interactive elements:
  - Input fields (type, placeholder, name, id)
  - Buttons (text, aria-label, role)
  - Links (text, href)
  - Forms (action, method, fields)
  - Dropdowns / selects
  - Modals / dialogs (if present)
  - Navigation items

### Step 3 — Build Element Inventory
Organize findings into a structured map:
```
Page: [URL]
Title: [page title]
Elements:
  - [element type]: [selector] — [description]
  - ...
User Flows Identified:
  - [flow name]: [steps]
  - ...
```

### Step 4 — Identify Test Scenarios
For each user flow, identify:
- Happy path scenario
- At least 2 negative/edge case scenarios
- Boundary conditions (empty inputs, max length, invalid formats)

### Step 5 — Generate Page Object Model
Create a Page Object class:
```typescript
// pages/[PageName].page.ts
import { Page, Locator } from '@playwright/test';

export class [PageName]Page {
  readonly page: Page;
  // locators for each element
  
  constructor(page: Page) {
    this.page = page;
    // initialize locators
  }
  
  // action methods
}
```

### Step 6 — Generate Test File
Create a `.spec.ts` file:
```typescript
// tests/[pageName].spec.ts
import { test, expect } from '@playwright/test';
import { [PageName]Page } from '../pages/[PageName].page';

test.describe('[Page/Feature Name]', () => {
  // happy path tests
  // negative tests
  // edge case tests
});
```

### Step 7 — Report Output
Tell the user:
- How many elements were found
- How many test scenarios were generated
- How many test files were created
- Where the files are saved (./output/)
- Any warnings (e.g., "No form found — skipped form validation tests")

## Output Files
- `./output/pages/[PageName].page.ts`
- `./output/tests/[pageName].spec.ts`
- `./output/element-map.md` (human-readable element inventory)
