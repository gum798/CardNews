// 후보 1건 → 카드 카피 → 표지 사진 → 렌더 → 릴스 → R2 업로드 → IG 발행 → 텔레그램 보고.
// 수동 승인(bot-listener)과 자동 발행(hourly-collect)이 공유한다. 실패는 내부에서 잡아 보고.
import {
  getCandidate,
  getNewsItem,
  updateCandidateStatus,
  setCandidateCardJson,
  insertPublish,
} from './db/index.js';
import { writeCards, pickBestImage } from './curator/index.js';
import { searchTopicImages, downloadImage } from './images/index.js';
import { renderCandidate } from './renderer/index.js';
import { makeReel } from './video/index.js';
import { uploadCandidate, uploadFile } from './storage/index.js';
import { checkPublishingLimit, publishCarousel, publishReel } from './publisher/index.js';
import { report } from './bot/index.js';
import { dryRun, topics, paths } from './config.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function generateAndPublish(candidateId, { auto = false } = {}) {
  const tag = auto ? '자동 ' : '';
  try {
    const cand = getCandidate(candidateId);
    if (!cand) throw new Error('후보를 찾을 수 없음');
    updateCandidateStatus(candidateId, 'generating');

    // 1. 카드 데이터: evergreen 후보는 생성 시점에 card_json이 이미 있음 → writeCards 생략.
    let cardData;
    if (cand.card) {
      cardData = cand.card;
    } else {
      const n = getNewsItem(cand.news_item_id);
      cardData = await writeCards({ id: n.id, source: n.source, title: n.title, summary: n.summary, url: n.url });
    }
    cardData.theme = topics[cand.topic]?.theme || 'navy';
    setCandidateCardJson(candidateId, cardData);

    // 1b. 표지 배경 사진: Pixabay 후보 검색 → AI 관련성 선택(1회) → 어울리면 그 1장 다운로드.
    //     어울리는 게 없으면 사진 없이 그래픽 표지로. (전 과정 베스트에포트)
    const cover = cardData.cards.find((c) => c.type === 'cover');
    if (cover && cardData.imageKeywords) {
      const candidates = await searchTopicImages(cardData.imageKeywords);
      if (candidates.length > 0) {
        const idx = await pickBestImage(cover.card.headline, cover.card.category, candidates);
        if (idx >= 0) {
          const outDir = path.join(paths.out, String(candidateId));
          await mkdir(outDir, { recursive: true });
          const bg = await downloadImage(candidates[idx].url, path.join(outDir, 'bg.jpg'));
          if (bg) cover.card.bg = 'file://' + bg;
          console.log(`[pipeline] 표지 사진 선택 idx=${idx}/${candidates.length}`);
        } else {
          console.log('[pipeline] 어울리는 표지 사진 없음 → 그래픽 표지');
        }
      }
    }

    // 2~4. 렌더 → 릴스 → 업로드
    const { cardPaths, reelFramePaths } = await renderCandidate(candidateId, cardData);
    const reelPath = await makeReel(candidateId, reelFramePaths);
    const { cardUrls, reelUrl } = await uploadCandidate(candidateId, { cardPaths, reelPath });
    const coverUrl = await uploadFile(`${candidateId}/cover.jpg`, reelFramePaths[0], 'image/jpeg');
    updateCandidateStatus(candidateId, 'uploaded');

    // 5. IG 발행 (dryRun이면 합성 ID)
    await checkPublishingLimit();
    const carouselId = await publishCarousel(cardUrls, cardData.caption);
    const reelId = await publishReel(reelUrl, coverUrl, cardData.caption);
    insertPublish({ candidateId, igCarouselId: carouselId, igReelId: reelId });
    updateCandidateStatus(candidateId, 'published');

    // 6. 보고
    const lines = [];
    if (dryRun) {
      lines.push(`✅ ${tag}생성 완료 (DRY_RUN — 인스타엔 아직 안 올라감)`);
      lines.push('② Meta 완료 후 실제 자동 발행됩니다. 그전엔 아래를 저장해 수동 업로드 가능.');
    } else {
      lines.push(`✅ ${tag}발행 완료`);
      lines.push(`캐러셀: ${carouselId}`);
      lines.push(`릴스: ${reelId}`);
    }
    lines.push('', '📋 캡션 (복사용):', cardData.caption, '', `🎬 릴스 원본: ${reelUrl}`);
    await report({ text: lines.join('\n'), mediaPaths: cardPaths, videoPath: reelPath });
    console.log(`[pipeline] ${tag}done candidate ${candidateId}${dryRun ? ' (DRY_RUN)' : ''}`);
    return { ok: true, carouselId, reelId };
  } catch (err) {
    updateCandidateStatus(candidateId, 'failed');
    insertPublish({ candidateId, error: err.message });
    await report({ text: `❌ ${tag}발행 실패 (후보 ${candidateId})\n${err.message}` }).catch(() => {});
    console.error(`[pipeline] failed ${candidateId}:`, err);
    return { ok: false, error: err.message };
  }
}
