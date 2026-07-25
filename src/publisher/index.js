// IG Graph API v25.0 발행 (Instagram Login 방식, graph.instagram.com).
// 캐러셀: 카드별 자식 컨테이너 → CAROUSEL 부모 → media_publish.
// 릴스: REELS 컨테이너 → status_code 폴링(60초, 최대 5분) → media_publish.
// import만으로는 아무것도 실행하지 않는다 (모든 호출은 함수 안에서).
import { instagram, dryRun } from '../config.js';
import { setMeta } from '../db/index.js';

const BASE = `https://graph.instagram.com/${instagram.apiVersion}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 단일 API 호출. 실패(네트워크/HTTP 4xx·5xx) 시 1회 재시도 후 컨텍스트와 함께 throw.
async function apiCall(method, pathAndQuery, label) {
  const url = `${BASE}${pathAndQuery}`;
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const full = `${url}${sep}access_token=${encodeURIComponent(instagram.accessToken)}`;
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
      if (attempt === 2) throw new Error(`${label} 실패: ${err.message}`);
      await sleep(2000);
    }
  }
}

function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

// 캐러셀 발행: 각 이미지의 자식 컨테이너 생성 → CAROUSEL 부모 → 발행. 발행된 media id 반환.
export async function publishCarousel(imageUrls, caption) {
  if (dryRun) {
    const id = `DRYRUN-${Date.now()}`;
    console.log(`[publisher] DRY_RUN 캐러셀: ${imageUrls.length}장, caption=${caption?.slice(0, 40)}… → ${id}`);
    return id;
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

  const published = await apiCall(
    'POST',
    `/${instagram.userId}/media_publish?${qs({ creation_id: parent.id })}`,
    '캐러셀 발행'
  );
  console.log(`[publisher] 캐러셀 발행 완료 media_id=${published.id}`);
  return published.id;
}

// 릴스 발행: REELS 컨테이너 생성 → FINISHED까지 폴링 → 발행. 발행된 media id 반환.
export async function publishReel(videoUrl, coverUrl, caption) {
  if (dryRun) {
    const id = `DRYRUN-${Date.now()}`;
    console.log(`[publisher] DRY_RUN 릴스: video=${videoUrl}, cover=${coverUrl} → ${id}`);
    return id;
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

  // status_code 폴링: 60초 간격, 최대 5분(5회).
  for (let i = 0; i < 5; i++) {
    await sleep(60000);
    const status = await apiCall(
      'GET',
      `/${container.id}?${qs({ fields: 'status_code' })}`,
      'REELS 상태 확인'
    );
    console.log(`[publisher] REELS status_code=${status.status_code} (폴링 ${i + 1}/5)`);
    if (status.status_code === 'FINISHED') break;
    if (status.status_code === 'ERROR') throw new Error(`REELS 처리 실패 (container=${container.id})`);
    if (i === 4) throw new Error(`REELS 처리 타임아웃 (container=${container.id})`);
  }

  const published = await apiCall(
    'POST',
    `/${instagram.userId}/media_publish?${qs({ creation_id: container.id })}`,
    '릴스 발행'
  );
  console.log(`[publisher] 릴스 발행 완료 media_id=${published.id}`);
  return published.id;
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
  console.log(`[publisher] 토큰 갱신 완료, 만료=${expiresAt}`);
  return { accessToken: res.access_token, expiresAt };
}
