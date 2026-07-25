// 중앙 설정. .env를 직접 로드한다 (launchd는 셸 env를 상속하지 않으므로 엔트리포인트가 아닌 여기서 로드).
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadEnv({ path: path.join(root, '.env') });

export const paths = {
  root,
  templates: path.join(root, 'templates'),
  out: path.join(root, 'out'),
  bgm: path.join(root, 'assets', 'bgm'),
  data: path.join(root, 'data'),
  db: path.join(root, 'data', 'cardnews.db'),
};

// RSS 피드 (2026-07-23 라이브 검증). allowHttp=true면 http:// 허용.
export const feeds = [
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', region: 'world' },
  { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss', region: 'world' },
  { name: 'Reuters (Google News)', url: 'https://news.google.com/rss/search?q=site:reuters.com&hl=en-US&gl=US&ceid=US:en', region: 'world' },
  { name: 'ZDNet Korea', url: 'https://feeds.feedburner.com/zdkorea', region: 'kr' },
  { name: '전자신문', url: 'https://rss.etnews.com/Section901.xml', region: 'kr' },
  { name: 'AI타임스', url: 'https://www.aitimes.com/rss/allArticle.xml', region: 'kr' },
];

export const account = {
  name: '뉴스한입',
  theme: 'light', // templates/card.html의 theme-light
  handle: '@news.hanip',
};

export const pipeline = {
  digestHour: 9, // 다이제스트 시각
  collectWindowHours: 24, // 최근 N시간 수집분만 후보로
  candidateCount: 6, // curator 1단계: 상위 5~8건
  cardsPerCandidate: { min: 3, max: 4 },
  secondsPerCard: 3.5,
  reelBitrate: { target: '6M', max: '8M' },
};

// AI: Claude Code 구독 인증을 헤드리스로 호출 (API 키 불필요).
// 기본 모델(Fable 5)은 과하므로 --model로 경량 모델 고정: 필터=haiku, 카피=sonnet.
export const claude = {
  bin: process.env.CLAUDE_BIN || 'claude',
  filterModel: 'haiku',
  copyModel: 'sonnet',
};

export const telegram = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
};

export const instagram = {
  userId: process.env.IG_USER_ID,
  accessToken: process.env.IG_ACCESS_TOKEN,
  appSecret: process.env.IG_APP_SECRET,
  apiVersion: 'v25.0',
};

export const r2 = {
  accountId: process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET || 'cardnews-assets',
  publicUrl: process.env.R2_PUBLIC_URL,
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
};

// DRY_RUN=1이면 IG 발행 대신 로컬 저장 + 텔레그램 보고만.
export const dryRun = process.env.DRY_RUN === '1';
