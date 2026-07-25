import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'out', 'profile');
mkdirSync(outDir, { recursive: true });

const VARIANTS = ['solid', 'badge', 'bite', 'light'];

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1 });

for (const variant of VARIANTS) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1080, height: 1080 });
  await page.addInitScript(`window.__PROFILE__ = ${JSON.stringify(variant)}`);
  await page.goto('file://' + path.join(root, 'templates', 'profile.html'));
  await page.evaluate(() => document.fonts.ready);
  const square = path.join(outDir, `profile-${variant}.png`);
  await page.screenshot({ path: square, type: 'png' });
  await page.close();

  // circle preview: how it looks cropped in the IG app
  // (about:blank pages can't load file:// images — inline as data URI)
  const dataUri = `data:image/png;base64,${readFileSync(square).toString('base64')}`;
  const preview = await context.newPage();
  await preview.setViewportSize({ width: 600, height: 600 });
  await preview.setContent(`
    <body style="margin:0;width:600px;height:600px;background:#1a1a1a;display:flex;align-items:center;justify-content:center">
      <img src="${dataUri}" style="width:480px;height:480px;border-radius:50%">
    </body>`);
  await preview.evaluate(() => new Promise(r => {
    const img = document.querySelector('img');
    img.complete ? r() : (img.onload = r);
  }));
  await preview.screenshot({ path: path.join(outDir, `preview-${variant}.jpg`), type: 'jpeg', quality: 90 });
  await preview.close();
  console.log('rendered', variant);
}

await browser.close();
console.log('done →', path.relative(root, outDir));
