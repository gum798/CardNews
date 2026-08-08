// 발행한 영상들의 실제 성과를 수집한다 (유튜브 statistics + 인스타 insights).
// 실행: NODE_EXTRA_CA_CERTS=certs/corp-root.pem node scripts/stats.mjs [--json]
import { youtube as makeYoutube, auth as gauth } from '@googleapis/youtube';
import { youtube as ytCfg, instagram, account, profile } from '../src/config.js';
import * as db from '../src/db/index.js';

const asJson = process.argv.includes('--json');

// ---------- 발행 이력 ----------
const rows = db.default
  .prepare(
    `SELECT c.id, c.topic, c.card_json, datetime(c.created_at,'localtime') t,
            p.ig_reel_id, p.ig_carousel_id
     FROM candidates c JOIN publishes p ON p.candidate_id = c.id
     WHERE c.status = 'published' AND p.ig_reel_id IS NOT NULL
       AND p.ig_reel_id NOT LIKE 'DRYRUN%'
     ORDER BY c.id`
  )
  .all();

// ---------- 유튜브 ----------
// ⚠️ publishedAt은 UTC다. 그대로 잘라 찍으면 KST와 9시간 어긋나 시간대 결론이 뒤집힌다.
function kst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 같은 슬롯(30분 이내 연속 업로드)을 한 묶음으로 본다.
// 조회수의 무작위 단위는 영상이 아니라 슬롯이다 — 영상 단위로 비교하면 잡음을 신호로 읽는다.
function batches(videos) {
  const sorted = [...videos].sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
  const out = [];
  for (const v of sorted) {
    const last = out[out.length - 1];
    if (last && new Date(v.publishedAt) - new Date(last.at) <= 30 * 60 * 1000) {
      last.items.push(v);
      last.at = v.publishedAt;
    } else out.push({ at: v.publishedAt, start: v.publishedAt, items: [v] });
  }
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };

async function youtubeStats() {
  if (!ytCfg.refreshToken) return [];
  const oauth2 = new gauth.OAuth2(ytCfg.clientId, ytCfg.clientSecret);
  oauth2.setCredentials({ refresh_token: ytCfg.refreshToken });
  const yt = makeYoutube({ version: 'v3', auth: oauth2 });

  // 채널의 업로드 재생목록에서 최근 영상 전체를 훑는다(우리가 올린 것 = 전부).
  const ch = await yt.channels.list({ part: ['snippet', 'contentDetails', 'statistics'], mine: true });
  const channel = ch.data.items?.[0];
  const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];

  const ids = [];
  let pageToken;
  do {
    const pl = await yt.playlistItems.list({
      part: ['contentDetails'], playlistId: uploads, maxResults: 50, pageToken,
    });
    ids.push(...(pl.data.items || []).map((i) => i.contentDetails.videoId));
    pageToken = pl.data.nextPageToken;
  } while (pageToken && ids.length < 200);

  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await yt.videos.list({
      part: ['snippet', 'statistics', 'contentDetails', 'status'],
      id: ids.slice(i, i + 50),
    });
    for (const it of v.data.items || []) {
      out.push({
        id: it.id,
        title: it.snippet.title,
        publishedAt: it.snippet.publishedAt,
        duration: it.contentDetails?.duration,
        privacy: it.status?.privacyStatus,
        views: Number(it.statistics?.viewCount || 0),
        likes: Number(it.statistics?.likeCount || 0),
        comments: Number(it.statistics?.commentCount || 0),
      });
    }
  }
  return {
    channel: {
      title: channel.snippet?.title,
      subscribers: Number(channel.statistics?.subscriberCount || 0),
      totalViews: Number(channel.statistics?.viewCount || 0),
      videoCount: Number(channel.statistics?.videoCount || 0),
    },
    videos: out.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)),
  };
}

// ---------- 인스타그램 ----------
async function igStats() {
  const tok = db.getMeta('ig_access_token') || instagram.accessToken;
  if (!tok || !instagram.userId) return null;
  const V = instagram.apiVersion;
  const g = async (u) => {
    const r = await fetch(u);
    const b = await r.json();
    if (b.error) throw new Error(JSON.stringify(b.error).slice(0, 200));
    return b;
  };

  const me = await g(
    `https://graph.instagram.com/${V}/${instagram.userId}?fields=username,followers_count,media_count&access_token=${encodeURIComponent(tok)}`
  );
  const list = await g(
    `https://graph.instagram.com/${V}/${instagram.userId}/media?fields=id,media_type,media_product_type,caption,timestamp,permalink,like_count,comments_count&limit=40&access_token=${encodeURIComponent(tok)}`
  );

  const media = [];
  for (const m of list.data || []) {
    let views = null, reach = null, saved = null, shares = null;
    try {
      const metrics = m.media_product_type === 'REELS' ? 'views,reach,saved,shares' : 'views,reach,saved';
      const ins = await g(
        `https://graph.instagram.com/${V}/${m.id}/insights?metric=${metrics}&access_token=${encodeURIComponent(tok)}`
      );
      for (const d of ins.data || []) {
        const val = d.values?.[0]?.value ?? 0;
        if (d.name === 'views') views = val;
        if (d.name === 'reach') reach = val;
        if (d.name === 'saved') saved = val;
        if (d.name === 'shares') shares = val;
      }
    } catch { /* 인사이트 미제공 게시물은 건너뜀 */ }
    media.push({
      id: m.id,
      type: m.media_product_type,
      timestamp: m.timestamp,
      permalink: m.permalink,
      caption: String(m.caption || '').split('\n')[0].slice(0, 40),
      likes: m.like_count ?? 0,
      comments: m.comments_count ?? 0,
      views, reach, saved, shares,
    });
  }
  return { account: me, media };
}

