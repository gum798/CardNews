// 「서정화」 채널에 잘못 올라간 쇼츠를 지운다. yt-remap.mjs로 옮긴 뒤에 쓴다.
//
// ⚠️ 삭제는 youtube.force-ssl 스코프가 필요하고(우리 상시 토큰은 upload+readonly),
//    게다가 그 토큰은 지금 「뉴스하나」에 묶여 있어 남의 채널 영상을 못 지운다.
//    그래서 이 스크립트만 쓰는 임시 토큰을 따로 받는다.
//    ⚠️ 임시 토큰은 .env에 저장하지 않는다. 상시 토큰을 덮어쓰면 발행이 또 깨진다.
//
// 사용:
//   node scripts/yt-delete-old.mjs             승인 URL 출력 (폰에서 열기)
//   node scripts/yt-delete-old.mjs --code <코드>   교환 후 삭제
//   node scripts/yt-delete-old.mjs --code <코드> --dry   지울 목록만 확인
import '../src/config.js';
import { auth as gauth, youtube as makeYoutube } from '@googleapis/youtube';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../src/config.js';

const REDIRECT = 'http://localhost:5858/callback';
const WRONG_CHANNEL = 'UCKth56DDR94vq_f9OY8CrFw'; // 서정화 — 여기서만 지운다
const STATE = path.join(paths.out, 'yt-remap-state.json');

const oauth2 = new gauth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  REDIRECT
);

const i = process.argv.indexOf('--code');
const code = i > 0 ? process.argv[i + 1] : null;
const dry = process.argv.includes('--dry');

if (!code) {
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    // force-ssl이 있어야 videos.delete가 된다. upload/readonly로는 403.
    scope: ['https://www.googleapis.com/auth/youtube.force-ssl'],
  });
  console.log('\n① 폰에서 아래 URL을 여세요:\n');
  console.log(url);
  console.log('\n② 채널 선택에서 이번엔 「서정화」를 고르세요 (지울 영상이 있는 쪽)');
  console.log('③ 「사이트에 연결할 수 없음」 페이지의 주소창에서 code= 값을 복사');
  console.log('④ node scripts/yt-delete-old.mjs --code <복사한코드>\n');
  process.exit(0);
}

// 옮긴 기록이 있어야 지운다. 재업로드 안 된 걸 지우면 영상이 사라진다.
if (!existsSync(STATE)) {
  console.error('out/yt-remap-state.json이 없습니다. 먼저 yt-remap.mjs --run 으로 옮기세요.');
  process.exit(1);
}
const moved = JSON.parse(readFileSync(STATE, 'utf8')); // { 옛ID: 새ID }
const targets = Object.keys(moved);

const { tokens } = await oauth2.getToken(decodeURIComponent(code));
oauth2.setCredentials(tokens); // ⚠️ .env에 쓰지 않는다
const api = makeYoutube({ version: 'v3', auth: oauth2 });

const me = await api.channels.list({ part: ['snippet'], mine: true });
const ch = me.data.items?.[0];
console.log(`\n이 토큰이 묶인 채널: 【${ch?.snippet?.title}】 ${ch?.id}`);
if (ch?.id !== WRONG_CHANNEL) {
  console.error(`\n❌ 「서정화」(${WRONG_CHANNEL})가 아닙니다. 엉뚱한 채널의 영상을 지울 뻔했습니다.`);
  console.error('   처음부터 다시 하되 채널 선택에서 「서정화」를 고르세요.\n');
  process.exit(1);
}

console.log(`\n삭제 대상 ${targets.length}건 (모두 「뉴스하나」로 옮긴 것이 확인된 영상):`);
for (const old of targets) console.log(`  https://youtu.be/${old}  →  옮긴 곳 https://youtu.be/${moved[old]}`);

if (dry) {
  console.log('\n--dry 모드입니다. 실제로 지우려면 --dry 를 빼세요.\n');
  process.exit(0);
}

let ok = 0;
for (const old of targets) {
  try {
    await api.videos.delete({ id: old });
    console.log(`🗑  삭제 완료 ${old}`);
    ok++;
  } catch (e) {
    const msg = String(e?.message || e);
    // 이미 지웠거나 존재하지 않으면 성공으로 친다.
    if (/not found|videoNotFound/i.test(msg)) {
      console.log(`⏭  ${old} — 이미 없음`);
      ok++;
    } else {
      console.error(`❌ ${old} — ${msg.slice(0, 140)}`);
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(`\n완료: ${ok}/${targets.length}건 삭제\n`);
process.exit(0);
