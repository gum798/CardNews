// 프로세스 A: launchd가 매시간 1회 실행 후 종료.
// 주제별로: 수집 → 최신 미사용 뉴스 1건 선별(없으면 유용한 정보 evergreen 생성) → 후보 저장 → 즉시 텔레그램 전송.
// 발행(캐러셀+릴스)은 프로세스 B(bot-listener)가 승인 콜백을 받아 처리.
import { collectTopic } from '../collector/index.js';
import { filterAndRank, generateEvergreen } from '../curator/index.js';
import {
  insertCandidate,
  insertNewsItem,
  getNewsItem,
  getRecentUnusedNewsItems,
} from '../db/index.js';
import { sendDigest, report } from '../bot/index.js';
import { topics, pipeline } from '../config.js';

async function runTopic(topicKey) {
  const t = topics[topicKey];
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
      await sendDigest([{ id, newsItem: getNewsItem(r.newsItemId), reason: `[${t.label}] ${r.reason}` }]);
      console.log(`[hourly:${topicKey}] candidate ${id} (news)`);
      return;
    }
  }

  // 최신 뉴스 없음 → 그 장르에 유용/흥미로운 콘텐츠를 AI가 창작 (evergreen)
  const cardData = await generateEvergreen(topicKey);
  const cover = cardData.cards.find((c) => c.type === 'cover')?.card || {};
  const newsItemId = insertNewsItem({
    topic: topicKey,
    source: t.label,
    url: `evergreen://${topicKey}/${Date.now()}`,
    title: cover.headline || t.label,
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
  await sendDigest([{ id, newsItem: getNewsItem(newsItemId), reason: `[${t.label}] 최신 뉴스 없음 → 유용한 정보` }]);
  console.log(`[hourly:${topicKey}] candidate ${id} (evergreen)`);
}

async function main() {
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
