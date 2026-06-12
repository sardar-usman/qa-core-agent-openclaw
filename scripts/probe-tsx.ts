/**
 * Probe what tsx does to inner functions inside a page.evaluate body.
 * We use page.evaluate(fn) directly so we can see the .toString() of the
 * compiled function and find the __name reference site.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.setContent('<html><body><h1>x</h1></body></html>', { waitUntil: 'load' });

const fnDecl = () => {
  function pick(_el: Element): { tag: string } {
    return { tag: 'span' };
  }
  return { v: pick(document.body) };
};

const fnArrow = () => {
  const pick = (_el: Element): { tag: string } => ({ tag: 'span' });
  return { v: pick(document.body) };
};

console.log('--- fnDecl source as seen by tsx ---');
console.log(fnDecl.toString());
console.log('--- fnArrow source as seen by tsx ---');
console.log(fnArrow.toString());

try {
  const a = await page.evaluate(fnDecl);
  console.log('decl OK:', a);
} catch (e) {
  console.log('decl FAIL:', (e as Error).message.split('\n')[0]);
}
try {
  const b = await page.evaluate(fnArrow);
  console.log('arrow OK:', b);
} catch (e) {
  console.log('arrow FAIL:', (e as Error).message.split('\n')[0]);
}

await browser.close();
