// 발행 정책 가드.
// AI 생성 페르소나가 뉴스를 전달하면 두 가지 위험이 생긴다:
//   1) 공직선거법 제82조의8 — 선거일 전 90일부터 선거일까지, AI로 만든
//      "실제와 구분하기 어려운" 영상으로 선거운동을 하면 진위 불문 금지.
//      최대 7년 이하 징역 또는 5천만원 벌금. 사실이었다는 항변이 통하지 않는다.
//   2) 유튜브 "민감한 주제 AI 페르소나" — AI 생성 인물이 건강·법률·재무·정치에 대해
//      인간 전문가처럼 조언을 제시하면 수익화가 막힌다.
//
// 두 경우 모두 사후 대응이 불가능하므로 발행 전에 차단한다.

// ⚠️ 선거일은 확정 시 갱신할 것. 아래는 법정 예정일 기준이며 검증 필요.
export const ELECTIONS = [
  { name: '제21대 대통령선거', date: '2027-03-03' },
  { name: '제23대 국회의원선거', date: '2028-04-12' },
  { name: '제10회 전국동시지방선거', date: '2030-06-12' },
];

const DAY = 86_400_000;
const BLACKOUT_DAYS = 90;

// 지금이 어떤 선거의 D-90 기간인지. 아니면 null.
export function activeBlackout(now = new Date()) {
  for (const e of ELECTIONS) {
    const d = new Date(`${e.date}T23:59:59+09:00`).getTime();
    const start = d - BLACKOUT_DAYS * DAY;
    if (now.getTime() >= start && now.getTime() <= d) {
      return { ...e, daysLeft: Math.ceil((d - now.getTime()) / DAY) };
    }
  }
  return null;
}

// 선거·정치 관련 신호. 블랙아웃 기간에만 적용한다(평시엔 정치 뉴스 자체는 허용).
const POLITICAL = [
  '선거', '후보', '출마', '공천', '유세', '투표', '개표', '득표', '경선',
  '대선', '총선', '지방선거', '재보궐', '党', '정당', '여당', '야당',
  '국민의힘', '더불어민주당', '조국혁신당', '개혁신당', '진보당',
  '대통령', '국회의원', '시장', '도지사', '교육감', '지지율', '여론조사',
];

// 유튜브가 지정한 민감 주제에서 "전문가 조언"으로 읽힐 수 있는 표현.
// 사실 전달은 괜찮지만 권고·전망·지시는 안 된다.
const ADVICE_PATTERNS = [
  /하세요/, /해야\s*합니다/, /하시길/, /권장합니다/, /추천(합니다|드립니다|해요)/,
  /전망됩니다/, /예상됩니다/, /유망/, /수혜주/, /매수/, /매도/, /投資/,
  /투자하/, /갈아타/, /지금이\s*기회/, /사두/, /담아두/,
  /복용하/, /드셔야/, /효과가\s*있습니다/, /치료됩니다/, /낫습니다/,
  /소송/, /고소하/, /합법입니다/, /불법입니다/,
];

// 민감 주제 판정용 키워드 (건강·법률·재무·정치)
const SENSITIVE = [
  '금리', '주식', '코스피', '코스닥', '투자', '펀드', '연금', '보험', '대출', '부동산', '세금', '환율', '가상자산', '코인',
  '질병', '치료', '약물', '백신', '증상', '진단', '의료', '건강기능식품',
  '판결', '소송', '법률', '변호사', '처벌', '형량',
  ...POLITICAL,
];

const has = (text, list) => list.some((k) => (k instanceof RegExp ? k.test(text) : text.includes(k)));

// 뉴스 후보를 발행 대상에서 제외해야 하는지. 사유 문자열 또는 null.
export function blockedReason(newsItem, now = new Date()) {
  const text = `${newsItem?.title ?? ''} ${newsItem?.summary ?? ''}`;
  const blackout = activeBlackout(now);
  if (blackout && has(text, POLITICAL)) {
    return `선거 블랙아웃(${blackout.name} D-${blackout.daysLeft}) — 정치 소재 제외`;
  }
  return null;
}

// 후보 목록에서 차단 대상을 걸러낸다. { kept, dropped } 반환.
export function filterCandidates(items, now = new Date()) {
  const kept = [];
  const dropped = [];
  for (const it of items) {
    const reason = blockedReason(it, now);
    if (reason) dropped.push({ item: it, reason });
    else kept.push(it);
  }
  return { kept, dropped };
}

// 생성된 대본이 "전문가 조언"으로 읽히는지 검사. 문제 있으면 사유 배열, 없으면 [].
// 민감 주제일 때만 엄격하게 본다 — 일반 소재까지 막으면 대본이 밋밋해진다.
export function scriptViolations(cardData) {
  const script = cardData?.script;
  if (!script) return [];

  const all = [
    script.hook,
    ...(script.lines || []),
    ...(script.checklist?.items || []),
    script.checklist?.title,
  ]
    .filter(Boolean)
    .join(' ');

  if (!has(all, SENSITIVE)) return []; // 민감 주제 아님 → 통과

  const hits = ADVICE_PATTERNS.filter((p) => p.test(all)).map((p) => String(p));
  if (!hits.length) return [];
  return [`민감 주제(건강·법률·재무·정치)에서 조언성 표현 검출: ${hits.slice(0, 4).join(', ')}`];
}

// 대본 재생성을 요구할 때 프롬프트에 덧붙일 지시문.
export const ADVICE_GUARD_PROMPT =
  '\n\n[⚠️ 필수 수정] 이 소재는 건강·법률·재무·정치 중 하나에 해당합니다. ' +
  'AI가 만든 인물이 전문가처럼 조언하는 것으로 읽히면 플랫폼 정책 위반입니다.\n' +
  '- 권고·지시·전망 표현을 모두 제거하세요: 「~하세요」, 「~해야 합니다」, 「추천」, ' +
  '「전망됩니다」, 「투자」, 「매수」, 「효과가 있습니다」 등\n' +
  '- 사실 전달과 출처 인용만 남기세요. 판단은 시청자에게 맡기는 문장으로 바꾸세요.\n' +
  '- 체크리스트도 "무엇을 하라"가 아니라 "무엇을 확인할 수 있다" 형태로 바꾸세요.\n' +
  '  예: 「지금 갈아타세요」 → 「내 조건이 해당되는지 확인해볼 수 있어요」';
