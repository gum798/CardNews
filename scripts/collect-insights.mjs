// 자체 계정 인사이트 수집 — 「우리가 만든 것 중 뭐가 실제로 먹혔나」.
//
// 왜 필요한가:
//   장소 24곳·구도 13종·옷 여러 벌을 돌리고 있는데, 어느 조합이 반응이 좋은지
//   아무도 안 보고 있었다. 남의 트렌드를 긁는 것보다 이게 더 정확한 신호다 —
//   우리 그림에 대한 우리 관객의 반응이기 때문이다.
//   (외부 트렌드 수집은 인스타 공식 API에 색상·의상·위치 필드가 아예 없어서 불가능하다.
//    남의 사진을 받아 분석하는 건 「타인 사진 사용 금지」 규칙에 걸린다.)
//
// ⚠️ 우리 계정만 조회한다. 남의 계정은 건드리지 않는다.
// ⚠️ 원격 API라 업무 시간에 돌아도 된다 — 로컬 부하가 없다.
//
// 출력: out/insights.json  { collectedAt, byPlace, byDistance, byWeatherBand, unmatched }
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { instagram, paths } from '../src/config.js';

const V = 'v25.0';
const OUT = path.join(paths.out, 'insights.json');

async function get(url) {
  const r = await fetch(url);
  const b = await r.json();
  if (b.error) throw new Error(JSON.stringify(b.error).slice(0, 200));
  return b;
}

// 로컬 게시물 기록을 읽는다. place/compositions는 2026-09-03부터 기록되고
// 그 이전 54건은 theme+id로 재계산해 채웠다(placeBackfilled=true).
function localPosts() {
  const out = [];
  for (const d of readdirSync(paths.out)) {
    if (!d.startsWith('vlog-')) continue;
    const f = path.join(paths.out, d, 'post.json');
    if (!existsSync(f)) continue;
    try { out.push(JSON.parse(readFileSync(f, 'utf8'))); } catch {}
  }
  return out;
}

// 인스타 게시물과 로컬 기록을 잇는다.
// ⚠️ 발행 시 media id를 저장하지 않았으므로 캡션 첫 줄로 맞춘다.
//    첫 줄은 우리가 쓴 문장이고 게시물마다 달라서 키로 쓸 만하다.
//    앞으로는 발행할 때 igMediaId를 남기는 게 맞다(TODO).
const firstLine = (s) => String(s || '').split('\n')[0].trim().slice(0, 40);

function agg(rows, keyOf) {
  const m = {};
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    (m[k] ||= { n: 0, likes: 0, comments: 0, saved: 0, shares: 0, reach: 0 });
    m[k].n++;
    m[k].likes += r.like_count || 0;
    m[k].comments += r.comments_count || 0;
    m[k].saved += r.saved || 0;
    m[k].shares += r.shares || 0;
    m[k].reach += r.reach || 0;
  }
  // 평균 도달 대비 저장+공유. 저장·공유가 좋아요보다 「진짜 반응」에 가깝다.
  for (const k of Object.keys(m)) {
    const a = m[k];
    a.avgSavedShares = +(((a.saved + a.shares) / a.n) || 0).toFixed(2);
    a.avgLikes = +((a.likes / a.n) || 0).toFixed(1);
    a.avgReach = Math.round(a.reach / a.n) || 0;
  }
  return m;
}

async function main() {
  const tok = instagram.accessToken;
  if (!tok || !instagram.userId) {
    console.error('[insights] IG 토큰/유저ID 없음 — .env 확인');
    process.exit(2);
  }

  const list = await get(
    `https://graph.instagram.com/${V}/${instagram.userId}/media` +
      `?fields=id,media_type,media_product_type,caption,timestamp,permalink,like_count,comments_count` +
      `&limit=60&access_token=${encodeURIComponent(tok)}`
  );

  const media = [];
  for (const m of list.data || []) {
    const row = { ...m, saved: 0, shares: 0, reach: 0 };
    try {
      const metrics = m.media_product_type === 'REELS' ? 'views,reach,saved,shares' : 'views,reach,saved';
      const ins = await get(
        `https://graph.instagram.com/${V}/${m.id}/insights?metric=${metrics}&access_token=${encodeURIComponent(tok)}`
      );
      for (const d of ins.data || []) {
        const v = d.values?.[0]?.value ?? 0;
        if (d.name === 'reach') row.reach = v;
        if (d.name === 'saved') row.saved = v;
        if (d.name === 'shares') row.shares = v;
      }
    } catch {
      // 인사이트는 게시 직후나 일부 유형에서 비어 있다. 그 건은 0으로 둔다.
    }
    media.push(row);
  }

  // 로컬 기록과 매칭
  const byLine = new Map();
  for (const p of localPosts()) byLine.set(firstLine(p.caption), p);

  const joined = [];
  const unmatched = [];
  for (const m of media) {
    const p = byLine.get(firstLine(m.caption));
    if (p) joined.push({ ...m, place: p.place, theme: p.theme, distances: p.distances, weatherBand: p.weatherBand });
    else unmatched.push({ id: m.id, first: firstLine(m.caption), permalink: m.permalink });
  }

  const result = {
    collectedAt: new Date().toISOString(),
    mediaCount: media.length,
    matched: joined.length,
    unmatchedCount: unmatched.length,
    byPlace: agg(joined, (r) => r.place),
    byTheme: agg(joined, (r) => r.theme),
    byWeatherBand: agg(joined, (r) => r.weatherBand),
    unmatched: unmatched.slice(0, 10),
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2));

  console.log(`[insights] 인스타 ${media.length}건 · 매칭 ${joined.length}건 · 미매칭 ${unmatched.length}건`);
  const top = Object.entries(result.byPlace).sort((a, b) => b[1].avgSavedShares - a[1].avgSavedShares).slice(0, 8);
  if (top.length) {
    console.log('[insights] 저장+공유 평균 상위 장소:');
    for (const [k, v] of top) console.log(`  ${k.padEnd(18)} ${v.avgSavedShares}  (${v.n}건, 평균도달 ${v.avgReach})`);
  }
  console.log(`[insights] → ${OUT}`);
}

main().catch((e) => { console.error('[insights] 실패:', e.message.slice(0, 300)); process.exit(1); });
