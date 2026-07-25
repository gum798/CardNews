// 프로세스 A: 매일 09:00 launchd가 1회 실행 후 종료.
// collector → curator.filterAndRank → 후보 DB 저장 → bot.sendDigest → 종료.
// 발행(캐러셀+릴스)은 프로세스 B(bot-listener)가 텔레그램 승인 콜백을 받아 처리.
import { collect } from '../collector/index.js';
import { filterAndRank } from '../curator/index.js';
import { insertCandidate, getRecentNewsItems, getNewsItem } from '../db/index.js';
import { sendDigest, report } from '../bot/index.js';
import { pipeline } from '../config.js';

async function main() {
  // 1. 수집
  const c = await collect();
  console.log(`[digest] collected ${c.inserted} new items`);

  // 2. 최근 N시간 수집분
  const recent = getRecentNewsItems(pipeline.collectWindowHours);
  if (recent.length === 0) {
    await report({ text: '📭 오늘 수집된 뉴스가 없습니다.' });
    return;
  }

  // 3. AI 필터/랭킹 (curator가 파싱 실패 시 1회 재시도)
  let ranked;
  try {
    ranked = await filterAndRank(
      recent.map((r) => ({ id: r.id, source: r.source, title: r.title, summary: r.summary }))
    );
  } catch (err) {
    await report({ text: `⚠️ AI 필터 실패: ${err.message}` });
    throw err;
  }
  if (ranked.length === 0) {
    await report({ text: '🤔 오늘은 카드뉴스로 만들 만한 뉴스를 못 골랐습니다.' });
    return;
  }

  // 4. 후보 저장 + 다이제스트 페이로드 구성
  const candidates = [];
  for (const r of ranked) {
    const id = insertCandidate({
      newsItemId: r.newsItemId,
      rank: r.rank,
      aiReason: r.reason,
      status: 'pending',
    });
    candidates.push({ id, newsItem: getNewsItem(r.newsItemId), reason: r.reason });
  }

  // 5. 승인 버튼 달린 다이제스트 전송 (콜백은 프로세스 B가 처리)
  await sendDigest(candidates);
  console.log(`[digest] sent ${candidates.length} candidates`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[digest] fatal:', err);
    process.exit(1);
  });
