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
function todayKey() {
  return `cf_neurons:${new Date().toISOString().slice(0, 10)}`;
}

export function spent() {
  return Number(getMeta(todayKey()) || 0);
}

export function record(neurons) {
  setMeta(todayKey(), String(spent() + Math.max(0, Math.round(neurons))));
}

export function remaining(accountCount = 1) {
  return Math.max(0, FREE_NEURONS_PER_ACCOUNT * accountCount - spent());
}

// 이 작업이 n장을 만들 여유가 있는지. 없으면 몇 장까지 되는지 알려준다.
// ⚠️ 남는 걸 0까지 긁어 쓰지 않는다. 뒤에 올 작업(뉴스 키프레임 등) 몫을 남긴다.
export function planPhotos(model, wanted, { accountCount = 1, reserve = 3000, ...size } = {}) {
  const per = estimateNeurons(model, size);
  const usable = Math.max(0, remaining(accountCount) - reserve);
  const affordable = Math.floor(usable / per);
  return { per, affordable: Math.min(wanted, affordable), usable, wanted };
}
