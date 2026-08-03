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
// cards=false면 인스타 캐러셀용 4:5 카드를 렌더하지 않는다(릴스만 발행할 때 낭비 제거).
export async function renderCandidate(candidateId, cardData, { cards = true } = {}) {
  const outDir = path.join(paths.out, String(candidateId));
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    const cardPaths = [];
    const reelFramePaths = [];

    for (let i = 0; i < cardData.cards.length; i++) {
      if (cards) {
        const cardPath = path.join(outDir, `card-${i + 1}.jpg`);
        await renderOne(context, 'card', cardData, i, cardPath);
        cardPaths.push(cardPath);
      }

      const reelPath = path.join(outDir, `reel-${i + 1}.jpg`);
      await renderOne(context, 'reel', cardData, i, reelPath);
      reelFramePaths.push(reelPath);
    }

    return { cardPaths, reelFramePaths };
  } finally {
    await browser.close();
  }
}

// 나레이션 릴스용 프레임: 훅 1장 + 자막 라인당 1장.
// 라인 = 나레이션 단위 = 자막 = 프레임이 1:1이라 오디오와 자막이 자동으로 싱크된다.
// script = { hook, kicker, lines[] }, bg = 표지 배경 사진 file:// URL (없으면 테마 배경)
// bgs: 배경 사진 file:// URL 배열. 여러 장이면 구간을 나눠 번갈아 쓴다
// (한 장만 쓰면 25초 내내 같은 그림이라 단조롭다).
// transparent=true면 배경을 비우고 투명 PNG로 렌더한다 → 실사 영상 위에 오버레이할 때 사용.
// (스크림/비네트는 반투명으로 남아 영상 위에서도 자막 가독성을 유지한다)
export async function renderReelLines(
  candidateId,
  script,
  { theme = 'navy', bgs = [], account = '', transparent = false } = {}
) {
  const outDir = path.join(paths.out, String(candidateId));
  await mkdir(outDir, { recursive: true });

  // 훅도 나레이션되므로 프레임과 오디오 세그먼트가 1:1이다.
  const frames = [
    { kind: 'hook', text: script.hook, kicker: script.kicker || '' },
    ...script.lines.map((text) => ({ kind: 'line', text })),
  ];

  // 마지막 화면을 저장 유발 지점으로 교체한다. 체크리스트 > 복붙 프롬프트 순으로 우선.
  const last = frames.length - 1;
  if (script.checklist?.items?.length) {
    frames[last] = {
      kind: 'checklist',
      text: script.lines[script.lines.length - 1],
      checklist: script.checklist,
      shareCta: script.shareCta || '',
      prompt: script.prompt || '',
    };
  } else if (script.prompt) {
    frames[last] = {
      kind: 'prompt',
      text: script.lines[script.lines.length - 1],
      prompt: script.prompt,
      shareCta: script.shareCta || '',
    };
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    const out = [];

    // 프레임을 배경 수만큼 블록으로 나눠 배정 (매 프레임 바뀌면 깜빡여 보인다).
    const pool = bgs.filter(Boolean);
    const bgFor = (i) => {
      if (pool.length === 0) return null;
      const block = Math.ceil(frames.length / pool.length);
      return pool[Math.min(pool.length - 1, Math.floor(i / block))];
    };

    for (let i = 0; i < frames.length; i++) {
      const payload = {
        theme,
        bg: transparent ? null : bgFor(i), // 영상 배경이면 사진을 깔지 않는다
        transparent,
        account,
        kind: frames[i].kind,
        text: frames[i].text,
        kicker: frames[i].kicker,
        prompt: frames[i].prompt,
        checklist: frames[i].checklist,
        shareCta: frames[i].shareCta,
        // 진행바는 자막 프레임 기준(훅 제외)으로 계산
        index: Math.max(0, i - 1),
        total: script.lines.length,
      };
      const page = await context.newPage();
      try {
        await page.setViewportSize({ width: 1080, height: 1920 });
        await page.addInitScript(`window.__LINE__ = ${JSON.stringify(payload)}`);
        await page.goto('file://' + path.join(paths.templates, 'reel-line.html'));
        await page.evaluate(() => document.fonts.ready);
        const p = path.join(
          outDir,
          `line-${String(i).padStart(2, '0')}.${transparent ? 'png' : 'jpg'}`
        );
        // omitBackground: 투명 영역을 살려 영상 위에 겹칠 수 있게 (JPEG는 알파를 못 담는다)
        await page.screenshot(
          transparent
            ? { path: p, type: 'png', omitBackground: true }
            : { path: p, type: 'jpeg', quality: 90 }
        );
        out.push(p);
      } finally {
        await page.close();
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}
