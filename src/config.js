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
  secondsPerCard: 3.5,
  reelBitrate: { target: '6M', max: '8M' },
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
