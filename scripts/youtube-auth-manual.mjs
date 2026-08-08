// 브라우저를 이 맥에서 못 여는 상황(외부에 있을 때)용 유튜브 재인증.
//
// youtube-auth.mjs는 localhost:5858로 리다이렉트를 받아야 해서 폰으로는 안 된다.
// 이 스크립트는 그 왕복을 사람이 대신한다:
//   1) 인자 없이 실행 → 승인 URL 출력. 폰 브라우저에서 열어 승인.
//   2) 승인 후 「사이트에 연결할 수 없음」 페이지로 떨어지는데, 주소창에 code=... 가 있다.
//   3) node scripts/youtube-auth-manual.mjs --code <그 코드>  → refresh_token 발급.
//
// ⚠️ code는 1회용이고 몇 분 안에 만료된다. 실패하면 1)부터 다시.
import { auth as gauth, youtube as makeYoutube } from '@googleapis/youtube';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadEnv({ path: path.join(root, '.env') });

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT = 'http://localhost:5858/callback';
const WANT = process.env.YOUTUBE_CHANNEL_ID;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('먼저 .env에 YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET를 넣으세요.');
  process.exit(1);
}

const oauth2 = new gauth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const codeIdx = process.argv.indexOf('--code');
const code = codeIdx > 0 ? process.argv[codeIdx + 1] : null;

if (!code) {
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    // select_account를 같이 줘야 계정·채널 선택 화면이 다시 뜬다.
    // consent만 주면 예전에 고른 채널이 그대로 재사용된다 — 이번 사고의 원인이다.
    prompt: 'consent select_account',
    scope: SCOPES,
  });
  console.log('\n① 폰 브라우저에서 아래 URL을 여세요:\n');
  console.log(url);
  console.log('\n② 계정 선택 → **채널 선택 화면에서 「뉴스하나」를 고르세요** (개인 채널 아님)');
  console.log('③ 승인하면 「사이트에 연결할 수 없음」 페이지가 뜹니다. 정상입니다.');
  console.log('   주소창의 code=... 부분을 복사하세요 (&scope= 앞까지).');
  console.log('④ node scripts/youtube-auth-manual.mjs --code <복사한코드>\n');
  process.exit(0);
}

try {
  const { tokens } = await oauth2.getToken(decodeURIComponent(code));
  oauth2.setCredentials(tokens);

  // 토큰을 .env에 넣기 전에 어느 채널에 묶였는지 반드시 확인한다.
  let bound = null;
  try {
    const api = makeYoutube({ version: 'v3', auth: oauth2 });
    const r = await api.channels.list({ part: ['snippet'], mine: true });
    const c = r.data.items?.[0];
    if (c) bound = { id: c.id, title: c.snippet.title };
  } catch (e) {
    console.log('⚠️ 채널 확인 실패:', String(e.message).slice(0, 120));
  }

  if (bound) {
    console.log(`\n이 토큰이 묶인 채널: 【${bound.title}】  ${bound.id}`);
    if (WANT && bound.id !== WANT) {
      console.log(`\n❌ 기대한 채널이 아닙니다 (기대: ${WANT} = 뉴스하나)`);
      console.log('   이 토큰을 쓰면 또 엉뚱한 채널로 올라갑니다. .env에 넣지 마세요.');
      console.log('   처음부터 다시 하되, 채널 선택 화면에서 「뉴스하나」를 고르세요.\n');
      process.exit(1);
    }
    console.log('✅ 채널이 맞습니다.\n');
  }

  if (!tokens.refresh_token) {
    console.log('\n⚠️ refresh_token이 안 나왔습니다.');
    console.log('   폰에서 Google 계정 → 보안 → 서드파티 앱/서비스 → 이 앱 액세스 삭제 후 다시 하세요.\n');
    process.exit(1);
  }

  console.log('=== .env의 YOUTUBE_REFRESH_TOKEN을 아래로 교체 ===');
  console.log('YOUTUBE_REFRESH_TOKEN=' + tokens.refresh_token);
  console.log('================================================\n');
} catch (e) {
  console.error('\n토큰 교환 실패:', String(e?.message || e).slice(0, 200));
  console.error('code는 1회용이고 몇 분이면 만료됩니다. URL 발급부터 다시 하세요.\n');
  process.exit(1);
}
