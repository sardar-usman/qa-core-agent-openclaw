import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const htmlPath = path.resolve(process.cwd(), 'docs/qa-core-features-report.html');
const pdfPath = path.resolve(process.cwd(), 'docs/qa-core-features-report.pdf');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  });
} finally {
  await browser.close();
}

console.log(pdfPath);
