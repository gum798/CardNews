// 프로필 레지스트리. 계정(브랜드)마다 파일 하나.
// 실행 시 CARDNEWS_PROFILE 환경변수로 선택하고, 없으면 DEFAULT_PROFILE.
//
// 새 계정 추가 방법:
//   1) src/profiles/<key>.js 를 newshana.js 형태로 작성 (key·envPrefix·account·topics·schedule)
//   2) 아래 registry에 import 후 등록
//   3) .env에 `<ENVPREFIX>_IG_USER_ID` 등 접두사 키 추가
//   4) launchd plist를 프로필용으로 하나 더 만들고 EnvironmentVariables에 CARDNEWS_PROFILE 지정
import newshana from './newshana.js';
import healthhana from './healthhana.js';

export const profiles = {
  [newshana.key]: newshana,
  [healthhana.key]: healthhana,
};

export const DEFAULT_PROFILE = newshana.key;

export function resolveProfile(key = process.env.CARDNEWS_PROFILE) {
  const name = key || DEFAULT_PROFILE;
  const p = profiles[name];
  if (!p) {
    throw new Error(
      `알 수 없는 프로필: '${name}'. 사용 가능: ${Object.keys(profiles).join(', ')} ` +
        `(CARDNEWS_PROFILE 환경변수로 지정)`
    );
  }
  return p;
}
