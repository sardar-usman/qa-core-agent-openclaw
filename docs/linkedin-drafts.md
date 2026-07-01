# LinkedIn drafts for QA-Core

Three publish-ready posts. Drop into LinkedIn one per week, in the order below. Edit anything in `{braces}` to match your numbers and links.

Each post follows the same pattern: hook in line 1, specific claim, code or table evidence, soft CTA at the end.

---

## Post 1 — The intro. Publish first.

**Subject line guess (LinkedIn cuts the preview at ~150 chars):** "Most AI test generators dump the DOM into an LLM and pray. I built one that doesn't."

```
Most AI test generators dump the DOM into an LLM and pray.

I built one that doesn't.

QA-Core is an autonomous QA agent that drives a real browser through your app, reviews its own work, and writes Playwright suites that have already passed once before they reach your repo.

Under the hood it runs a three-agent pipeline on Claude:

  • Planner (Haiku 4.5) takes one DOM snapshot, lists the scenarios to cover
  • Explorer (Opus 4.7) drives Playwright live, action by action, verifying every step against the real page
  • Critic (Sonnet 4.6) reviews the recorded trace and grades each scenario ship, weak, or fix

Plus a Healer that re-resolves broken selectors when the page changes later, and per-host memory that makes repeat runs cheaper.

The interesting bit isn't the model choice. It's that every action in the generated spec has already executed against the real page before the file is written. No hallucinated selectors. No tests that look right but never run.

I just ran the benchmark across 3 public sites: 12 of 19 tests passed on first run, total cost $0.77, total time 5 minutes 38 seconds.

Code is open source. Link in comments.

#QA #SDET #AutomationTesting #Playwright #AI #AgenticAI #Claude #SoftwareTesting
```

**Attach:** the 90-second overview Loom video.

**First comment (post it yourself right after publishing):** "Repo: https://github.com/sardarusmanjutt/qa-core-agent — happy to walk through the architecture if you're curious how the tool-use loop works."

---

## Post 2 — The POM framework. Publish ~4 days later.

**Subject line guess:** "AI test generators ship a single .spec.ts. Mine ships a framework."

```
Most AI test generators ship a single .spec.ts file with locators copy-pasted inline across every test.

That isn't a framework. It's a code dump.

QA-Core emits a real Playwright Page Object Model framework by default. Same agent, same trace, but the output is structured the way a senior QA engineer would actually write it:

  output/<run-id>/
    pages/
      BasePage.ts
      LoginPage.ts        ← typed Locator fields + action methods
    tests/
      login.spec.ts       ← clean, reads like a human wrote it
    a11y/
      landing.a11y.spec.ts ← auto-injected WCAG check
    run-report.json

The generated LoginPage.ts looks like this (excerpt):

  export class LoginPage extends BasePage {
    readonly url = 'https://www.saucedemo.com/';
    readonly username: Locator;
    readonly password: Locator;
    readonly loginButton: Locator;

    constructor(page: Page) {
      super(page);
      this.username    = page.getByRole('textbox', { name: 'Username' });
      this.password    = page.getByRole('textbox', { name: 'Password' });
      this.loginButton = page.getByRole('button',  { name: 'Login' });
    }

    async loginAs(username: string, password: string): Promise<void> {
      await this.username.fill(username);
      await this.password.fill(password);
      await this.loginButton.click();
    }
  }

The loginAs() method wasn't written by hand. The emitter detected that 4 of 5 scenarios start with the same fill + fill + click sequence and synthesized the action method automatically.

The spec then reads like this:

  test('[happy] logged in with valid credentials', async ({ page }) => {
    await loginPage.loginAs('standard_user', 'secret_sauce');
    await expect(page).toHaveURL(/inventory/);
  });

If you're a QA Lead, this is the difference between code your team adopts and code they delete.

Comment "POM" and I'll DM you the repo.

#QA #SDET #Playwright #PageObjectModel #AutomationTesting #AI #SoftwareEngineering
```

**Attach:** a screenshot of the generated LoginPage.ts (open it in VS Code with the QA-Core terminal output beside it, take a screenshot, brand-coloured background optional).

---

## Post 3 — The technical insight. Publish ~4 days after Post 2.

**Subject line guess:** "I doubled my agent's pass-rate. I didn't change the model."

```
I doubled my agent's pass-rate without changing the model.

I didn't change the prompts either. Or the temperature. Or which sites I tested.

Same agent. Same trace. Same Claude version. The only change was the code emission target.

Before — inline emission, one .spec.ts per run:

| Site         | Pass-rate |
| ------------ | --------: |
| saucedemo    |       50% |
| the-internet |       29% |
| TodoMVC      |       17% |
| Aggregate    | 6/19 = 32%|

After — Page Object Model emission:

| Site         | Pass-rate |
| ------------ | --------: |
| saucedemo    |       83% |
| the-internet |       43% |
| TodoMVC      |       67% |
| Aggregate    |12/19 = 63%|

Same browser session, replayed through a different code emitter. Pass-rate went from 32 to 63 percent.

Here's the why. With inline emission, every test was free to pick a different selector for the same element. One test used getByRole, another used a CSS class, a third used data-testid. That kind of inconsistency turns into flake the moment the page renders one of those elements differently.

With POM emission, every locator lives as one typed Locator field on a class. Every test uses the exact same selector. Inconsistency removed. Flake collapsed.

The lesson for anyone building AI agents: the emission target matters as much as the model. The cleverest planning is wasted if the output code architecture amplifies brittleness.

Open source, link in comments.

#QA #SDET #Playwright #AI #AgenticAI #SoftwareEngineering #AutomationTesting #Claude
```

**Attach:** a screenshot of the before-vs-after table from your README.

**First comment:** "Repo: https://github.com/sardarusmanjutt/qa-core-agent — the POM emitter is in src/agent/pom.ts if you want to see how the action methods get synthesized."

---

## Rollout cadence

| When | Post | Purpose |
|---|---|---|
| Day 0 | Post 1 (overview) | Establish what QA-Core is. Maximum reach. |
| Day 4 | Post 2 (POM framework) | Show the differentiator most AI test tools miss. |
| Day 8 | Post 3 (the 32 to 63 jump) | Show technical depth. Most engagement from senior engineers. |
| Day 12+ | Reply to comments, share to relevant Slack/Discord groups | Compound momentum. |

## What to do before posting

- Replace `{github.com/sardarusmanjutt/qa-core-agent}` with your actual repo URL once you push it
- Record the 90-second Loom for Post 1
- Take a clean screenshot of LoginPage.ts (VS Code, dark theme) for Post 2
- Take a screenshot of the before-vs-after table from README for Post 3
- Schedule them (or post manually) using LinkedIn's scheduling tool

## What to do after posting

- First 90 minutes are critical for LinkedIn algorithm. Reply to every comment.
- Tag relevant people in the comments, NOT the post body (post tags often suppress reach).
- Share each post to: any QA Slack/Discord you're in, your WhatsApp tech groups, and the Anthropic dev community if you're a member.

## Tone notes for any follow-up posts

- Lead with a specific claim. "I built X" beats "Excited to announce X."
- Show numbers. Specific numbers beat round numbers.
- Show code. Real code beats descriptions of code.
- Avoid: "thrilled," "honoured," "game-changer," "revolutionary," "AI-powered solution."
- Use: actual measurements, actual file paths, actual test outcomes.
