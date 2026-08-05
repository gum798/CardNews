// IG Graph API v25.0 발행 (Instagram Login 방식, graph.instagram.com).
// 캐러셀: 카드별 자식 컨테이너 → CAROUSEL 부모 → media_publish.
// 릴스: REELS 컨테이너 → status_code 폴링(60초, 최대 5분) → media_publish.
// import만으로는 아무것도 실행하지 않는다 (모든 호출은 함수 안에서).
import { instagram, dryRun } from '../config.js';
import { getMeta, setMeta } from '../db/index.js';

const BASE = `https://graph.instagram.com/${instagram.apiVersion}`;
const DAY = 86_400_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 실제로 쓸 액세스 토큰. 자동 갱신된 토큰(meta)이 있으면 그것을, 없으면 .env 값을 쓴다.
// config.js는 순환 임포트(config→db→config) 때문에 DB를 읽을 수 없어 여기서 해결한다.
// .env의 토큰을 사람이 교체하면 meta 캐시를 버리고 .env를 따른다(교체 시점의 .env 꼬리표로 판별).
function currentToken() {
  const envTok = instagram.accessToken;
  const metaTok = getMeta('ig_access_token');
  const envTail = getMeta('ig_token_env_tail');
  if (metaTok && envTok && envTail && envTail === envTok.slice(-8)) return metaTok;
  return envTok;
}

// 재시도하면 오히려 해로운 IG 오류코드.
//  4 / 2207051 = Application request limit reached(행동 차단) — 재시도가 차단을 키운다.
//  9007 / 2207027 = 컨테이너가 아직 처리 중 — 즉시 재시도 대신 상태 폴링으로 기다려야 한다.
function isNoRetryError(msg) {
  return /"code":4[,}]/.test(msg) || /2207051/.test(msg) || /2207027/.test(msg) || /9007/.test(msg);
}

