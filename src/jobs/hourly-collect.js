// 프로세스 A: launchd가 매시간 1회 실행 후 종료.
// 주제별로: 수집 → 최신 미사용 뉴스 1건 선별(없으면 evergreen 생성) → 후보 저장 →
//   자동 발행(일일 한도 내) 또는 텔레그램 수동 승인으로 분기.
import { collectTopic } from '../collector/index.js';
import { filterAndRank, generateEvergreen } from '../curator/index.js';
import {
  insertCandidate,
  insertNewsItem,
  getNewsItem,
  getRecentUnusedNewsItems,
  countPublishedToday,
} from '../db/index.js';
import { sendDigest, report } from '../bot/index.js';
import { generateAndPublish } from '../pipeline.js';
import { topics, pipeline, autoPublish } from '../config.js';

// 자동 발행(주제별 일일 한도 내) 또는 텔레그램 수동 승인으로 분기.
async function dispatch(id, topicKey, newsItem, reason) {
  const label = topics[topicKey].label;
  if (autoPublish && countPublishedToday(topicKey) < pipeline.maxPerTopicPerDay) {
    console.log(`[hourly:${topicKey}] auto-publish candidate ${id}`);
    await generateAndPublish(id, { auto: true });
  } else {
    await sendDigest([{ id, newsItem, reason: `[${label}] ${reason}` }]);
    console.log(`[hourly:${topicKey}] sent for approval candidate ${id}`);
  }
}

async function runTopic(topicKey) {
  await collectTopic(topicKey);

  // 최근 미사용(겹치지 않는) 뉴스 → AI로 1건 선별
  const recent = getRecentUnusedNewsItems(topicKey, pipeline.collectWindowHours);
  if (recent.length > 0) {
    const ranked = await filterAndRank(
      recent.map((r) => ({ id: r.id, source: r.source, title: r.title, summary: r.summary })),
      pipeline.perTopicPick
    );
    if (ranked.length > 0) {
      const r = ranked[0];
      const id = insertCandidate({
        newsItemId: r.newsItemId,
        topic: topicKey,
        rank: r.rank,
        aiReason: r.reason,
        status: 'pending',
      });
      await dispatch(id, topicKey, getNewsItem(r.newsItemId), r.reason);
      return;
    }
  }

  // 최신 뉴스 없음 → 그 장르에 유용/흥미로운 콘텐츠를 AI가 창작 (evergreen)
  const cardData = await generateEvergreen(topicKey);
  const cover = cardData.cards.find((c) => c.type === 'cover')?.card || {};
  const newsItemId = insertNewsItem({
    topic: topicKey,
    source: topics[topicKey].label,
    url: `evergreen://${topicKey}/${Date.now()}`,
    title: cover.headline || topics[topicKey].label,
    summary: cover.sub || '',
    publishedAt: new Date().toISOString(),
  });
  const id = insertCandidate({
    newsItemId,
    topic: topicKey,
    aiReason: '최신 뉴스 없음 → 유용한 정보',
    cardJson: cardData,
    status: 'pending',
  });
  await dispatch(id, topicKey, getNewsItem(newsItemId), '최신 뉴스 없음 → 유용한 정보');
}

async function main() {
  console.log(`[hourly] start (autoPublish=${autoPublish})`);
  for (const topicKey of Object.keys(topics)) {
    try {
      await runTopic(topicKey);
    } catch (err) {
      console.error(`[hourly:${topicKey}] failed:`, err);
      await report({ text: `⚠️ [${topics[topicKey].label}] 수집 실패: ${err.message}` }).catch(() => {});
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[hourly] fatal:', err);
    process.exit(1);
  });
