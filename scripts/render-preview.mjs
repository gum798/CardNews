import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'out', 'preview');
mkdirSync(outDir, { recursive: true });

const sample = JSON.parse(readFileSync(path.join(root, 'templates', 'sample-data.json'), 'utf-8'));
const THEMES = ['light', 'dark', 'navy'];

const SIZES = {
  card: { file: 'card.html', width: 1080, height: 1350 },
  reel: { file: 'reel.html', width: 1080, height: 1920 },
};

async function render(page, kind, theme, cardIndex) {
  const { file, width, height } = SIZES[kind];
  const entry = sample.cards[cardIndex];
  const payload = {
    theme,
    type: entry.type,
    page: cardIndex + 1,
    totalPages: sample.cards.length,
    data: { account: sample.account, date: sample.date, source: sample.source, card: entry.card },
  };

  await page.setViewportSize({ width, height });
  await page.addInitScript(`window.__CARD__ = ${JSON.stringify(payload)}`);
  await page.goto('file://' + path.join(root, 'templates', file));
  await page.evaluate(() => document.fonts.ready);

  const out = path.join(outDir, `${kind}-${theme}-${cardIndex + 1}-${entry.type}.jpg`);
  await page.screenshot({ path: out, type: 'jpeg', quality: 90 });
  console.log('rendered', path.relative(root, out));
}

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1 });

for (const theme of THEMES) {
  // fresh page per theme so addInitScript payloads don't stack
  for (let i = 0; i < sample.cards.length; i++) {
    const page = await context.newPage();
    await render(page, 'card', theme, i);
    await page.close();
  }
  const page = await context.newPage();
  await render(page, 'reel', theme, 0);
  await page.close();
}

await browser.close();
console.log('done →', path.relative(root, outDir));
