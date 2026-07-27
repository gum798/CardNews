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

export const account = {
  name: '뉴스하나',
  handle: '@newshana.daily',
};

// 3개 주제 스트림. 각 주제는 고유 테마(색)와 피드 목록을 가진다.
// evergreen: 최신 뉴스가 없을 때 AI가 만들 폴백 카드의 성격.
export const topics = {
  general: {
    label: '일반뉴스',
    theme: 'grad-blue',
    ytCategory: '25', // News & Politics
    evergreen: '오늘 알아두면 좋은 시사·경제 상식이나 뉴스를 똑똑하게 읽는 팁',
    feeds: [
      { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' },
      { name: 'Reuters', url: 'https://news.google.com/rss/search?q=site:reuters.com&hl=en-US&gl=US&ceid=US:en' },
      { name: '전자신문', url: 'https://rss.etnews.com/Section901.xml' },
    ],
  },
  topic: {
    label: '재밌는토픽',
    theme: 'bold',
    ytCategory: '24', // Entertainment
    evergreen: '흥미로운 상식·기네스 기록·다가오는 이색 이벤트 등 가볍고 재밌는 이야기',
    feeds: [
      { name: 'Google뉴스 화제', url: 'https://news.google.com/rss/search?q=%ED%99%94%EC%A0%9C&hl=ko&gl=KR&ceid=KR:ko' },
      { name: 'Google뉴스 이색', url: 'https://news.google.com/rss/search?q=%EC%9D%B4%EC%83%89&hl=ko&gl=KR&ceid=KR:ko' },
      { name: 'UPI Odd', url: 'http://rss.upi.com/news/odd_news.rss' },
    ],
  },
  ai: {
    label: 'AI뉴스',
    theme: 'grad-green',
    ytCategory: '28', // Science & Technology
    evergreen: '실생활·업무에 바로 쓰는 AI 활용 팁이나 알아두면 좋은 AI 개념',
    feeds: [
      { name: 'AI타임스', url: 'https://www.aitimes.com/rss/allArticle.xml' },
      { name: 'ZDNet Korea', url: 'https://feeds.feedburner.com/zdkorea' },
      { name: 'Google뉴스 AI', url: 'https://news.google.com/rss/search?q=AI%20%EC%9D%B8%EA%B3%B5%EC%A7%80%EB%8A%A5&hl=ko&gl=KR&ceid=KR:ko' },
    ],
  },
};

export const pipeline = {
  collectWindowHours: 14, // 발행 사이클: 최근 N시간 내 미사용 뉴스만 후보로 (직전 실행 이후분 포함)
  perTopicPick: 1, // 주제당 실행마다 1건 선별
  maxPerTopicPerDay: 2, // 자동 발행: 주제별 1일 최대 건수 (08시·19시 = 2건. 중복 실행 안전장치)
  cardsPerCandidate: { min: 3, max: 4 },
  secondsPerCard: 3.5,
  reelBitrate: { target: '6M', max: '8M' },
};

// 발행 슬롯 + 실패 시 재시도 창. launchd가 target~retryUntilHour 매 정시에 잡을 실행하면,
// 잡은 주제별 "완료" 플래그로 게이팅해 실패한 주제만 다음 정시에 재시도한다.
// target = 정규 발행 시각, retryUntilHour = 그 시각까지 재시도 후 이 슬롯 포기.
export const schedule = {
  slots: {
    morning: { target: 6, retryUntilHour: 11 }, // 오전 6시, 실패 시 11시까지 매시간 재시도
    evening: { target: 18, retryUntilHour: 23 }, // 오후 6시, 실패 시 23시까지 매시간 재시도
  },
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

// 표지 배경 사진: Pixabay 이미지 API (무료 키, 출처표기 불필요). 키 없으면 사진 없이 진행.
export const pixabay = {
  key: process.env.PIXABAY_KEY,
};

// 유튜브 쇼츠 자동 업로드 (OAuth). refreshToken 없으면 업로드 건너뜀 (베스트에포트).
// 심사 전 프로젝트는 업로드가 비공개로 잠김 → 심사 통과 후 공개.
export const youtube = {
  clientId: process.env.YOUTUBE_CLIENT_ID,
  clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
  refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
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

// AUTO_PUBLISH=1이면 매시간 잡이 일일 한도 내에서 승인 없이 자동 발행 (초과분은 텔레그램 수동 승인).
export const autoPublish = process.env.AUTO_PUBLISH === '1';
