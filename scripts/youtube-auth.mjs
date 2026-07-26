// 유튜브 업로드용 refresh_token을 1회 발급받는 헬퍼.
// 사전: .env에 YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET 입력 (Google Cloud OAuth "데스크톱 앱" 자격증명).
// 실행: node scripts/youtube-auth.mjs → 출력된 URL 열어 승인 → refresh_token이 터미널에 출력됨 → .env에 붙여넣기.
import { auth as gauth } from '@googleapis/youtube';
import http from 'node:http';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadEnv({ path: path.join(root, '.env') });

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const PORT = 5858;
const REDIRECT = `http://localhost:${PORT}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('먼저 .env에 YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET를 넣으세요.');
  process.exit(1);
}

const oauth2 = new gauth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline', // refresh_token을 받으려면 필수
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/youtube.upload'],
});

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/callback')) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) {
    res.end('code 없음');
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.end('✅ 인증 완료! 터미널로 돌아가세요.');
    console.log('\n=== .env에 아래 줄을 추가/수정하세요 ===');
    console.log('YOUTUBE_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('=====================================\n');
    if (!tokens.refresh_token) {
      console.log('⚠️ refresh_token이 안 나왔으면: Google 계정 → 보안 → 서드파티 액세스에서 이 앱 제거 후 다시 실행하세요.');
    }
    server.close();
    process.exit(0);
  } catch (e) {
    res.end('실패: ' + e.message);
    console.error(e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\n브라우저에서 아래 URL을 열어 유튜브 채널 계정으로 승인하세요:\n');
  console.log(authUrl + '\n');
  console.log('(승인하면 자동 리다이렉트되며 refresh token이 여기 출력됩니다)');
});
