// 프로세스 B: launchd KeepAlive로 상시 상주. grammY 롱 폴링.
// 승인(pub) 콜백 → 파이프라인: writeCards → render → video → upload → publish → 보고.
// 스킵(skip) 콜백 → status=skipped.
import { startListener, report } from '../bot/index.js';
import {
  getCandidate,
  getNewsItem,
  updateCandidateStatus,
  setCandidateCardJson,
  insertPublish,
} from '../db/index.js';
import { writeCards } from '../curator/index.js';
import { renderCandidate } from '../renderer/index.js';
import { makeReel } from '../video/index.js';
import { uploadCandidate, uploadFile } from '../storage/index.js';
import { checkPublishingLimit, publishCarousel, publishReel } from '../publisher/index.js';
import { dryRun, topics } from '../config.js';

async function onApprove(candidateId) {
  try {
    const cand = getCandidate(candidateId);
    if (!cand) throw new Error('후보를 찾을 수 없음');
    updateCandidateStatus(candidateId, 'generating');

    // 1. 카드 데이터: evergreen 후보는 생성 시점에 card_json이 이미 있음 → writeCards 생략.
    let cardData;
    if (cand.card) {
      cardData = cand.card;
    } else {
      const newsItem = getNewsItem(cand.news_item_id);
      cardData = await writeCards({
        id: newsItem.id,
        source: newsItem.source,
        title: newsItem.title,
        summary: newsItem.summary,
        url: newsItem.url,
      });
    }
    // 주제별 테마(색) 적용.
    cardData.theme = topics[cand.topic]?.theme || 'navy';
    setCandidateCardJson(candidateId, cardData);

    // 2. 렌더 (4:5 카드 + 9:16 릴스 프레임)
    const { cardPaths, reelFramePaths } = await renderCandidate(candidateId, cardData);

    // 3. 릴스 영상
    const reelPath = await makeReel(candidateId, reelFramePaths);

    // 4. R2 업로드 (카드 + 릴스 + 릴스 커버=첫 9:16 프레임)
    const { cardUrls, reelUrl } = await uploadCandidate(candidateId, { cardPaths, reelPath });
    const coverUrl = await uploadFile(`${candidateId}/cover.jpg`, reelFramePaths[0], 'image/jpeg');
    updateCandidateStatus(candidateId, 'uploaded');

    // 5. IG 발행 (dryRun이면 합성 ID 반환)
    await checkPublishingLimit();
    const carouselId = await publishCarousel(cardUrls, cardData.caption);
    const reelId = await publishReel(reelUrl, coverUrl, cardData.caption);
    insertPublish({ candidateId, igCarouselId: carouselId, igReelId: reelId });
    updateCandidateStatus(candidateId, 'published');

    // 6. 결과 보고 (카드 앨범 + 릴스 영상 + 캡션 + 고화질 원본 링크)
    const lines = [];
    if (dryRun) {
      lines.push('✅ 생성 완료 (DRY_RUN — 인스타 자동발행은 건너뜀)');
      lines.push('아래 카드 4장 + 릴스를 저장해 인스타에 수동 업로드하세요.');
    } else {
      lines.push('✅ 발행 완료');
      lines.push(`캐러셀: ${carouselId}`);
      lines.push(`릴스: ${reelId}`);
    }
    lines.push('', '📋 캡션 (복사용):', cardData.caption, '', `🎬 릴스 고화질 원본: ${reelUrl}`);
    await report({ text: lines.join('\n'), mediaPaths: cardPaths, videoPath: reelPath });
    console.log(`[bot] done candidate ${candidateId}${dryRun ? ' (DRY_RUN)' : ''}`);
  } catch (err) {
    updateCandidateStatus(candidateId, 'failed');
    insertPublish({ candidateId, error: err.message });
    await report({ text: `❌ 발행 실패 (후보 ${candidateId})\n${err.message}` });
    console.error(`[bot] pipeline failed for ${candidateId}:`, err);
  }
}

async function onSkip(candidateId) {
  updateCandidateStatus(candidateId, 'skipped');
  console.log(`[bot] skipped candidate ${candidateId}`);
}

startListener({ onApprove, onSkip });
console.log(`[bot] listener up (dryRun=${dryRun})`);
