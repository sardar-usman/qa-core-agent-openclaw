import type { Page } from '@playwright/test';
import { resolve, type ResolvedLocator } from './selectors.js';

/**
 * In-run selector recovery used by the Explorer (tools.ts). This is NOT the
 * healer: healing an existing spec is done by the published qa-core-heal
 * package (see src/cli/heal.ts). Recovery repairs a selector that failed to
 * resolve DURING exploration, before any spec exists. Deterministic: no
 * model call.
 */

/** The selector hints the model gives when asking for an element. */
export type ResolveInput = { intent: string; role?: string; label?: string; testid?: string; css?: string; text?: string };

/**
 * Re-resolve a failed selector against the live page using the SAME locator
 * ladder, but by the semantic intent only (the brittle hint that failed is
 * dropped). Polls briefly so a slow element still gets a second chance. Returns
 * the recovered locator, or null when the element truly is not there.
 */
export async function recoverResolve(
  page: Page,
  input: ResolveInput,
): Promise<ResolvedLocator | null> {
  const relaxed: ResolveInput = { intent: input.intent };
  let r = await resolve(page, relaxed);
  for (let i = 0; i < 3 && !r; i++) {
    await new Promise((res) => setTimeout(res, 200));
    r = await resolve(page, relaxed);
  }
  return r;
}