// 단일 API 호출. 일시적 실패는 1회 재시도하되, 위 코드들은 즉시 throw.
async function apiCall(method, pathAndQuery, label) {
  const url = `${BASE}${pathAndQuery}`;
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const full = `${url}${sep}access_token=${encodeURIComponent(currentToken())}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(full, { method });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        const msg = body.error ? JSON.stringify(body.error) : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return body;
    } catch (err) {
      console.error(`[publisher] ${label} 실패 (시도 ${attempt}/2): ${err.message}`);
      if (attempt === 2 || isNoRetryError(err.message)) throw new Error(`${label} 실패: ${err.message}`);
      await sleep(2000);
    }
  }
}

// 컨테이너가 발행 가능(FINISHED)해질 때까지 폴링.
// IG는 컨테이너 생성 직후엔 아직 처리 중이라 media_publish가 9007(2207027)로 거부된다.
async function waitForContainer(containerId, { intervalMs, maxWaitMs, label }) {
  const deadline = Date.now() + maxWaitMs;
  let last = '(미확인)';
  while (Date.now() < deadline) {
    const s = await apiCall('GET', `/${containerId}?${qs({ fields: 'status_code' })}`, `${label} 상태 확인`);
    last = s.status_code;
    if (last === 'FINISHED') {
      console.log(`[publisher] ${label} 준비 완료 (FINISHED)`);
      return;
    }
    if (last === 'ERROR' || last === 'EXPIRED') {
      throw new Error(`${label} 처리 실패: status_code=${last} (container=${containerId})`);
    }
    console.log(`[publisher] ${label} status_code=${last} → ${intervalMs / 1000}초 후 재확인`);
    await sleep(intervalMs);
  }
  throw new Error(`${label} 처리 타임아웃 (마지막 status_code=${last}, container=${containerId})`);
}

function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

// ---------- 중복 발행 방지 ----------
// IG는 발행이 실제로 성공했는데도 오류를 반환하는 경우가 있다(경합/타임아웃).
// 그 응답만 믿고 재시도하면 같은 게시물이 두 번 올라간다 → 캡션으로 실제 게시 여부를 확인한다.
const DUP_WINDOW_MS = 24 * 3_600_000;

function normCaption(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

// 최근 게시물 중 같은 캡션·같은 형식이 있으면 그 media id 반환, 없으면 null.
// productType: 'FEED'(캐러셀) | 'REELS'(릴스)
async function findRecentDuplicate(caption, productType) {
  const key = normCaption(caption);
  if (!key || !instagram.userId) return null;
  try {
    const res = await apiCall(
      'GET',
      `/${instagram.userId}/media?${qs({ fields: 'id,media_product_type,timestamp,caption', limit: '15' })}`,
      '최근 게시물 조회'
    );
    const cutoff = Date.now() - DUP_WINDOW_MS;
    for (const m of res.data ?? []) {
      if (m.media_product_type !== productType) continue;
      if (new Date(m.timestamp).getTime() < cutoff) continue;
      if (normCaption(m.caption) === key) return m.id;
    }
  } catch (e) {
    // 확인 자체가 실패하면 발행을 막지 않는다 (베스트에포트).
    console.warn(`[publisher] 중복 확인 실패(계속 진행): ${e.message}`);
  }
  return null;
}

// media_publish 실행. 오류가 나도 실제로는 게시됐을 수 있으므로 확인 후 성공 처리.
async function publishContainer(creationId, caption, productType, label) {
  try {
    const published = await apiCall(
      'POST',
      `/${instagram.userId}/media_publish?${qs({ creation_id: creationId })}`,
      label
    );
    console.log(`[publisher] ${label} 완료 media_id=${published.id}`);
    return published.id;
  } catch (e) {
    await sleep(3000);
    const actual = await findRecentDuplicate(caption, productType);
    if (actual) {
      console.log(`[publisher] ${label}이(가) 오류를 반환했으나 실제 게시 확인됨 → 성공 처리 (media_id=${actual})`);
      return actual;
    }
    throw e;
  }
}

// 캐러셀 발행: 각 이미지의 자식 컨테이너 생성 → CAROUSEL 부모 → 발행. 발행된 media id 반환.
export async function publishCarousel(imageUrls, caption) {
  if (dryRun) {
    const id = `DRYRUN-${Date.now()}`;
    console.log(`[publisher] DRY_RUN 캐러셀: ${imageUrls.length}장, caption=${caption?.slice(0, 40)}… → ${id}`);
    return id;
  }

  // 이미 올라가 있으면(직전 시도가 오류를 냈지만 실제로는 성공한 경우 등) 다시 올리지 않는다.
  const already = await findRecentDuplicate(caption, 'FEED');
  if (already) {
    console.log(`[publisher] 동일 캡션 캐러셀이 이미 게시됨 → 발행 생략 (media_id=${already})`);
    return already;
  }

  const childIds = [];
  for (const imageUrl of imageUrls) {
    const child = await apiCall(
      'POST',
      `/${instagram.userId}/media?${qs({ image_url: imageUrl, is_carousel_item: 'true' })}`,
      '자식 컨테이너 생성'
    );
    console.log(`[publisher] 자식 creation_id=${child.id} (${imageUrl})`);
    childIds.push(child.id);
  }

  const parent = await apiCall(
    'POST',
    `/${instagram.userId}/media?${qs({ media_type: 'CAROUSEL', children: childIds.join(','), caption: caption ?? '' })}`,
    'CAROUSEL 부모 생성'
  );
  console.log(`[publisher] CAROUSEL creation_id=${parent.id}`);

  // 컨테이너가 준비되기 전에 발행하면 9007(Media ID is not available)로 거부된다.
  await waitForContainer(parent.id, { intervalMs: 5000, maxWaitMs: 120_000, label: 'CAROUSEL' });

  return await publishContainer(parent.id, caption, 'FEED', '캐러셀 발행');
}

// 단일 사진 발행. 캐러셀은 2장 이상이어야 하므로 1장짜리는 이 경로로 간다.
export async function publishPhoto(imageUrl, caption) {
  if (dryRun) {
    const id = `DRYRUN-${Date.now()}`;
    console.log(`[publisher] DRY_RUN 사진: ${imageUrl} → ${id}`);
    return id;
  }

  const already = await findRecentDuplicate(caption, 'IMAGE');
  if (already) {
    console.log(`[publisher] 동일 캡션 사진이 이미 게시됨 → 발행 생략 (media_id=${already})`);
    return already;
  }

  const container = await apiCall(
    'POST',
    `/${instagram.userId}/media?${qs({ image_url: imageUrl, caption: caption ?? '' })}`,
    'IMAGE 컨테이너 생성'
  );
  console.log(`[publisher] IMAGE creation_id=${container.id}`);
  await waitForContainer(container.id, { intervalMs: 5000, maxWaitMs: 120_000, label: 'IMAGE' });
  return await publishContainer(container.id, caption, 'FEED', '사진 발행');
}

// 릴스 발행: REELS 컨테이너 생성 → FINISHED까지 폴링 → 발행. 발행된 media id 반환.
export async function publishReel(videoUrl, coverUrl, caption) {
  if (dryRun) {
    const id = `DRYRUN-${Date.now()}`;
    console.log(`[publisher] DRY_RUN 릴스: video=${videoUrl}, cover=${coverUrl} → ${id}`);
    return id;
  }

  const already = await findRecentDuplicate(caption, 'REELS');
  if (already) {
    console.log(`[publisher] 동일 캡션 릴스가 이미 게시됨 → 발행 생략 (media_id=${already})`);
    return already;
  }

  const container = await apiCall(
    'POST',
    `/${instagram.userId}/media?${qs({
      media_type: 'REELS',
      video_url: videoUrl,
      cover_url: coverUrl,
      share_to_feed: 'true',
      caption: caption ?? '',
    })}`,
    'REELS 컨테이너 생성'
  );
  console.log(`[publisher] REELS creation_id=${container.id}`);

  // 영상은 인코딩이 오래 걸린다. 20초 간격으로 최대 6분 폴링(고정 60초 대기보다 빠르게 통과).
  await waitForContainer(container.id, { intervalMs: 20_000, maxWaitMs: 360_000, label: 'REELS' });

  return await publishContainer(container.id, caption, 'REELS', '릴스 발행');
}

// 24시간 발행 한도 조회. quota 객체 반환.
export async function checkPublishingLimit() {
  if (dryRun) {
    console.log('[publisher] DRY_RUN content_publishing_limit 조회 생략');
    return { config: { quota_total: 100 }, quota_usage: 0 };
  }
  const res = await apiCall(
    'GET',
    `/${instagram.userId}/content_publishing_limit?${qs({ fields: 'config,quota_usage' })}`,
    '발행 한도 조회'
  );
  const quota = res.data?.[0] ?? res;
  console.log(`[publisher] 발행 한도: usage=${quota.quota_usage}, total=${quota.config?.quota_total}`);
  return quota;
}

// long-lived 토큰 갱신. 새 토큰·만료일을 meta에 저장하고 { accessToken, expiresAt } 반환.
export async function refreshToken() {
  if (dryRun) {
    console.log('[publisher] DRY_RUN 토큰 갱신 생략');
    return null;
  }
  const res = await apiCall(
    'GET',
    `/refresh_access_token?${qs({ grant_type: 'ig_refresh_token' })}`,
    '토큰 갱신'
  );
  const expiresAt = new Date(Date.now() + res.expires_in * 1000).toISOString();
  setMeta('ig_access_token', res.access_token);
  setMeta('ig_token_expires_at', expiresAt);
  // 이 meta 토큰이 어느 .env 토큰에서 파생됐는지 기록 → 사람이 .env를 교체하면 캐시를 버린다.
  if (instagram.accessToken) setMeta('ig_token_env_tail', instagram.accessToken.slice(-8));
  console.log(`[publisher] 토큰 갱신 완료, 만료=${expiresAt}`);
  return { accessToken: res.access_token, expiresAt };
}

// 만료가 가까우면(기본 14일 이내) 자동 갱신. 발행 사이클마다 호출되는 베스트에포트 유지보수.
// 대시보드 발급 토큰은 60일짜리이고 만료 후에는 갱신 자체가 불가능하므로, 만료 전에 갱신해야 한다.
// (IG 규칙: 발급 후 24시간이 지나야 갱신 가능 → 최초 기록 시점부터 60일로 가정하고 추적)
export async function maybeRefreshToken({ withinDays = 14 } = {}) {
  if (dryRun || !currentToken()) return null;

  const envTail = instagram.accessToken ? instagram.accessToken.slice(-8) : null;
  // .env 토큰이 새로 교체됐으면 만료 추적을 초기화한다.
  if (envTail && getMeta('ig_token_env_tail_seen') !== envTail) {
    setMeta('ig_token_env_tail_seen', envTail);
    setMeta('ig_token_expires_at', new Date(Date.now() + 60 * DAY).toISOString());
    setMeta('ig_access_token', ''); // 이전 갱신 캐시 폐기
    console.log('[publisher] 새 .env 토큰 감지 → 만료일 60일로 재설정');
  }

  let expiresAt = getMeta('ig_token_expires_at');
  if (!expiresAt) {
    expiresAt = new Date(Date.now() + 60 * DAY).toISOString();
    setMeta('ig_token_expires_at', expiresAt);
    console.log(`[publisher] 토큰 만료일 최초 기록: ${expiresAt}`);
  }

  const remainingDays = (new Date(expiresAt).getTime() - Date.now()) / DAY;
  if (remainingDays > withinDays) {
    console.log(`[publisher] 토큰 잔여 ${remainingDays.toFixed(0)}일 → 갱신 불필요`);
    return null;
  }

  console.log(`[publisher] 토큰 잔여 ${remainingDays.toFixed(1)}일 → 갱신 시도`);
  return await refreshToken();
}
