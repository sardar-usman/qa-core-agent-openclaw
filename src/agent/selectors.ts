import type { Locator, Page } from '@playwright/test';

/**
 * Selector cascade: role → label → testid → CSS.
 *
 * The agent describes targets in terms of *intent* ("the email field",
 * "the submit button"). This module resolves that intent to a Locator
 * by trying levels in order of robustness and reports which level won
 * so the transcriber can emit the most resilient call.
 */

export type CascadeLevel = 'role' | 'label' | 'testid' | 'css';

export interface ResolvedLocator {
  locator: Locator;
  level: CascadeLevel;
  /** The argument used to construct the winning locator — emitted into the spec. */
  arg: string | { role: string; name: string };
}

export interface ResolveSpec {
  /** Free-form intent (e.g. "username input", "login button"). */
  intent: string;
  /** Optional role hint (e.g. 'textbox', 'button', 'link'). */
  role?: string;
  /** Optional label hint (e.g. "Email", "Password"). */
  label?: string;
  /** Optional testid (e.g. "login-submit"). */
  testid?: string;
  /** Optional CSS fallback. */
  css?: string;
}

const ROLE_PATTERNS: Array<[RegExp, string]> = [
  [/button|submit|sign\s*(in|up)|log\s*(in|out)|continue|next|cancel/i, 'button'],
  [/(check|tick)box/i, 'checkbox'],
  [/radio/i, 'radio'],
  [/select|dropdown|combo/i, 'combobox'],
  [/link|anchor/i, 'link'],
  [/textbox|input|field|email|password|user(name)?/i, 'textbox'],
];

function guessRole(intent: string): string | undefined {
  for (const [re, role] of ROLE_PATTERNS) {
    if (re.test(intent)) return role;
  }
  return undefined;
}

async function exists(locator: Locator): Promise<boolean> {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

/**
 * Try the cascade in order and return the first locator that resolves to
 * exactly one element (preferred) or the first that resolves to any element.
 */
export async function resolve(page: Page, spec: ResolveSpec): Promise<ResolvedLocator | null> {
  const role = spec.role ?? guessRole(spec.intent);
  const name = spec.label ?? spec.intent;

  // 1. role + accessible name
  if (role) {
    const byRole = page.getByRole(role as Parameters<Page['getByRole']>[0], { name });
    if (await exists(byRole)) {
      return { locator: byRole.first(), level: 'role', arg: { role, name } };
    }
  }

  // 2. label
  if (spec.label) {
    const byLabel = page.getByLabel(spec.label);
    if (await exists(byLabel)) {
      return { locator: byLabel.first(), level: 'label', arg: spec.label };
    }
  }
  const byLabelFromIntent = page.getByLabel(spec.intent);
  if (await exists(byLabelFromIntent)) {
    return { locator: byLabelFromIntent.first(), level: 'label', arg: spec.intent };
  }

  // 3. testid
  if (spec.testid) {
    const byTestId = page.getByTestId(spec.testid);
    if (await exists(byTestId)) {
      return { locator: byTestId.first(), level: 'testid', arg: spec.testid };
    }
  }

  // 4. css fallback
  if (spec.css) {
    const byCss = page.locator(spec.css);
    if (await exists(byCss)) {
      return { locator: byCss.first(), level: 'css', arg: spec.css };
    }
  }

  return null;
}

/**
 * Emit a Playwright call expression for the resolved cascade level.
 * Used by the transcriber to write the spec.
 *
 *   role:    page.getByRole('textbox', { name: 'Email' })
 *   label:   page.getByLabel('Email')
 *   testid:  page.getByTestId('login-email')
 *   css:     page.locator('#email')
 */
export function emitLocatorCall(level: CascadeLevel, arg: ResolvedLocator['arg']): string {
  switch (level) {
    case 'role': {
      const a = arg as { role: string; name: string };
      return `page.getByRole(${JSON.stringify(a.role)}, { name: ${JSON.stringify(a.name)} })`;
    }
    case 'label':
      return `page.getByLabel(${JSON.stringify(arg as string)})`;
    case 'testid':
      return `page.getByTestId(${JSON.stringify(arg as string)})`;
    case 'css':
      return `page.locator(${JSON.stringify(arg as string)})`;
  }
}
