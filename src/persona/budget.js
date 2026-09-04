// Cloudflare Workers AI 무료 뉴런 예산 추적.
//
// 무료 할당은 계정당 하루 10,000뉴런이고 00:00 UTC에 초기화된다(CF 공식).
// 문제는 소비처가 하나가 아니라는 것이다 — 뉴스 발행이 릴스 키프레임을 뽑고,
// 브이로그가 피드 사진을 뽑는다. 둘이 같은 계정 풀을 쓴다.
//
// ⚠️ 이걸 안 세면 하루치를 앞선 작업이 다 먹고 뒤 작업이 통째로 죽는다(실측:
//    브이로그 5장 전원 실패 → 「사진을 한 장도 만들지 못했습니다」로 작업 사망).
//    CF는 남은 뉴런을 조회하는 API를 주지 않으므로 우리가 직접 센다.
//
// ⚠️ 이 장부는 「계획」용이지 「진실」이 아니다. 실제 잔량은 CF만 안다.
//    429가 오면 그쪽이 항상 옳다 — 장부가 여유 있다고 해도 429면 소진된 것이다.
import { getMeta, setMeta } from '../db/index.js';

// 계정당 10,000. 계정 수는 호출부가 넘긴다.
export const FREE_NEURONS_PER_ACCOUNT = 10_000;

// 문서 단가 (developers.cloudflare.com/workers-ai/platform/pricing).
// 512x512 타일 단위인 모델과 메가픽셀 단위인 모델이 섞여 있다.
const RATES = {
  '@cf/black-forest-labs/flux-2-klein-4b': { kind: 'tile', out: 26.05, in: 5.37 },
  '@cf/black-forest-labs/flux-2-klein-9b': { kind: 'mp', first: 1363.64, next: 181.82, in: 181.82 },
  '@cf/black-forest-labs/flux-2-dev': { kind: 'tile-step', out: 37.5, in: 18.75, steps: 28 },
  '@cf/black-forest-labs/flux-1-schnell': { kind: 'tile', out: 9.6, in: 0 },
};

// 이미지 1장이 얼마나 드는지. 모르는 모델은 가장 비싼 축으로 잡아 과소평가를 피한다.
export function estimateNeurons(model, { width = 768, height = 1376, refs = 0 } = {}) {
  const r = RATES[model];
  if (!r) return 1500; // 미지의 모델 — 보수적으로
  const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
  const mp = (width * height) / 1e6;
  // 레퍼런스는 480x480으로 줄여 보낸다(headCropForRef).
  const refTiles = refs * 1;
  const refMp = refs * ((480 * 480) / 1e6);
  if (r.kind === 'tile') return Math.round(r.out * tiles + r.in * refTiles);
  if (r.kind === 'tile-step') return Math.round((r.out * tiles + r.in * refTiles) * r.steps);
  return Math.round(r.first + Math.max(0, mp - 1) * r.next + refMp * r.in);
}

// 오늘(UTC) 키. 00:00 UTC에 바뀌므로 그때 장부가 저절로 초기화된다.
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}
function todayKey() {
  return `cf_neurons:${dayKey()}`;
}
// 계정별 장부. 총액 하나로는 「어느 계정이 얼마 남았나」를 모른다.
// 실측 2026-09-04: 총액 장부는 12,794 남았다고 했는데 실제로는 두 계정 다 429였다.
//   계정 1은 전날 뉴스가 다 먹은 채로 UTC 자정이 지나도 429가 계속 왔고(초기화 시각이
//   문서와 다르거나 다른 소비처가 있는 듯), 계정 2는 재시도 포함 7번 호출로 바닥났다.
//   그래서 가드가 통과 → 5장 전원 실패 → 텔레그램에 실패 알림만 갔다.
const acctKey = (ai) => `cf_neurons:${dayKey()}:${ai}`;
const exhaustedKey = (ai) => `cf_exhausted:${dayKey()}:${ai}`;

