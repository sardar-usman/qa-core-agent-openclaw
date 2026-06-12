import type { BrowserContext, Page } from 'playwright';

/**
 * tsx / esbuild emits `__name(fn, "name")` calls inside arrow & function
 * bodies as a stack-trace fidelity helper (keepNames). The helper is
 * defined at module scope when the TypeScript file is compiled, but it does
 * NOT travel with the function when Playwright serializes it across to the
 * browser via `page.evaluate(fn)`. Result: `ReferenceError: __name is not
 * defined` from inside the page context.
 *
 * The robust fix is to define a no-op shim on the browser-side global object
 * before any page.evaluate body runs. `addInitScript` is called on every
 * new document for the context, so this survives navigation and works for
 * all current and future page.evaluate calls.
 */
const SHIM_SOURCE = `
(() => {
  if (typeof globalThis.__name === 'function') return;
  globalThis.__name = function(fn, name) {
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (_) { /* ignore */ }
    return fn;
  };
})();
`;

export async function installEvalShim(target: BrowserContext | Page): Promise<void> {
  // Both Page and BrowserContext expose addInitScript with the same shape.
  await target.addInitScript({ content: SHIM_SOURCE });
}
