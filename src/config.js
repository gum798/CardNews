// 중앙 설정. .env를 직접 로드한다 (launchd는 셸 env를 상속하지 않으므로 엔트리포인트가 아닌 여기서 로드).
//
// 다계정(프로필) 지원: CARDNEWS_PROFILE 환경변수로 브랜드를 고르고, 계정별 값은
// `<ENVPREFIX>_KEY` 형태의 .env 키에서 읽는다(없으면 접두사 없는 공용 키로 폴백).
// 예) NEWSHANA_IG_ACCESS_TOKEN → 없으면 IG_ACCESS_TOKEN.
// 이렇게 하면 공용 자원(R2·Pixabay·claude)은 한 벌만 두고 계정별 값만 덧붙이면 된다.
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveProfile } from './profiles/index.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadEnv({ path: path.join(root, '.env') });

export const profile = resolveProfile();

// 프로필 접두사 키(`<PREFIX>_KEY`)에서 읽는다.
// 접두사 키가 없을 때 공용 키로 폴백하는 것은 envFallback:true인 프로필만 허용한다.
// (폴백을 전역 허용하면, 자격증명을 아직 안 넣은 새 프로필이 기존 계정 토큰을 집어
//  엉뚱한 계정에 발행해 버린다. 기존 뉴스하나만 기존 .env 호환을 위해 켜 둔다.)
function envFor(key) {
  const prefixed = profile.envPrefix ? process.env[`${profile.envPrefix}_${key}`] : undefined;
  if (prefixed) return prefixed;
  return profile.envFallback ? process.env[key] || undefined : undefined;
}

export const paths = {
  root,
  templates: path.join(root, 'templates'),
  out: path.join(root, 'out'),
  bgm: path.join(root, 'assets', 'bgm'),
  data: path.join(root, 'data'),
  // 프로필별 DB 분리 (후보 번호·발행 한도·중복 방지 상태가 계정끼리 섞이지 않게).
  db: path.join(root, 'data', profile.dbFile || `${profile.key}.db`),
};

export const account = profile.account;

// 주제 스트림 (프로필 정의). 각 주제는 고유 테마(색)와 피드 목록을 가진다.
export const topics = profile.topics;

export const pipeline = {
  collectWindowHours: 14, // 발행 사이클: 최근 N시간 내 미사용 뉴스만 후보로 (직전 실행 이후분 포함)
  perTopicPick: 1, // 주제당 실행마다 1건 선별
  maxPerTopicPerDay: 2, // 자동 발행: 주제별 1일 최대 건수 (하루 2슬롯 = 2건. 중복 실행 안전장치)
  cardsPerCandidate: { min: 3, max: 4 },
  secondsPerCard: 3.5, // (무나레이션 구형 릴스에서만 사용)
  reelBitrate: { target: '6M', max: '8M' },
};

// 나레이션 릴스(포맷 엔진). 정지 카드 슬라이드쇼는 쇼츠에서 1초 안에 스와이프되므로
// TTS 나레이션 + 번인 자막 + 켄번즈 줌으로 교체한다.
// narrated=false면 기존 무음 슬라이드쇼로 폴백.
export const reel = {
  narrated: true,
  voice: process.env.TTS_VOICE || 'Yuna', // macOS `say -v` 음성 (한국어)
  rate: Number(process.env.TTS_RATE || 190), // 말 속도(wpm). 쇼츠는 약간 빠른 편이 낫다.
  linePadSec: 0.32, // 라인 사이 호흡
  targetSec: { min: 20, max: 32 }, // 이 범위를 벗어나면 라인 수를 조정하도록 경고
  scriptLines: { min: 6, max: 9 }, // 훅도 낭독하므로 총 세그먼트는 +1. 라인당 약 2.8초
  bgmVolume: 0.07, // 나레이션 아래 깔리는 BGM 음량
  // 배경으로 Pixabay 실사 영상을 쓴다(자막은 투명 PNG로 위에 오버레이).
  // 실패하면 사진 켄번즈로 자동 폴백하므로 꺼도 동작한다.
  stockVideo: process.env.REEL_STOCK_VIDEO !== '0',
  // 진행자 하나를 인트로/아웃트로에 합성한다. 실패해도 발행은 계속(베스트에포트).
  persona: process.env.REEL_PERSONA !== '0',
};

// 발행 슬롯 + 실패 시 재시도 창. launchd가 target~retryUntilHour 매 정시에 잡을 실행하면,
// 잡은 주제별 "완료" 플래그로 게이팅해 실패한 주제만 다음 정시에 재시도한다.
// target = 정규 발행 시각, retryUntilHour = 그 시각까지 재시도 후 이 슬롯 포기.
export const schedule = { slots: profile.schedule };

