/**
 * Adaptive end-state timeout.
 *
 * Async assertions (toBeVisible, toHaveText, toContainText, toHaveAttribute,
 * wait_for_text) should wait no longer than the operation actually needs.
 * During the Explorer stage we measure how long the page took to reach the
 * target state, from the triggering action to the moment the target state was
 * read. We then budget that observed duration plus a 50 percent safety margin.
 *
 * The number always comes from the page at run time, never a hardcoded
 * constant. The only constants here are the bounds:
 *
 *   floor   5000 ms  — never flake on a fast but jittery operation
 *   ceiling 60000 ms — never hang a whole suite on a runaway operation
 *
 * Replay and stability honor the recorded per-assertion timeout, so a value
 * measured once during exploration is reused on every later run.
 */

export const ADAPTIVE_FLOOR_MS = 5_000;
export const ADAPTIVE_CEILING_MS = 60_000;
export const ADAPTIVE_MARGIN = 1.5;

/**
 * Turn an observed settle duration (action to target-state-reached, in ms)
 * into a stable assertion timeout: observed plus 50 percent, clamped to the
 * 5000 ms floor and 60000 ms ceiling.
 *
 * A zero, negative, or non-finite observation collapses to the floor — the
 * state was already present, so the floor is the right minimum budget.
 */
export function adaptiveTimeout(observedMs: number): number {
  const safe = Number.isFinite(observedMs) && observedMs > 0 ? observedMs : 0;
  const budget = Math.round(safe * ADAPTIVE_MARGIN);
  return Math.min(ADAPTIVE_CEILING_MS, Math.max(ADAPTIVE_FLOOR_MS, budget));
}
