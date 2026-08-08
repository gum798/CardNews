// 잘못된 채널에 올라간 쇼츠를 올바른 채널로 다시 올린다.
//
// 유튜브는 채널 간 영상 이동을 지원하지 않는다. 재업로드가 유일한 방법이고,
// 원본은 사람이 Studio에서 지워야 한다(삭제에는 youtube.force-ssl 스코프가 필요한데,
// 우리 토큰은 upload+readonly만 갖고 있고 게다가 지금은 새 채널에 묶여 있다).
//
// 사용:
//   node scripts/yt-remap.mjs --plan          대상만 출력 (업로드 안 함)
//   node scripts/yt-remap.mjs --run           실제 재업로드
import '../src/config.js';
import Database from 'better-sqlite3';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { paths, youtube as yt } from '../src/config.js';
import { uploadShort } from '../src/youtube/index.js';

const STATE = path.join(paths.out, 'yt-remap-state.json');

// 8/3 재인증 이후 「서정화」로 올라간 영상들(로그에서 추출).
const WRONG_IDS = [
  'HhHWoSlBDdA', 'vF_DmAGvhO4', '6pPv-RlQmDk', 'zhZaqRDWxC4', '2gmFGJzGv04',
  'vnkEeaVwN-o', 'cHMoxWGTZf4', 'mXVkC7C0ybU', 'Nsk7ppGSZ5U',
];

const db = new Database(path.join(paths.root, 'data', 'cardnews.db'), { readonly: true });

function candidates() {
  return db
    .prepare('SELECT id, card_json FROM candidates WHERE card_json IS NOT NULL AND id BETWEEN 85 AND 120')
    .all()
    .map((c) => {
      try {
        const j = JSON.parse(c.card_json);
        return {
          id: c.id,
          headline: j.cards.find((x) => x.type === 'cover')?.card?.headline || '',
          caption: j.caption || '',
          topic: j.theme || '',
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function titleOf(vid) {
  const r = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}&format=json`,
    { signal: AbortSignal.timeout(15_000) }
  );
  if (!r.ok) return null;
  const j = await r.json();
  return { title: String(j.title).replace(/ #Shorts$/, ''), channel: j.author_name };
}

const cands = candidates();
const plan = [];
for (const vid of WRONG_IDS) {
  const meta = await titleOf(vid);
  if (!meta) {
    console.log(`⚠️  ${vid}: 조회 실패(이미 삭제됨?) → 건너뜀`);
    continue;
  }
  const c = cands.find((x) => x.headline === meta.title);
  const file = c ? path.join(paths.out, String(c.id), 'reel.mp4') : null;
  if (!c || !existsSync(file)) {
    console.log(`⚠️  ${vid}: 원본 mp4를 못 찾음 (${meta.title.slice(0, 28)}) → 건너뜀`);
    continue;
  }
  plan.push({ vid, cand: c.id, title: meta.title, caption: c.caption, file, channel: meta.channel });
}

console.log(`\n대상 ${plan.length}건 (원본 채널 기준)`);
for (const p of plan) console.log(`  ${p.vid} 【${p.channel}】 cand ${p.cand}  ${p.title.slice(0, 34)}`);

if (!process.argv.includes('--run')) {
  console.log('\n--plan 모드입니다. 실제 업로드하려면 --run 을 붙이세요.\n');
  process.exit(0);
}

// 이미 옮긴 건 건너뛴다 — 중간에 끊겨도 다시 돌릴 수 있어야 한다.
let done = {};
if (existsSync(STATE)) {
  try {
    done = JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {}
}

console.log(`\n→ 「뉴스하나」(${yt.channelId})로 재업로드 시작\n`);
for (const p of plan) {
  if (done[p.vid]) {
    console.log(`⏭  ${p.title.slice(0, 30)} — 이미 옮김 (${done[p.vid]})`);
    continue;
  }
  try {
    const newId = await uploadShort({
      videoPath: p.file,
      title: p.title,
      description: p.caption,
      tags: ['뉴스', '오늘의뉴스', '쇼츠', 'shorts'],
    });
    if (!newId) throw new Error('업로드가 null을 반환(채널 가드 또는 자격증명 문제)');
    done[p.vid] = newId;
    writeFileSync(STATE, JSON.stringify(done, null, 2));
    console.log(`✅ ${p.title.slice(0, 30)}\n     옛것 https://youtu.be/${p.vid} (삭제 대상)\n     새것 https://youtu.be/${newId}`);
  } catch (e) {
    console.error(`❌ ${p.title.slice(0, 30)} — ${String(e.message).slice(0, 160)}`);
  }
  // 연속 업로드로 할당량·속도 제한에 걸리지 않게 사이를 둔다.
  await new Promise((r) => setTimeout(r, 5000));
}

console.log(`\n완료: ${Object.keys(done).length}/${plan.length}건`);
console.log('삭제 대상 목록은 out/yt-remap-state.json 의 키(옛 영상 ID)입니다.');
process.exit(0);