const [yt, ig] = await Promise.all([
  youtubeStats().catch((e) => ({ error: e.message })),
  igStats().catch((e) => ({ error: e.message })),
]);

// 후보 메타(훅 유형·대본 구조)를 영상과 연결
const meta = rows.map((r) => {
  let s = {};
  try { s = JSON.parse(r.card_json)?.script || {}; } catch {}
  return { id: r.id, topic: r.topic, at: r.t, igReel: r.ig_reel_id, hookType: s.hookType, style: s.scriptStyle, hook: s.hook };
});

const result = { profile: profile.key, account: account.name, youtube: yt, instagram: ig, candidates: meta };

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n=== ${account.name} 성과 ===\n`);
  if (yt?.channel) {
    console.log(`[유튜브] ${yt.channel.title} · 구독 ${yt.channel.subscribers} · 총 ${yt.channel.totalViews}뷰 · 영상 ${yt.channel.videoCount}개`);
    const vs = yt.videos || [];
    const total = vs.reduce((a, v) => a + v.views, 0);
    const zero = vs.filter((v) => v.views === 0).length;
    console.log(`  영상 ${vs.length}개 / 합계 ${total}뷰 / 0뷰 ${zero}개 (${vs.length ? Math.round((zero / vs.length) * 100) : 0}%)`);
    for (const v of vs.slice(0, 25)) {
      console.log(`  ${String(v.views).padStart(5)}뷰 ♥${String(v.likes).padStart(3)} ${kst(v.publishedAt)} [${v.privacy}] ${v.title.slice(0, 42)}`);
    }

    // 48시간 지났는데 10뷰 미만 = 저조회수가 아니라 배포가 안 된 것.
    // 이걸 제목·주제 학습 데이터에 섞으면 엉뚱한 결론이 나온다.
    const dead = vs.filter((v) => v.views < 10 && Date.now() - new Date(v.publishedAt) > 48 * 3600 * 1000);
    if (dead.length) {
      console.log(`\n  ⚠️ 배포 사고 의심 ${dead.length}건 (48시간 경과 · 10뷰 미만)`);
      console.log('     저조회수가 아니라 노출이 안 된 것이다. 제목·주제 분석에서 제외할 것.');
      for (const v of dead) console.log(`     ${String(v.views).padStart(3)}뷰 ${kst(v.publishedAt)} ${v.title.slice(0, 34)}`);
    }

    // 슬롯 단위 중앙값. 같은 슬롯이 통째로 죽었으면 제목·주제 규칙을 건드리면 안 된다.
    const bs = batches(vs).filter((b) => b.items.length > 1);
    if (bs.length) {
      console.log('\n  [슬롯별 중앙값] 같은 슬롯이 통째로 낮으면 배포 문제다');
      for (const bt of bs.slice(-8)) {
        const v = bt.items.map((x) => x.views);
        console.log(`     ${kst(bt.start)}  n=${v.length}  중앙 ${String(median(v)).padStart(4)}  [${v.join(', ')}]`);
      }
    }
  } else console.log('[유튜브]', yt?.error || '데이터 없음');

  if (ig?.account) {
    console.log(`\n[인스타] @${ig.account.username} · 팔로워 ${ig.account.followers_count} · 게시물 ${ig.account.media_count}`);
    for (const m of ig.media.slice(0, 25)) {
      console.log(
        `  ${String(m.views ?? '-').padStart(5)}뷰 | 도달 ${String(m.reach ?? '-').padStart(4)} | 저장 ${String(m.saved ?? '-').padStart(3)} | 공유 ${String(m.shares ?? '-').padStart(3)} | ♥ ${String(m.likes).padStart(2)} | ${kst(m.timestamp)} ${m.type.padEnd(6)} ${m.caption}`
      );
    }
  } else console.log('\n[인스타]', ig?.error || '데이터 없음');
}
