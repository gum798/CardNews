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
import { uploadShort } from './youtube/index.js';
import { report } from './bot/index.js';
import { dryRun, topics, paths, instagram } from './config.js';
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

    // 5. IG 발행 (베스트에포트 — 토큰 없거나 실패해도 유튜브는 계속). dryRun이면 합성 ID.
    let carouselId = null;
    let reelId = null;
    if (dryRun || instagram.accessToken) {
      try {
        await checkPublishingLimit();
        carouselId = await publishCarousel(cardUrls, cardData.caption);
        reelId = await publishReel(reelUrl, coverUrl, cardData.caption);
      } catch (e) {
        console.error('[pipeline] IG 발행 실패(유튜브는 계속):', e.message);
      }
    } else {
      console.log('[pipeline] IG 미설정 → 건너뜀 (유튜브만 발행)');
    }

    // 5b. 유튜브 쇼츠 업로드 (베스트에포트, 병렬 채널)
    const ytId = await uploadShort({
      videoPath: reelPath,
      title: cover?.card?.headline || '오늘의 뉴스',
      description: cardData.caption,
      tags: ['뉴스', '오늘의뉴스', '쇼츠', 'shorts'],
      categoryId: topics[cand.topic]?.ytCategory,
    });

    if (!carouselId && !reelId && !ytId) throw new Error('IG·유튜브 모두 발행 실패');
    insertPublish({ candidateId, igCarouselId: carouselId, igReelId: reelId });
    updateCandidateStatus(candidateId, 'published');

    // 6. 보고
    const lines = [];
    if (dryRun) {
      lines.push(`✅ ${tag}생성 완료 (DRY_RUN — 실제 게시 안 함)`);
    } else {
      lines.push(`✅ ${tag}발행 완료`);
      if (carouselId) lines.push(`📷 인스타 캐러셀: ${carouselId}`);
      if (reelId) lines.push(`🎬 인스타 릴스: ${reelId}`);
      if (ytId) {
        lines.push(`📺 유튜브: https://youtu.be/${ytId}`);
        lines.push(`⚙️ Studio 관리: https://studio.youtube.com/video/${ytId}/edit`);
      }
      if (!carouselId && !reelId) lines.push('ℹ️ 인스타 미설정 — 유튜브만 발행됨');
    }
    lines.push('', '📋 캡션 (복사용):', cardData.caption, '', `🎬 릴스 원본: ${reelUrl}`);
    // 보고는 베스트에포트: 이미 발행(YouTube 등)이 끝난 뒤라 텔레그램 실패가 발행 상태를 'failed'로
    // 뒤집으면 안 된다(뒤집히면 다음 정시 재시도에서 중복 업로드 발생). 미디어 전송이 끊기면 텍스트만이라도.
    try {
      await report({ text: lines.join('\n'), mediaPaths: cardPaths, videoPath: reelPath });
    } catch (e) {
      console.error('[pipeline] 텔레그램 미디어 보고 실패 → 텍스트만 재시도:', e.message);
      await report({ text: lines.join('\n') }).catch((e2) =>
        console.error('[pipeline] 텔레그램 텍스트 보고도 실패(발행은 성공):', e2.message)
      );
    }
    console.log(`[pipeline] ${tag}done candidate ${candidateId}${dryRun ? ' (DRY_RUN)' : ''}`);
    return { ok: true, carouselId, reelId, ytId };
  } catch (err) {
    updateCandidateStatus(candidateId, 'failed');
    insertPublish({ candidateId, error: err.message });
    await report({ text: `❌ ${tag}발행 실패 (후보 ${candidateId})\n${err.message}` }).catch(() => {});
    console.error(`[pipeline] failed ${candidateId}:`, err);
    return { ok: false, error: err.message };
  }
}
