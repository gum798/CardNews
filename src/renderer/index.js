// HTML 템플릿 → JPEG. Playwright chromium으로 카드(4:5)와 릴스 프레임(9:16)을 캡처.
// scripts/render-preview.mjs의 검증된 렌더 로직을 파이프라인 API로 적응.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config.js';

const SIZES = {
  card: { file: 'card.html', width: 1080, height: 1350 },
  reel: { file: 'reel.html', width: 1080, height: 1920 },
};

// 카드 하나를 지정 종류(card/reel)로 렌더링 → out 경로 반환.
// addInitScript 페이로드가 누적되지 않도록 렌더마다 새 페이지를 쓴다.
async function renderOne(context, kind, cardData, index, outPath) {
  const { file, width, height } = SIZES[kind];
  const entry = cardData.cards[index];
  const payload = {
    theme: cardData.theme || 'navy',
    type: entry.type,
    page: index + 1,
    totalPages: cardData.cards.length,
    data: { account: cardData.account, date: cardData.date, source: cardData.source, card: entry.card },
  };

  const page = await context.newPage();
  try {
    await page.setViewportSize({ width, height });
    await page.addInitScript(`window.__CARD__ = ${JSON.stringify(payload)}`);
    await page.goto('file://' + path.join(paths.templates, file));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: outPath, type: 'jpeg', quality: 90 });
  } finally {
    await page.close();
  }
}

// candidate의 카드 데이터를 카드 JPEG + 릴스 프레임 JPEG로 렌더링.
// cardData = { account, date, source, cards, caption } (curator.writeCards 반환값).
export async function renderCandidate(candidateId, cardData) {
  const outDir = path.join(paths.out, String(candidateId));
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    const cardPaths = [];
    const reelFramePaths = [];

    for (let i = 0; i < cardData.cards.length; i++) {
      const cardPath = path.join(outDir, `card-${i + 1}.jpg`);
      await renderOne(context, 'card', cardData, i, cardPath);
      cardPaths.push(cardPath);

      const reelPath = path.join(outDir, `reel-${i + 1}.jpg`);
      await renderOne(context, 'reel', cardData, i, reelPath);
      reelFramePaths.push(reelPath);
    }

    return { cardPaths, reelFramePaths };
  } finally {
    await browser.close();
  }
}
