/**
 * Assertion-target policy for semantic state.
 *
 * The rule, from the build spec: when an element exposes a semantic ARIA
 * value/state attribute, the assertion MUST target that attribute, not the
 * displayed text. The attribute is the value the widget exposes to assistive
 * tech. It does not depend on display formatting (a progress bar can render
 * "100%" while exposing aria-valuenow="100", and the text node may lag or be
 * styled away entirely). Text is a fallback only when no semantic attribute
 * exists.
 *
 * This module is pure — no browser, no LLM. The Explorer reads the live
 * attribute values off the element, then asks chooseStateAssertion what to
 * record. That keeps the decision deterministic and unit-testable.
 */

/**
 * Semantic state attributes, in priority order. aria-valuenow comes first
 * because value widgets (progress bars, sliders, spinbuttons) are the main
 * case this exists to fix. The rest cover toggles, disclosure widgets, and
 * selectable rows.
 */
export const SEMANTIC_STATE_ATTRS = [
  'aria-valuenow',
  'aria-checked',
  'aria-selected',
  'aria-expanded',
  'aria-pressed',
] as const;

export type SemanticStateAttr = (typeof SEMANTIC_STATE_ATTRS)[number];

export interface StateAssertionChoice {
  /** 'attribute' when a semantic state attribute is present, else 'text'. */
  kind: 'attribute' | 'text';
  /** Set when kind === 'attribute' — the attribute name to assert. */
  attribute?: string;
  /** Set when kind === 'attribute' — the value read off the element. */
  value?: string;
  /** Set when kind === 'text' — the fallback text to assert. */
  text?: string;
}

/** True when a raw attribute reading is present (not null/undefined/blank). */
function present(v: string | null | undefined): v is string {
  return v != null && String(v).trim() !== '';
}

/**
 * Decide what an end-state assertion should target for an element, given the
 * attributes read off it and the text the Explorer would otherwise assert.
 *
 * Returns an attribute choice when any semantic state attribute is present;
 * otherwise falls back to text.
 */
export function chooseStateAssertion(
  attrs: Record<string, string | null | undefined>,
  fallbackText: string,
): StateAssertionChoice {
  for (const name of SEMANTIC_STATE_ATTRS) {
    const v = attrs[name];
    if (present(v)) {
      return { kind: 'attribute', attribute: name, value: String(v).trim() };
    }
  }
  return { kind: 'text', text: fallbackText };
}

/** aria-valuenow exposes a numeric range — assert it stays strictly inside it. */
export const VALUE_NOW_ATTR = 'aria-valuenow';
export const VALUE_MIN_ATTR = 'aria-valuemin';
export const VALUE_MAX_ATTR = 'aria-valuemax';
