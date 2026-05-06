# Skill: generate-tests
# Command: /generate <user story or acceptance criteria>
# Trigger: User sends "/generate As a user I want to log in so that I can access my dashboard"

## Purpose
Convert a user story, acceptance criteria, or Jira ticket text into structured test scenarios and production-ready Playwright test code.

## Step-by-Step Execution

### Step 1 — Parse the Input
- Extract the user story text
- Identify: Actor, Action, Goal
- Check for acceptance criteria (Given/When/Then or bullet points)
- If no acceptance criteria found → ask: "I have the user story. Do you have acceptance criteria to add? If not, I'll derive scenarios from the story — reply 'proceed' to continue."

### Step 2 — Derive Test Scenarios
Break down into scenarios covering:

**Happy Path (must have)**
- Primary success flow exactly as described in the story

**Negative Scenarios (must have — minimum 2)**
- Invalid inputs
- Missing required fields
- Unauthorized access attempts
- Boundary violations

**Edge Cases (include where applicable)**
- Empty states
- Maximum input lengths
- Special characters
- Concurrent actions

Format each scenario as:
```
Scenario: [descriptive name]
Given: [precondition]
When: [action]
Then: [expected result]
Type: [happy/negative/edge]
Priority: [high/medium/low]
```

### Step 3 — Confirm Scenarios with User
List all derived scenarios and ask:
"I've identified [N] test scenarios. Does this look right, or should I add/remove anything? Reply 'generate' to proceed with code generation."

### Step 4 — Generate Test Code
For each confirmed scenario, write Playwright test code:

```typescript
// tests/[featureName].spec.ts
import { test, expect } from '@playwright/test';

test.describe('[Feature Name] — [User Story ID if provided]', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('[relevant URL]');
  });

  // Happy path
  test('should [expected outcome] when [action]', async ({ page }) => {
    // arrange
    // act  
    // assert
    await expect(page.[locator]).toBeVisible();
  });

  // Negative scenarios
  test('should show error when [invalid condition]', async ({ page }) => {
    // arrange
    // act
    // assert
    await expect(page.[errorLocator]).toContainText('[error message]');
  });

});
```

### Step 5 — Report Output
Tell the user:
- Total scenarios generated
- Breakdown by type (happy/negative/edge)
- Files saved to ./output/
- Note any assumptions made (e.g., "I assumed the login URL is /login — update in the test file if different")

## Output Files
- `./output/scenarios/[featureName]-scenarios.md` (human-readable scenario list)
- `./output/tests/[featureName].spec.ts` (Playwright test code)

## Handling Vague Stories
If the story is too vague (e.g., "As a user I want a good experience"):
- Do not proceed with guessing
- Ask: "This story is too broad for me to generate accurate tests. Can you give me one specific feature or acceptance criterion to start with?"
