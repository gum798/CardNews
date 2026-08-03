// 주제 1건을 즉시 수집→선별→생성→발행. 슬롯 플래그를 건드리지 않아 정규 스케줄에 영향 없음.
// 실행: NODE_EXTRA_CA_CERTS=certs/corp-root.pem node scripts/publish-one.mjs ai
import { collectTopic } from '../src/collector/index.js';
import { filterAndRank, generateEvergreen } from '../src/curator/index.js';
import {
  insertCandidate,
  insertNewsItem,
  getNewsItem,
  getRecentUnusedNewsItems,
} from '../src/db/index.js';
import { generateAndPublish } from '../src/pipeline.js';
import { topics, pipeline, dryRun } from '../src/config.js';

const topicKey = process.argv[2];
if (!topics[topicKey]) {
  console.error(`사용법: node scripts/publish-one.mjs <${Object.keys(topics).join('|')}>`);
  process.exit(1);
}

console.log(`[one] 주제=${topics[topicKey].label} dryRun=${dryRun}`);

await collectTopic(topicKey);

let candidateId;
const recent = getRecentUnusedNewsItems(topicKey, pipeline.collectWindowHours);
console.log(`[one] 미사용 최신 뉴스 ${recent.length}건`);

if (recent.length > 0) {
  const ranked = await filterAndRank(
    recent.map((r) => ({ id: r.id, source: r.source, title: r.title, summary: r.summary })),
    1,
    { topicKey }
  );
  if (ranked.length > 0) {
    const r = ranked[0];
    const n = getNewsItem(r.newsItemId);
    console.log(`[one] 선별: ${n.title}\n[one] 사유: ${r.reason}`);
    candidateId = insertCandidate({
      newsItemId: r.newsItemId,
      topic: topicKey,
      rank: r.rank,
      aiReason: r.reason,
      status: 'pending',
    });
  }
}

if (!candidateId) {
  console.log('[one] 최신 뉴스 없음 → evergreen 생성');
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
  candidateId = insertCandidate({
    newsItemId,
    topic: topicKey,
    aiReason: '수동 실행 → 유용한 정보',
    cardJson: cardData,
    status: 'pending',
  });
}

console.log(`[one] 후보 ${candidateId} 발행 시작…`);
const res = await generateAndPublish(candidateId, { auto: true });
console.log(`[one] 결과:`, JSON.stringify(res));
process.exit(res?.ok ? 0 : 1);
