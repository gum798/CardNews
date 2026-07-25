// AI 필터·랭킹 + 카드 카피. Claude Code 구독 인증을 헤드리스로 호출 (API 키 불필요).
// claude -p "<프롬프트>" --output-format json → 결과 JSON의 result 필드에 모델 답변 텍스트.
// 모델에게 "JSON만 출력"을 지시하고, result 텍스트를 JSON.parse 한다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claude, account, pipeline } from '../config.js';

const execFileAsync = promisify(execFile);

const KOREAN_DOW = ['일', '월', '화', '수', '목', '금', '토'];

// 오늘 날짜를 "2026.07.25 (토)" 형식으로. 로컬 시각 기준.
function todayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd} (${KOREAN_DOW[d.getDay()]})`;
}

// 모델 답변에서 마크다운 코드펜스(```json ... ```)를 벗겨 순수 JSON 텍스트만 남긴다.
function stripFences(text) {
  const t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return (fence ? fence[1] : t).trim();
}

// claude CLI를 실행해 result 텍스트를 JSON.parse. 파싱 실패 시 1회 재시도.
async function askClaudeJson(prompt) {
  const run = async (p) => {
    const { stdout } = await execFileAsync(
      claude.bin,
      ['-p', p, '--output-format', 'json'],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
    );
    // --output-format json은 실행 메타를 감싼 객체. 모델 답변은 result 문자열 필드.
    const outer = JSON.parse(stdout);
    const resultText = typeof outer === 'string' ? outer : outer.result;
    if (typeof resultText !== 'string') throw new Error('claude 응답에 result 문자열이 없음');
    return JSON.parse(stripFences(resultText));
  };

  try {
    return await run(prompt);
  } catch (e) {
    // 파싱 실패 등: 프롬프트에 JSON 강제 지시를 붙여 1회 재시도.
    return await run(`${prompt}\n\nReturn ONLY valid JSON, no prose.`);
  }
}

// 1단계: 최근 수집 뉴스 목록에서 카드뉴스 적합도 상위 후보를 선별·랭킹.
// newsItems: [{ id, source, title, summary }] → [{ newsItemId, rank, reason }]
export async function filterAndRank(newsItems) {
  if (!Array.isArray(newsItems) || newsItems.length === 0) return [];

  const list = newsItems.map((n) => ({
    id: n.id,
    source: n.source,
    title: n.title,
    summary: n.summary ?? '',
  }));

  const n = pipeline.candidateCount;
  const prompt =
    `당신은 한국어 카드뉴스 편집자입니다. 아래 뉴스 목록에서 카드뉴스로 만들 최적의 뉴스를 골라 순위를 매기세요.\n` +
    `선정 기준: 뉴스 가치가 높고, 시각적으로 풀어낼 수 있으며, 서로 중복되지 않는 것. 국내(kr)와 세계(world) 뉴스의 균형을 맞추세요.\n` +
    `최대 ${n}건을 rank 1부터 순서대로 고르고, 각 건마다 한 줄짜리 한국어 선정 사유를 다세요.\n\n` +
    `뉴스 목록(JSON):\n${JSON.stringify(list)}\n\n` +
    `아래 형식의 JSON 배열만 출력하세요(다른 텍스트 금지):\n` +
    `[{"newsItemId": <id>, "rank": 1, "reason": "한 줄 사유"}]`;

  const parsed = await askClaudeJson(prompt);
  const arr = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(arr)) throw new Error('filterAndRank: 배열 응답 아님');

  const validIds = new Set(list.map((x) => x.id));
  return arr
    .filter((x) => x && validIds.has(x.newsItemId))
    .slice(0, n)
    .map((x, i) => ({
      newsItemId: x.newsItemId,
      rank: Number.isFinite(x.rank) ? x.rank : i + 1,
      reason: String(x.reason ?? ''),
    }));
}

// 저작권/독창성 규칙 — 카드 작성 프롬프트 시스템부에 고정.
const COPYRIGHT_RULES =
  `저작권/독창성 규칙(반드시 준수):\n` +
  `- 사실만 자기 표현으로 재작성한다.\n` +
  `- 원문 문장 복사 금지.\n` +
  `- 자체 인사이트 한 줄 포함.\n` +
  `- 출처 매체명 필수.\n` +
  `- 원문 사진 미사용.`;

// 카드별 필수 필드 검증. 통과하면 true.
function validCards(cards) {
  if (!Array.isArray(cards)) return false;
  const { min, max } = pipeline.cardsPerCandidate;
  if (cards.length < min || cards.length > max) return false;
  if (cards[0]?.type !== 'cover') return false;
  if (cards[cards.length - 1]?.type !== 'last') return false;

  const bodyCount = cards.filter((c) => c.type === 'body').length;
  if (bodyCount < 1 || bodyCount > 2) return false;

  for (const c of cards) {
    const k = c?.card;
    if (!k || typeof k !== 'object') return false;
    if (c.type === 'cover') {
      if (!k.category || !k.headline || !k.sub) return false;
    } else if (c.type === 'body') {
      if (!k.kicker || !k.title || !k.text) return false;
      if (k.stat != null && (!k.stat.value || !k.stat.label)) return false;
    } else if (c.type === 'last') {
      if (!k.summary || !k.insight) return false;
    } else {
      return false;
    }
  }
  return true;
}

// 2단계: 후보 뉴스 1건 → 카드 텍스트 + 캡션 생성.
// newsItem: { id, source, title, summary, url } → { account, date, source, cards, caption }
export async function writeCards(newsItem) {
  const { min, max } = pipeline.cardsPerCandidate;

  const prompt =
    `${COPYRIGHT_RULES}\n\n` +
    `당신은 한국어 카드뉴스 카피라이터입니다. 아래 뉴스로 인스타그램 카드뉴스 텍스트를 작성하세요.\n\n` +
    `뉴스:\n` +
    `- 출처: ${newsItem.source}\n` +
    `- 제목: ${newsItem.title}\n` +
    `- 요약: ${newsItem.summary ?? ''}\n\n` +
    `카드 구성: 표지(cover) 1장 + 본문(body) 1~2장 + 마무리(last) 1장, 총 ${min}~${max}장.\n` +
    `각 카드 스키마:\n` +
    `- cover: {"type":"cover","card":{"category":"분류","headline":"후킹 헤드라인","sub":"부제"}}\n` +
    `- body:  {"type":"body","card":{"kicker":"소제목","title":"핵심 제목","text":"핵심 사실 본문","stat":{"value":"수치","label":"수치 설명"}}}  (stat은 수치가 있을 때만, 선택)\n` +
    `- last:  {"type":"last","card":{"summary":"한 줄 요약","insight":"자체 인사이트 한 줄"}}\n\n` +
    `caption: 인스타그램 캡션. 앞부분에 검색 키워드를 넣고, 해시태그 3~5개를 포함.\n\n` +
    `아래 형식의 JSON 객체만 출력하세요(다른 텍스트 금지):\n` +
    `{"cards":[...], "caption":"..."}`;

  let parsed = await askClaudeJson(prompt);
  if (!validCards(parsed?.cards)) {
    // 스키마 불일치: 1회 재시도.
    parsed = await askClaudeJson(
      `${prompt}\n\n앞선 응답이 스키마와 맞지 않았습니다. 스키마를 정확히 지켜 다시 출력하세요.`
    );
    if (!validCards(parsed?.cards)) {
      throw new Error(`writeCards: 카드 스키마 검증 실패 (newsItemId=${newsItem.id})`);
    }
  }

  return {
    account: account.name,
    date: todayStr(),
    source: `출처: ${newsItem.source}`,
    cards: parsed.cards,
    caption: String(parsed.caption ?? ''),
  };
}
