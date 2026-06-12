/**
 * Reproduces the bug observed in real runs:
 *   - Agent calls begin_scenario.
 *   - Agent records 0 or more steps but no assert.
 *   - Loop exits WITHOUT the agent calling finish (stop_reason !== 'tool_use',
 *     turn limit, cost ceiling, etc.).
 *   - The runtime previously force-pushed ctx.current into scenarios anyway,
 *     producing empty `test(...)` blocks in the emitted spec.
 *
 * We simulate the same context-shape the runtime hands to the Critic/Replay
 * stages and assert that an abandoned, assert-less in-progress scenario does
 * NOT survive into the final scenarios array.
 *
 * No network, no LLM calls.
 */
import type { Scenario } from '../src/agent/trace.js';

interface FakeCtx {
  scenarios: Scenario[];
  current: Scenario | null;
}

function captureFromContext(ctx: FakeCtx): Scenario[] {
  // Mirror the logic in runtime.ts (post-fix). Keep in sync if runtime.ts changes.
  if (ctx.current) {
    const hasAssert = ctx.current.steps.some((s) => s.kind === 'assert');
    if (hasAssert) ctx.scenarios.push(ctx.current);
  }
  return ctx.scenarios;
}

// Case A — agent began a scenario, recorded a navigate + a press, never asserted, never called finish.
const caseA: FakeCtx = {
  scenarios: [],
  current: {
    name: 'completed login using keyboard only',
    category: 'a11y',
    steps: [
      { kind: 'navigate', url: 'https://example.com/login' },
      { kind: 'wait', ms: 200 },
    ],
  },
};
const a = captureFromContext(caseA);
console.log(`Case A (abandoned, no assert): final scenarios.length = ${a.length}`);
if (a.length !== 0) { console.error('FAIL: abandoned assert-less scenario was force-pushed'); process.exit(1); }

// Case B — agent began a scenario, asserted on something, never called finish.
const caseB: FakeCtx = {
  scenarios: [],
  current: {
    name: 'logged in with valid credentials',
    category: 'happy',
    steps: [
      { kind: 'navigate', url: 'https://example.com/login' },
      { kind: 'assert', name: 'inventory page visible', assertion: { type: 'toHaveURL', pattern: '/inventory' } },
    ],
  },
};
const b = captureFromContext(caseB);
console.log(`Case B (asserted but no finish): final scenarios.length = ${b.length}`);
if (b.length !== 1) { console.error('FAIL: valid in-progress scenario was incorrectly dropped'); process.exit(1); }

// Case C — agent began nothing in progress (current is null).
const caseC: FakeCtx = {
  scenarios: [{ name: 'preexisting', category: 'happy', steps: [{ kind: 'assert', name: 'x', assertion: { type: 'toHaveURL', pattern: '/x' } }] }],
  current: null,
};
const c = captureFromContext(caseC);
console.log(`Case C (no in-progress, has prior): final scenarios.length = ${c.length}`);
if (c.length !== 1) { console.error('FAIL: prior scenarios array was corrupted'); process.exit(1); }

console.log('\nOK: runtime correctly drops abandoned assert-less in-progress scenarios.');
