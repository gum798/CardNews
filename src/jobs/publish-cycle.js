// 프로세스 A: launchd가 발행 슬롯의 target~retryUntilHour 매 정시에 실행 후 종료.
// 주제별로: 수집 → 최신 미사용 뉴스 1건 선별(없으면 evergreen 생성) → 후보 저장 →
//   자동 발행(일일 한도 내) 또는 텔레그램 수동 승인으로 분기.
//
// [재시도] 슬롯(morning/evening)·주제별 "완료" 플래그(meta)로 게이팅한다.
//   - 정상 성공 → 완료 마킹 → 그 슬롯의 다음 정시 실행은 no-op (중복 발행 없음).
//   - 실패(네트워크·AI 오류 등) → 마킹 안 함 → 다음 정시에 그 주제만 재시도.
//   - retryUntilHour까지 실패하면 그 슬롯은 포기(다음 슬롯에서 새로).
//   수동 실행: CARDNEWS_SLOT=morning node src/jobs/publish-cycle.js (슬롯 강제).
import { collectTopic } from '../collector/index.js';
import { filterAndRank, generateEvergreen } from '../curator/index.js';
import {
  insertCandidate,
  insertNewsItem,
  getNewsItem,
  getRecentUnusedNewsItems,
  countPublishedToday,
  getMeta,
  setMeta,
} from '../db/index.js';
import { sendDigest, report } from '../bot/index.js';
import { maybeRefreshToken } from '../publisher/index.js';
import { generateAndPublish } from '../pipeline.js';
import { topics, pipeline, schedule, autoPublish } from '../config.js';

// 로컬 날짜 "YYYY-MM-DD" (슬롯 완료 플래그 키에 사용).
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 현재 시각(hour)이 속한 슬롯 이름. 없으면 null. override(CARDNEWS_SLOT)가 있으면 우선.
function activeSlot(hour, override) {
  if (override) return schedule.slots[override] ? override : null;
  for (const [name, s] of Object.entries(schedule.slots)) {
    if (hour >= s.target && hour <= s.retryUntilHour) return name;
  }
  return null;
}

// 자동 발행(주제별 일일 한도 내) 또는 텔레그램 수동 승인으로 분기. 성공 여부(boolean) 반환.
async function dispatch(id, topicKey, newsItem, reason) {
  const label = topics[topicKey].label;
  if (autoPublish && countPublishedToday(topicKey) < pipeline.maxPerTopicPerDay) {
    console.log(`[publish:${topicKey}] auto-publish candidate ${id}`);
    const r = await generateAndPublish(id, { auto: true });
    return r?.ok === true; // 파이프라인 실패는 내부에서 잡아 {ok:false} 반환 → 재시도 대상
  }
  await sendDigest([{ id, newsItem, reason: `[${label}] ${reason}` }]);
  console.log(`[publish:${topicKey}] sent for approval candidate ${id}`);
  return true; // 사용자에게 승인 요청 전달 성공 = 이 슬롯 처리 완료로 간주
}

// 한 주제 처리. 성공 시 true, 발행 실패 시 false. 수집/AI 예외는 호출부에서 잡는다.
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
      return await dispatch(id, topicKey, getNewsItem(r.newsItemId), r.reason);
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
  return await dispatch(id, topicKey, getNewsItem(newsItemId), '최신 뉴스 없음 → 유용한 정보');
}

async function main() {
  const now = new Date();
  const override = process.env.CARDNEWS_SLOT || null;
  const slot = activeSlot(now.getHours(), override);
  const date = localDateStr(now);
  console.log(`[publish] start slot=${slot ?? '(none)'} date=${date} hour=${now.getHours()} (autoPublish=${autoPublish})`);

  if (!slot) {
    console.log('[publish] 활성 발행 슬롯 아님 → 종료 (오전 6~11시 / 오후 18~23시에만 실행)');
    return;
  }

  // IG 토큰 만료 임박 시 자동 갱신 (베스트에포트). 대시보드 토큰은 60일이고 만료 후엔 갱신 불가.
  try {
    const refreshed = await maybeRefreshToken();
    if (refreshed) {
      await report({ text: `🔑 인스타 토큰 자동 갱신 완료 (만료: ${refreshed.expiresAt.slice(0, 10)})` }).catch(() => {});
    }
  } catch (e) {
    console.error('[publish] IG 토큰 갱신 실패:', e.message);
    await report({ text: `⚠️ 인스타 토큰 갱신 실패 — 만료되면 수동 재발급 필요\n${e.message}` }).catch(() => {});
  }

  const isLastHour = !override && now.getHours() >= schedule.slots[slot].retryUntilHour;
  const label = (t) => topics[t].label;
  const pending = [];

  for (const topicKey of Object.keys(topics)) {
    const doneKey = `slotdone:${date}:${slot}:${topicKey}`;
    const alertKey = `slotalert:${date}:${slot}:${topicKey}`;

    if (getMeta(doneKey)) {
      console.log(`[publish:${topicKey}] 이미 완료(${slot}) → 건너뜀`);
      continue;
    }

    let ok = false;
    try {
      ok = await runTopic(topicKey);
    } catch (err) {
      console.error(`[publish:${topicKey}] error:`, err);
      ok = false;
    }

    if (ok) {
      setMeta(doneKey, new Date().toISOString());
      console.log(`[publish:${topicKey}] 완료 → ${slot} 마킹`);
      // 이전에 지연 알림을 보냈다면 복구 완료를 알린다.
      if (getMeta(alertKey)) {
        await report({ text: `✅ [${label(topicKey)}] ${slot} 발행 복구 완료 (재시도 성공)` }).catch(() => {});
      }
    } else {
      pending.push(topicKey);
      if (isLastHour) {
        // 재시도 창 종료까지 실패 → 최종 실패 알림.
        await report({
          text: `❌ [${label(topicKey)}] ${slot} 발행 최종 실패 — 오늘 이 슬롯은 건너뜁니다.`,
        }).catch(() => {});
      } else if (!getMeta(alertKey)) {
        // 슬롯당 1회만 지연 알림(스팸 방지). 이후 실패는 조용히 재시도.
        setMeta(alertKey, new Date().toISOString());
        await report({
          text: `⏳ [${label(topicKey)}] ${slot} 발행 지연 — 1시간 뒤 자동 재시도합니다.`,
        }).catch(() => {});
      }
      console.warn(`[publish:${topicKey}] 미완료 → ${isLastHour ? '창 종료(포기)' : '다음 정시 재시도'}`);
    }
  }

  if (pending.length) {
    console.log(`[publish] 미완료: ${pending.join(', ')} → ${isLastHour ? '창 종료' : '다음 정시 재시도'}`);
  } else {
    console.log(`[publish] ${slot} 전 주제 완료`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[publish] fatal:', err);
    process.exit(1);
  });