// AI: Claude Code 구독 인증을 헤드리스로 호출 (API 키 불필요). 계정 공용.
// 기본 모델(Fable 5)은 과하므로 --model로 경량 모델 고정: 필터=haiku, 카피=sonnet.
export const claude = {
  bin: process.env.CLAUDE_BIN || 'claude',
  filterModel: 'haiku',
  copyModel: 'sonnet',
};

// 텔레그램: 롱 폴링은 토큰당 한 프로세스만 가능하므로 계정마다 별도 봇 토큰을 권장.
// (승인 버튼의 후보 번호가 프로필별 DB를 가리키기 때문에 봇을 공유하면 오조회가 난다.)
export const telegram = {
  botToken: envFor('TELEGRAM_BOT_TOKEN'),
  chatId: envFor('TELEGRAM_CHAT_ID'),
};

export const instagram = {
  userId: envFor('IG_USER_ID'),
  accessToken: envFor('IG_ACCESS_TOKEN'),
  appSecret: envFor('IG_APP_SECRET'),
  apiVersion: 'v25.0',
  // 캐러셀(카드뉴스) 발행 여부. 0이면 카드 렌더·업로드·발행을 모두 건너뛰고 릴스만 올린다.
  carousel: envFor('IG_CAROUSEL') !== '0',
};

// 표지 배경 사진: Pixabay 이미지 API (무료 키, 출처표기 불필요). 계정 공용. 키 없으면 사진 없이 진행.
export const pixabay = {
  key: process.env.PIXABAY_KEY,
};

// 유튜브 쇼츠 자동 업로드 (OAuth). refreshToken 없으면 업로드 건너뜀 (베스트에포트).
// 채널이 다르면 프로필 접두사 키로 별도 토큰을 둔다.
export const youtube = {
  clientId: envFor('YOUTUBE_CLIENT_ID'),
  clientSecret: envFor('YOUTUBE_CLIENT_SECRET'),
  refreshToken: envFor('YOUTUBE_REFRESH_TOKEN'),
  // 올라가야 할 채널. 토큰은 동의 화면에서 고른 채널에 묶이므로, 재인증 때 다른 채널을
  // 고르면 업로드가 계속 성공하면서 엉뚱한 채널에 쌓인다. 매 업로드마다 대조한다.
  channelId: envFor('YOUTUBE_CHANNEL_ID'),
};

// Cloudflare Workers AI — 이미지 생성 무료 경로 (일 10,000뉴런 ≈ 59장).
// flux-2-klein-4b: 레퍼런스 최대 4장(multipart input_image_0..3, 서버가 512px 미만으로 축소),
// 768x1376 세로 실측 통과. PoC(2026-08-13, 30장): 같음14/경계13/다름3.
export const cloudflare = {
  accountId: process.env.R2_ACCOUNT_ID, // R2와 같은 계정 (1번)
  aiToken: process.env.CF_WORKERS_AI_TOKEN,
  imageModel: process.env.CF_IMAGE_MODEL || '@cf/black-forest-labs/flux-2-klein-4b',
  // 무료 뉴런 풀은 계정 단위(일 10,000)라 계정을 늘리면 한도가 늘어난다.
  // 1번(gum, R2와 동일) 소진 시 2번(kon)으로 넘어간다. 순서대로 시도.
  accounts: [
    { accountId: process.env.R2_ACCOUNT_ID, token: process.env.CF_WORKERS_AI_TOKEN },
    { accountId: process.env.CF_ACCOUNT_ID_2, token: process.env.CF_WORKERS_AI_TOKEN_BACKUP },
  ].filter((a) => a.accountId && a.token),
};

// R2는 계정 공용 버킷을 쓰되, 객체 키에 프로필 접두사를 붙여 파일이 섞이지 않게 한다.
export const r2 = {
  accountId: process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET || 'cardnews-assets',
  publicUrl: process.env.R2_PUBLIC_URL,
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  // 기존 프로필은 '' (기존 URL 유지), 신규 프로필은 '<key>'.
  keyPrefix: profile.r2Prefix ?? profile.key,
};

// DRY_RUN=1이면 IG 발행 대신 로컬 저장 + 텔레그램 보고만. (프로필별로 다르게 둘 수 있음)
export const dryRun = envFor('DRY_RUN') === '1';

// AUTO_PUBLISH=1이면 잡이 일일 한도 내에서 승인 없이 자동 발행 (초과분은 텔레그램 수동 승인).
export const autoPublish = envFor('AUTO_PUBLISH') === '1';
