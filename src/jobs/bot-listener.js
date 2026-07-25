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
import { dryRun } from '../config.js';

async function onApprove(candidateId) {
  try {
    const cand = getCandidate(candidateId);
    if (!cand) throw new Error('후보를 찾을 수 없음');
    const newsItem = getNewsItem(cand.news_item_id);
    updateCandidateStatus(candidateId, 'generating');

    // 1. AI 카드 카피
    const cardData = await writeCards({
      id: newsItem.id,
      source: newsItem.source,
      title: newsItem.title,
      summary: newsItem.summary,
      url: newsItem.url,
    });
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

    // 6. 결과 보고 (카드 앨범 + 링크)
    const tag = dryRun ? ' (DRY_RUN)' : '';
    await report({
      text: `✅ 발행 완료${tag}\n캐러셀: ${carouselId}\n릴스: ${reelId}`,
      mediaPaths: cardPaths,
    });
    console.log(`[bot] published candidate ${candidateId}${tag}`);
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
