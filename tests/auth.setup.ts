import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Auth setup using Playwright storage state.
 *
 * The agent never logs in inside individual tests; it relies on a single
 * authenticated browser state captured here and reused via `storageState`.
 *
 * QA_CORE_AUTH_URL / QA_CORE_AUTH_USER / QA_CORE_AUTH_PASS control the run.
 * If those vars are missing, the setup is skipped — tests that don't need
 * auth still run; tests that do skip cleanly.
 */

const AUTH_DIR = path.join(process.cwd(), 'playwright', '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'user.json');

setup('authenticate', async ({ page }) => {
  const url = process.env.QA_CORE_AUTH_URL;
  const user = process.env.QA_CORE_AUTH_USER;
  const pass = process.env.QA_CORE_AUTH_PASS;

  if (!url || !user || !pass) {
    setup.skip(true, 'QA_CORE_AUTH_* not configured — skipping auth setup');
    return;
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  await page.goto(url);

  // Use role-based selectors first; fall back to common labels.
  const userField = page.getByRole('textbox', { name: /user|email/i }).first();
  const passField = page.getByRole('textbox', { name: /pass/i }).first();
  const submitBtn = page.getByRole('button', { name: /log ?in|sign ?in/i }).first();

  await userField.fill(user);
  await passField.fill(pass);
  await submitBtn.click();

  // Wait for any post-login navigation/state.
  await page.waitForLoadState('networkidle');
  await expect(page).not.toHaveURL(url);

  await page.context().storageState({ path: AUTH_FILE });
});
