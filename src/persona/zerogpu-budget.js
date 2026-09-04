// HuggingFace ZeroGPU 무료 할당 장부.
//
// 무료 계정은 하루 5분(300초)이고, **Space가 아니라 호출 계정** 기준이다.
// Space를 여러 개 복제해도 늘지 않는다(실측 2026-09-02: 사용자가 3개 복제했으나 동일 풀).
//
// ⚠️ CF 뉴런 장부(budget.js)와 같은 이유로 필요하다. 남은 양을 조회하는 API가 없으므로
//    우리가 직접 센다. 안 세면 게시물 중간에 할당량이 끊겨 반쪽짜리 영상이 나온다.
//
// ⚠️ 이 장부는 「계획」용이지 「진실」이 아니다. 실제 잔량은 HF만 안다.
//    거절당하면 그쪽이 항상 옳다 — 장부가 여유 있다고 해도 거절이면 소진된 것이다.
//
// ⚠️ ZeroGPU는 자정 일괄 리셋이 아니라 「롤링 24시간 창」이다(2026-09-03 실측으로 확인).
//    자정에 300초를 한꺼번에 채우는 게 아니라, 각 사용분이 「그 클립을 만든 시각 + 24시간」에
//    하나씩 되살아난다. 그래서 오늘 한 개도 안 만들어도, 어제 쓴 조각이 아직 24시간 창
//    안에 있으면 잔량이 300초가 아니다(실측: 오늘 미사용인데 49→56초로 조금씩 회복).
//    → 우리 자체 추정(firstUse+24h)은 이 롤링을 정확히 흉내낼 수 없다. 그래서 HF가
//    거절할 때 알려주는 실제 잔량(out/zerogpu-quota.json)을 항상 우선한다.
import { getMeta, setMeta } from '../db/index.js';
import { readFileSync } from 'node:fs';

const KEY = 'zerogpu:ledger';
export const DAILY_SECONDS = 300; // 무료 계정 5분/일

// 클립 1개가 먹는 GPU 초. 실측값이며, 모르는 조합은 비싼 쪽으로 잡아 과소평가를 피한다.
//   h3  3.04초/6스텝/640x1152 → 62초 (Space가 리포트한 denoise+decode 시간)
//   wan 3.56초/4스텝/480x832  → 미측정. 스텝이 적으니 더 싸지만 확인 전까지 h3와 같게 본다.
const COST = { h3: 62, wan: 62 };

export function costOf(kind = 'h3', durationSec = 3) {
  const base = COST[kind] ?? 70;
  // 길이에 대체로 비례한다. 3초 기준으로 환산한다.
  return Math.ceil(base * (durationSec / 3));
}

function load() {
  try {
    const l = JSON.parse(getMeta(KEY) || '{}');
    if (!l.firstUse) return { firstUse: 0, spent: 0 };
  // ⚠️ firstUse는 「우리가 처음 기록한 시각」이지 「HF가 본 첫 사용 시각」이 아니다.
  //    과거 사용분을 나중에 손으로 record()하면 firstUse가 그 시각으로 찍혀 리셋이
  //    실제보다 뒤로 밀린다(실측 2026-09-03: 하루 종일 안 썼는데 186초가 남아 있었다).
  //    거절당하면 HF가 옳고, 장부가 막는데 실제로는 여유가 있으면 reset()을 쓴다.
    // 첫 사용으로부터 24시간이 지났으면 리셋된 것으로 본다.
    if (Date.now() - l.firstUse >= 24 * 3600 * 1000) return { firstUse: 0, spent: 0 };
    return l;
  } catch {
    return { firstUse: 0, spent: 0 };
  }
}

export function spent() {
  return load().spent || 0;
}

export function remaining() {
  // ⚠️ HF가 거절하며 알려준 실제 잔량이 있으면 그게 우선이다(우리 추정보다 정확).
  //    scripts/zerogpu-clip.py(save_quota)가 거절 시 out/zerogpu-quota.json에 남긴다.
  try {
    const f = new URL('../../out/zerogpu-quota.json', import.meta.url);
    const q = JSON.parse(readFileSync(f, 'utf8'));
    const age = (Date.now() / 1000) - (q.checkedAt || 0);
    if (q.resetInSec != null && age < q.resetInSec) return q.secondsLeft ?? 0;
  } catch {}
  return Math.max(0, DAILY_SECONDS - spent());
}

/** 리셋까지 남은 시간(분). 아직 안 썼으면 null. */
export function resetsInMinutes() {
  const l = load();
  if (!l.firstUse) return null;
  return Math.max(0, Math.round((l.firstUse + 24 * 3600 * 1000 - Date.now()) / 60000));
}

/** 장부를 비운다. 실제로 안 썼는데 장부만 차 있을 때 쓴다. */
export function reset() {
  setMeta(KEY, JSON.stringify({ firstUse: 0, spent: 0 }));
}

export function record(seconds) {
  const l = load();
  setMeta(
    KEY,
    JSON.stringify({
      firstUse: l.firstUse || Date.now(),
      spent: (l.spent || 0) + Math.max(0, Math.round(seconds)),
    })
  );
}

/**
 * 이 게시물에 클립을 몇 개까지 만들 수 있는가.
 * ⚠️ 남는 걸 0까지 긁어 쓰지 않는다 — 재시도 한 번 분량은 남긴다.
 */
export function planClips(kind, wanted, { durationSec = 3, reserve = 70 } = {}) {
  const per = costOf(kind, durationSec);
  const usable = Math.max(0, remaining() - reserve);
  return { per, affordable: Math.floor(usable / per), wanted, usable, remaining: remaining() };
}
