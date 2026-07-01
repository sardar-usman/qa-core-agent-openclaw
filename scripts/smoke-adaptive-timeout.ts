/**
 * Locks the adaptive end-state timeout (adaptive-timeout.ts) — pure function,
 * zero browser, zero LLM.
 *
 * The contract:
 *   - timeout = observed × 1.5, clamped to [5000, 60000]
 *   - the number is derived from the observation, never a fixed constant
 *   - zero / negative / non-finite observations collapse to the floor
 *   - monotonic non-decreasing in the observed duration
 */
import {
  adaptiveTimeout,
  ADAPTIVE_FLOOR_MS,
  ADAPTIVE_CEILING_MS,
  ADAPTIVE_MARGIN,
} from '../src/agent/adaptive-timeout.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── bounds constants ───────────────────────────────────────────────────── */
check('A. floor is 5000ms', ADAPTIVE_FLOOR_MS === 5000);
check('B. ceiling is 60000ms', ADAPTIVE_CEILING_MS === 60000);
check('C. margin is 1.5 (observed + 50 percent)', ADAPTIVE_MARGIN === 1.5);

/* ─── floor behaviour ────────────────────────────────────────────────────── */
check('D. observed 0 collapses to the floor', adaptiveTimeout(0) === 5000);
check('E. negative observed collapses to the floor', adaptiveTimeout(-1000) === 5000);
check('F. NaN observed collapses to the floor', adaptiveTimeout(Number.NaN) === 5000);
check('G. Infinity observed collapses to the floor', adaptiveTimeout(Number.POSITIVE_INFINITY) === 5000);
check('H. small observed (1000) still floored to 5000', adaptiveTimeout(1000) === 5000);
check('I. observed just below the floor boundary stays at floor', adaptiveTimeout(3000) === 5000);

/* ─── the margin actually applies (number comes from the page) ───────────── */
// 4000 × 1.5 = 6000, inside the band → not a constant, tracks the observation.
check('J. observed 4000 → 6000 (×1.5, above floor)', adaptiveTimeout(4000) === 6000);
check('K. observed 10000 → 15000', adaptiveTimeout(10000) === 15000);
check('L. observed 20000 → 30000', adaptiveTimeout(20000) === 30000);
check('M. observed 3334 → 5001 (just past the floor, proves it is not pinned)', adaptiveTimeout(3334) === 5001);

/* ─── ceiling behaviour ──────────────────────────────────────────────────── */
check('N. observed 40000 → 60000 (exactly the ceiling)', adaptiveTimeout(40000) === 60000);
check('O. observed 50000 clamped to 60000', adaptiveTimeout(50000) === 60000);
check('P. observed 1000000 clamped to 60000', adaptiveTimeout(1_000_000) === 60000);

/* ─── derived, not constant: distinct observations inside the band differ ── */
check('Q. distinct in-band observations produce distinct timeouts',
  adaptiveTimeout(4000) !== adaptiveTimeout(10000) && adaptiveTimeout(10000) !== adaptiveTimeout(20000));

/* ─── monotonic non-decreasing ───────────────────────────────────────────── */
let monotonic = true;
let prev = -1;
for (let obs = 0; obs <= 70000; obs += 1000) {
  const t = adaptiveTimeout(obs);
  if (t < prev) { monotonic = false; break; }
  prev = t;
}
check('R. adaptiveTimeout is monotonic non-decreasing across 0..70000ms', monotonic);

/* ─── rounding (no fractional ms leaks through) ──────────────────────────── */
check('S. result is always an integer', Number.isInteger(adaptiveTimeout(7777)));
check('T. observed 7777 → round(11665.5)=11666', adaptiveTimeout(7777) === 11666);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: adaptiveTimeout derives the budget from the observed duration, clamped to [5000, 60000].');