// ai를 주면 그 계정(0부터), 안 주면 오늘 총액.
export function spent(ai = null) {
  return Number(getMeta(ai == null ? todayKey() : acctKey(ai)) || 0);
}

export function record(neurons, ai = null) {
  const n = Math.max(0, Math.round(neurons));
  setMeta(todayKey(), String(spent() + n));
  if (ai != null) setMeta(acctKey(ai), String(spent(ai) + n));
}

// 429는 뉴런을 안 쓰지만 「이 계정은 오늘 끝」이라는 정보다. 장부가 얼마를 남겼다고
// 하든 CF가 옳으므로, 그 계정은 오늘(UTC) 남은 몫 0으로 친다.
// ⚠️ 429 표시는 2시간만 믿는다. 초기화가 문서(00:00 UTC)대로 오지 않는 걸 실측했다
//    (2026-09-04: 00:52~01:04 UTC에 두 계정 다 429 → 04:55 UTC 탐침에 둘 다 200).
//    영구 표시면 그날 남은 8시간을 통째로 버린다(실제로 11시 day 슬롯이 「남은 0」으로 죽었다).
//    2시간 지나면 「모름」으로 돌아가고, 다음 작업의 탐침(58뉴런)이 다시 확인한다.
const EXHAUST_TTL_MS = 2 * 3600 * 1000;
export function markExhausted(ai) {
  setMeta(exhaustedKey(ai), String(Date.now()));
}
export function isExhausted(ai) {
  const t = Number(getMeta(exhaustedKey(ai)));
  // 옛 형식('1')은 t=1 → 만료로 본다.
  return Number.isFinite(t) && t > 1e12 && Date.now() - t < EXHAUST_TTL_MS;
}

export function remaining(accountCount = 1) {
  let sum = 0;
  for (let ai = 0; ai < accountCount; ai++) {
    if (isExhausted(ai)) continue;
    sum += Math.max(0, FREE_NEURONS_PER_ACCOUNT - spent(ai));
  }
  // 계정 기록 없이 총액만 남긴 호출(옛 코드)과 섞여도 총액 기준보다 낙관하지 않는다.
  return Math.min(sum, Math.max(0, FREE_NEURONS_PER_ACCOUNT * accountCount - spent()));
}

// 로그·가드용 한 줄 요약. 예: "계정1 소진 · 계정2 7206/10000"
export function summary(accountCount = 1) {
  const parts = [];
  for (let ai = 0; ai < accountCount; ai++) {
    parts.push(isExhausted(ai) ? `계정${ai + 1} 소진` : `계정${ai + 1} ${spent(ai)}/${FREE_NEURONS_PER_ACCOUNT}`);
  }
  return parts.join(' · ');
}

// 이 작업이 n장을 만들 여유가 있는지. 없으면 몇 장까지 되는지 알려준다.
// ⚠️ 남는 걸 0까지 긁어 쓰지 않는다. 뒤에 올 작업(뉴스 키프레임 등) 몫을 남긴다.
//    예비 1,000: 키프레임은 4B라 한 장 약 160뉴런, 하루 4장 ≈ 650 + 재시도 한 번.
//    (예전 3,000은 장부가 총액뿐이라 계정별 상태를 몰랐을 때의 안전 마진이었다. 계정별
//    장부·탐침을 넣은 뒤에도 3,000을 두면 계정 하나만 살아 있는 아침엔 9,960−3,000=6,960
//    → 4장으로 깎여 5정거장 브이로그의 마지막 정거장이 통째로 빠진다.)
export function planPhotos(model, wanted, { accountCount = 1, reserve = 1000, ...size } = {}) {
  const per = estimateNeurons(model, size);
  const usable = Math.max(0, remaining(accountCount) - reserve);
  const affordable = Math.floor(usable / per);
  return { per, affordable: Math.min(wanted, affordable), usable, wanted };
}
