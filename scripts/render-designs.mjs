import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'out', 'designs');
mkdirSync(outDir, { recursive: true });

const NAMES = {
  1: '에디토리얼-라이트', 2: '다크모드', 3: '브레이킹-레드', 4: '컬러블록-상단',
  5: '좌측-액센트바', 6: '하이라이트-마커', 7: '그라디언트', 8: '빅넘버-데이터',
  9: '네이비-프리미엄', 10: '볼드-타이포',
};

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1 });

for (let n = 1; n <= 10; n++) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1080, height: 1350 });
  await page.addInitScript(`window.__DESIGN__ = { variant: ${n} }`);
  await page.goto('file://' + path.join(root, 'templates', 'designs.html'));
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(outDir, `design-${String(n).padStart(2, '0')}-${NAMES[n]}.jpg`);
  await page.screenshot({ path: out, type: 'jpeg', quality: 92 });
  await page.close();
  console.log('rendered', path.basename(out));
}

await browser.close();
console.log('done →', path.relative(root, outDir));
