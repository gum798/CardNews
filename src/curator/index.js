// AI 필터·랭킹 + 카드 카피. Claude Code 구독 인증을 헤드리스로 호출 (API 키 불필요).
// claude -p "<프롬프트>" --output-format json → 결과 JSON의 result 필드에 모델 답변 텍스트.
// 모델에게 "JSON만 출력"을 지시하고, result 텍스트를 JSON.parse 한다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claude, account, pipeline, topics, reel as reelCfg } from '../config.js';

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
async function askClaudeJson(prompt, model) {
  // 문자열 값 안의 큰따옴표가 JSON을 깨뜨리는 흔한 실패를 방지하는 규칙.
  const RULE =
    '\n\n[출력 규칙] 오직 유효한 JSON만 출력하세요(코드펜스·설명 금지). ' +
    'JSON 문자열 값 안에서 인용이 필요하면 큰따옴표(") 대신 홑따옴표(\') 또는 「」를 쓰세요.';

  const run = async (p) => {
    const args = ['-p', p, '--output-format', 'json'];
    if (model) args.push('--model', model);
    const exec = execFileAsync(claude.bin, args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    // claude -p는 stdin을 3초 기다린 뒤 진행("no stdin data received in 3s") → 즉시 닫아 지연 제거.
    exec.child?.stdin?.end();
    const { stdout } = await exec;
    // --output-format json은 실행 메타를 감싼 객체. 모델 답변은 result 문자열 필드.
    // CLI가 봉투 대신 평문 오류를 뱉는 경우가 있어(예: 'No skill found…') 원문을 오류에 남긴다.
    let outer;
    try {
      outer = JSON.parse(stdout);
    } catch {
      throw new Error(`claude CLI가 JSON 봉투를 반환하지 않음: ${String(stdout).slice(0, 200)}`);
    }
    const resultText = typeof outer === 'string' ? outer : outer.result;
    if (typeof resultText !== 'string') throw new Error('claude 응답에 result 문자열이 없음');
    return JSON.parse(stripFences(resultText));
  };

  // CLI의 일시적 오류(평문 응답 등)는 즉시 재시도해도 같은 결과가 나오므로 백오프를 둔다.
  const RETRY = [
    { suffix: '', waitMs: 0 },
    { suffix: '\n\n직전 응답이 유효한 JSON이 아니었습니다. 규칙을 지켜 다시 출력하세요.', waitMs: 5_000 },
    { suffix: '\n\n반드시 유효한 JSON 하나만 출력하세요.', waitMs: 20_000 },
  ];
  let lastErr;
  for (const { suffix, waitMs } of RETRY) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    try {
      return await run(prompt + RULE + suffix);
    } catch (e) {
      lastErr = e;
      console.warn(`[curator] claude 호출 실패(재시도 예정): ${e.message}`);
    }
  }
  throw lastErr;
}

// 1단계: 최근 수집 뉴스 목록에서 카드뉴스 적합도 상위 후보를 선별·랭킹.
// newsItems: [{ id, source, title, summary }] → [{ newsItemId, rank, reason }]
export async function filterAndRank(newsItems, count = pipeline.perTopicPick, { topicKey } = {}) {
  if (!Array.isArray(newsItems) || newsItems.length === 0) return [];

  const list = newsItems.map((n) => ({
    id: n.id,
    source: n.source,
    title: n.title,
    summary: (n.summary ?? '').slice(0, 400),
  }));

  const n = count;
  // 주제별 선별 기준. "뉴스 가치"로 고르면 시청자가 할 게 없는 소식이 뽑힌다
  // (예: AI 안전 논쟁 → 보고 나서 할 수 있는 게 없음). 주제 성격에 맞는 효용으로 고른다.
  const criteria =
    topics[topicKey]?.pickCriteria ||
    '뉴스 가치가 높고 시각적으로 풀어낼 수 있으며 서로 중복되지 않는 것을 고르세요.';

  const prompt =
    `당신은 한국어 카드뉴스 편집자입니다. 아래 뉴스 목록에서 세로 영상으로 만들 최적의 뉴스를 골라 순위를 매기세요.\n\n` +
    `[선정 기준]\n${criteria}\n\n` +
    `공통 원칙: 시청자가 보고 나서 "그래서 뭐?"가 되는 뉴스는 고르지 마세요. ` +
    `보고 나서 무언가 알게 되거나, 해볼 수 있거나, 남에게 공유하고 싶어지는 것이어야 합니다.\n` +
    `조건에 맞는 뉴스가 하나도 없으면 빈 배열 []을 출력하세요. 억지로 고르지 마세요.\n\n` +
    `최대 ${n}건을 rank 1부터 순서대로 고르고, 각 건마다 한 줄짜리 한국어 선정 사유를 다세요.\n\n` +
    `뉴스 목록(JSON):\n${JSON.stringify(list)}\n\n` +
    `아래 형식의 JSON 배열만 출력하세요(다른 텍스트 금지):\n` +
    `[{"newsItemId": <id>, "rank": 1, "reason": "한 줄 사유"}]`;

  const parsed = await askClaudeJson(prompt, claude.filterModel);
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

// 릴스 대본 스펙. 훅 유형은 A/B 테스트를 위해 호출부가 지정한다.
// 정지 카드 슬라이드쇼는 첫 1초에 스와이프되므로, 훅 → 나레이션 라인 구조로 만든다.
// 훅 유형. 앵커체("~소식이에요", "~상황 정리")는 뉴스 읽어주는 소리라 스크롤을 못 멈춘다.
// 실측: 앵커체 훅으로 79편을 냈을 때 저장·공유가 전부 0이었다.
const HOOK_STYLES = {
  지목형: {
    guide:
      '누구를 위한 영상인지 첫 화면에서 못 박는다. 보는 사람이 "내 얘기다" 하고 멈추게.\n' +
      '  예: 「부산·경남 사는 분들 보세요」, 「챗GPT 쓰는 직장인만」, 「전세 사는 분 필독」',
  },
  손실형: {
    guide:
      '지금 모르면 잃는 것을 구체적 액수·기회로 보여준다. 막연한 위협이 아니라 숫자로.\n' +
      '  예: 「편집비 30만원, 한 줄로 끝났습니다」, 「신청 안 하면 자동 소멸」',
  },
};

// 대본 구조. 단순 전달은 저장·공유를 못 만들므로 주제 성격에 맞춰 구조를 다르게 준다.
const SCRIPT_STYLES = {
  // 활용형: 시청자가 오늘 당장 따라 할 수 있게. AI 도구·기능 소식에 쓴다.
  howto: {
    guide:
      `[구성] 아래 순서를 지키세요.\n` +
      `  ① 1~2줄: 무엇이 가능해졌는지 (도구 이름과 기능을 구체적으로)\n` +
      `  ② 3~5줄: **이걸로 뭘 할 수 있는지 구체적 상황 2~3개.** 여기가 이 영상의 핵심입니다.\n` +
      `     추상적 표현("업무 효율이 올라가요") 금지. 실제 장면으로 말하세요.\n` +
      `     좋은 예: 「회의 녹음 파일 넣으면 할 일 목록까지 뽑아줘요」\n` +
      `  ③ 6~7줄: 어떻게 쓰는지 (어디서 시작하는지, 무료인지 유료인지)\n` +
      `  ④ 마지막 2줄: 주의점 하나 + 「캡션에 프롬프트 있어요, 저장해두세요」로 마무리\n` +
      `[추가 필드] script.prompt: 시청자가 그대로 복사해 쓸 수 있는 실제 프롬프트.\n` +
      `  · 3~6줄, 각 줄 45자 이내. 바로 붙여넣으면 동작해야 합니다.\n` +
      `  · [대괄호]로 사용자가 바꿔 넣을 자리를 표시하세요. 예: 「[회의록 내용]을 붙여넣으세요」\n` +
      `  · 설명이 아니라 프롬프트 본문만 쓰세요.`,
    needsPrompt: true,
  },
  // 영향형: "그래서 나에게 뭐가 달라지나"로 번역. 정책·경제 소식에 쓴다.
  impact: {
    guide:
      `[구성] 아래 순서를 지키세요.\n` +
      `  ① 1~2줄: 무슨 일이 있었는지 (사실만 간결하게)\n` +
      `  ② 3~5줄: **그래서 시청자에게 뭐가 달라지는지.** 여기가 핵심입니다.\n` +
      `     금액·시점·대상을 구체적으로. 「누구에게 얼마가 어떻게」가 나와야 합니다.\n` +
      `  ③ 6~7줄: 지금 뭘 하면 되는지 (확인할 곳, 신청 방법, 마감)\n` +
      `  ④ 마지막 2줄: 놓쳤을 때의 손해 + 행동 유도\n` +
      `해당되는 사람이 명확히 드러나게 쓰세요. 「나도 해당되나?」 하고 확인하게 만드는 게 목표입니다.`,
    needsPrompt: false,
  },
  // 서사형: 궁금증으로 끌고 가서 반전에서 터뜨린다. 흥미 위주 소재에 쓴다.
  story: {
    guide:
      `[구성] 아래 순서를 지키세요.\n` +
      `  ① 1~2줄: 상황 설정 (뭐가 벌어지고 있는지)\n` +
      `  ② 3~5줄: 전개. 각 줄 끝에서 다음 줄이 궁금해지게 만드세요.\n` +
      `  ③ 6~7줄: **반전이나 놀라운 사실.** 여기가 핵심입니다.\n` +
      `  ④ 마지막 2줄: 그래서 이게 해볼 만한지 아닌지 **판단을 한 줄로** 얹으세요.\n` +
      `     정보만 전하고 끝내지 마세요. 판단이 있어야 공유됩니다.`,
    needsPrompt: false,
  },
};

function reelScriptSpec(hookType, scriptStyle = 'impact') {
  const style = HOOK_STYLES[hookType] || HOOK_STYLES.지목형;
  const st = SCRIPT_STYLES[scriptStyle] || SCRIPT_STYLES.impact;
  const { min, max } = reelCfg.scriptLines;
  return (
    `\n[릴스 대본] 세로 영상용. 나레이션으로 읽히고 자막으로도 표시됩니다.\n` +
    `${st.guide}\n` +
    `- script.hook: 첫 화면 훅. **공백 포함 12자 이내**, 결론부터. 인사말·설명 금지.\n` +
    `  훅 유형은 "${hookType}": ${style.guide}\n` +
    `- script.kicker: 훅 위에 작게 뜨는 한마디(10자 이내). 훅과 의미가 겹치면 안 됩니다. 없으면 빈 문자열.\n` +
    `\n[⚠️ 저장·공유를 만드는 장치 — 이게 이 영상의 목적입니다]\n` +
    `지금까지 79편을 냈는데 저장 0, 공유 0이었습니다. 원인은 "다 보면 소비가 끝나서" 남길 이유가 없어서입니다.\n` +
    `- script.checklist: 마지막 화면에 띄울 **실행 체크리스트**. 이게 저장의 유일한 트리거입니다.\n` +
    `  · title: 8~16자. 「지금 할 것」류의 행동 제목. 예: 「가뭄, 오늘 집에서 할 것」\n` +
    `  · items: 2~4개. 각 12~28자. **당장 실행 가능한 구체 행동**이어야 합니다.\n` +
    `    좋은 예: 「샤워 5분 단축 = 하루 60리터 절약」, 「변기 물통에 500ml 페트병 넣기」\n` +
    `    나쁜 예(추상적): 「물을 아껴 씁시다」, 「관심을 가져야 합니다」\n` +
    `  · 뉴스 성격상 실행 항목을 만들 수 없으면 "꼭 기억할 것" 형태의 핵심 정리 3줄로 대체하세요.\n` +
    `- script.shareCta: 공유 유도 한 줄. **누구에게 보낼지 수신자를 지정**해야 합니다.\n` +
    `  좋은 예: 「경남 사는 친구한테 보내주세요」, 「회사에서 챗GPT 쓰는 동료한테 보내세요」\n` +
    `  나쁜 예: 「공유해주세요」, 「많은 관심 부탁드립니다」\n` +
    `\n- script.lines: 나레이션 겸 자막. **${min}~${max}줄**.\n` +
    `  · ⚠️ 각 줄은 **공백 포함 16자 이상 28자 이하**. 13자 미만은 실패입니다.\n` +
    `    나쁜 예(너무 짧음): 「매출 79조 넘었다」, 「역대급 반도체 호황」\n` +
    `    좋은 예: 「매출이 *79조*를 넘기며 신기록을 썼어요」\n` +
    `  · ⚠️ 말투는 **해요체로 통일**하세요(~해요, ~예요, ~됐어요, ~거든요).\n` +
    `    「~다」로 끝나는 문어체와 명사형 종결(~함, ~임)은 금지입니다.\n` +
    `  · 한 줄이 하나의 완결된 정보. 한 문장이 여러 줄로 쪼개지지 않게 하세요.\n` +
    `  · 숫자·금액·날짜·비율은 *별표*로 감싸 강조: 「월 *20만원*」, 「*3년* 만에」\n` +
    `  · 첫 줄은 훅을 이어받아 바로 본론.\n` +
    `  · **마지막 줄은 반드시 저장을 유도**하세요. 예: 「저장해두고 하나씩 해보세요」\n` +
    `  · 전체를 소리 내어 읽으면 **22~28초**가 되어야 합니다(줄당 약 2.5~3초).\n`
  );
}

// 릴스 대본 검증. 길이 하한이 곧 영상 길이(≈22초)를 담보하므로 느슨하게 두면 안 된다.
// (실제로 줄당 9자짜리 대본이 통과해 17.6초 영상이 나온 적이 있다)
function validScript(s, scriptStyle = 'impact') {
  if (!s || typeof s !== 'object') return false;
  // 활용형은 복붙 프롬프트가 결과물의 핵심이라 없으면 반려.
  if (SCRIPT_STYLES[scriptStyle]?.needsPrompt) {
    if (typeof s.prompt !== 'string' || s.prompt.trim().length < 20) return false;
  }
  // 체크리스트와 수신자 지정 공유 CTA는 저장·공유를 만드는 유일한 장치라 필수.
  const cl = s.checklist;
  if (!cl || typeof cl.title !== 'string' || cl.title.trim().length < 4) return false;
  if (!Array.isArray(cl.items) || cl.items.length < 2 || cl.items.length > 4) return false;
  if (!cl.items.every((i) => typeof i === 'string' && i.trim().length >= 8 && i.length <= 34)) return false;
  if (typeof s.shareCta !== 'string' || s.shareCta.trim().length < 8) return false;
  if (typeof s.hook !== 'string' || !s.hook.trim() || s.hook.length > 16) return false;
  if (!Array.isArray(s.lines)) return false;

  const { min, max } = reelCfg.scriptLines;
  if (s.lines.length < min || s.lines.length > max) return false;
  if (!s.lines.every((l) => typeof l === 'string' && l.trim().length >= 13 && l.length <= 34)) return false;

  // 평균 길이로 전체 낭독 시간을 근사(한국어 약 6.5자/초) → 20초 미만이면 반려.
  const chars = s.lines.reduce((a, l) => a + l.replace(/\*/g, '').length, 0);
  const estSec = chars / 6.5 + s.lines.length * reelCfg.linePadSec;
  return estSec >= 20;
}

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
export async function writeCards(newsItem, { hookType = '지목형', scriptStyle = 'impact', extraInstruction = '' } = {}) {
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
    `caption: 인스타그램 캡션. 앞부분에 검색 키워드를 넣고, 해시태그 3~5개를 포함.\n` +
    `imageKeywords: 표지 배경 사진용 영어 키워드 2~3개(공백 구분). 핵심 개념을 시각적으로 대표하되 긍정적·현대적·깔끔한 이미지가 나오게 하세요. 굴뚝·공해를 연상시키는 단어(factory, industry, pollution, smoke)와 특정 인물명·기업명·상표는 금지. 좋은 예: 'circuit board technology', 'modern city skyline', 'data center servers', 'financial district'.\n` +
    reelScriptSpec(hookType, scriptStyle) +
    `\n아래 형식의 JSON 객체만 출력하세요(다른 텍스트 금지):\n` +
    `{"cards":[...], "caption":"...", "imageKeywords":"...", "script":{"hook":"...","kicker":"...","lines":["...","..."],"checklist":{"title":"...","items":["...","..."]},"shareCta":"..."${
      SCRIPT_STYLES[scriptStyle]?.needsPrompt ? ', "prompt":"복붙용 프롬프트"' : ''
    }}}` + extraInstruction;

  const ok = (p) => validCards(p?.cards) && validScript(p?.script, scriptStyle);
  let parsed = await askClaudeJson(prompt, claude.copyModel);
  if (!ok(parsed)) {
    // 스키마 불일치: 1회 재시도.
    parsed = await askClaudeJson(
      `${prompt}\n\n앞선 응답이 스키마와 맞지 않았습니다. 카드와 script를 모두 스키마대로 다시 출력하세요.`,
      claude.copyModel
    );
    if (!ok(parsed)) {
      throw new Error(
        `writeCards: 스키마 검증 실패 (newsItemId=${newsItem.id}, cards=${validCards(parsed?.cards)}, script=${validScript(parsed?.script, scriptStyle)})`
      );
    }
  }

  return {
    account: account.name,
    date: todayStr(),
    source: `출처: ${newsItem.source}`,
    cards: parsed.cards,
    caption: String(parsed.caption ?? ''),
    imageKeywords: String(parsed.imageKeywords ?? ''),
    script: { ...parsed.script, hookType, scriptStyle }, // A/B·구조 분석용으로 보존
  };
}

// 폴백: 해당 주제에 최신 뉴스가 없을 때, 그 장르에 유용·흥미로운 콘텐츠를 창작해 카드로.
// topicKey → { account, date, source, cards, caption, theme } (writeCards와 동일 형태 + theme)
export async function generateEvergreen(topicKey, { hookType = '지목형' } = {}) {
  const t = topics[topicKey];
  if (!t) throw new Error(`알 수 없는 주제: ${topicKey}`);
  const { min, max } = pipeline.cardsPerCandidate;

  const prompt =
    `${COPYRIGHT_RULES}\n\n` +
    `당신은 한국어 카드뉴스 카피라이터입니다. 지금은 새로 올릴 뉴스가 없어, 아래 성격의 유익하고 흥미로운 콘텐츠를 직접 창작해 카드뉴스로 만듭니다.\n` +
    `콘텐츠 성격: ${t.evergreen}\n` +
    `실제로 검증된 사실·상식만 쓰고, 지어내지 마세요. 특정 뉴스 출처가 없으므로 출처 매체명 규칙은 예외입니다.\n\n` +
    `카드 구성: 표지(cover) 1장 + 본문(body) 1~2장 + 마무리(last) 1장, 총 ${min}~${max}장.\n` +
    `각 카드 스키마:\n` +
    `- cover: {"type":"cover","card":{"category":"분류","headline":"후킹 헤드라인","sub":"부제"}}\n` +
    `- body:  {"type":"body","card":{"kicker":"소제목","title":"핵심 제목","text":"본문","stat":{"value":"수치","label":"수치 설명"}}}  (stat은 수치가 있을 때만, 선택)\n` +
    `- last:  {"type":"last","card":{"summary":"한 줄 요약","insight":"자체 인사이트 한 줄"}}\n\n` +
    `caption: 인스타그램 캡션. 앞부분에 검색 키워드를 넣고, 해시태그 3~5개를 포함.\n` +
    `imageKeywords: 표지 배경 사진용 영어 키워드 2~3개(공백 구분). 핵심 개념을 시각적으로 대표하되 긍정적·현대적·깔끔한 이미지가 나오게 하세요. 굴뚝·공해를 연상시키는 단어(factory, industry, pollution, smoke)와 특정 인물명·기업명·상표는 금지. 좋은 예: 'circuit board technology', 'modern city skyline', 'data center servers', 'financial district'.\n` +
    reelScriptSpec(hookType) +
    `\n아래 형식의 JSON 객체만 출력하세요(다른 텍스트 금지):\n` +
    `{"cards":[...], "caption":"...", "imageKeywords":"...", "script":{"hook":"...","kicker":"...","lines":["...","..."],"checklist":{"title":"...","items":["...","..."]},"shareCta":"..."}}`;

  const ok = (p) => validCards(p?.cards) && validScript(p?.script);
  let parsed = await askClaudeJson(prompt, claude.copyModel);
  if (!ok(parsed)) {
    parsed = await askClaudeJson(
      `${prompt}\n\n앞선 응답이 스키마와 맞지 않았습니다. 카드와 script를 모두 스키마대로 다시 출력하세요.`,
      claude.copyModel
    );
    if (!ok(parsed)) {
      throw new Error(
        `generateEvergreen: 스키마 검증 실패 (${topicKey}, cards=${validCards(parsed?.cards)}, script=${validScript(parsed?.script)})`
      );
    }
  }

  return {
    account: account.name,
    date: todayStr(),
    source: `${t.label} · 오늘의 정보`,
    cards: parsed.cards,
    caption: String(parsed.caption ?? ''),
    imageKeywords: String(parsed.imageKeywords ?? ''),
    script: { ...parsed.script, hookType },
    theme: t.theme,
  };
}

// 릴스 배경용 사진 여러 장 선택. 한 장만 쓰면 25초 내내 같은 그림이라 단조롭다.
// 어울리는 것만 고르므로 요청 수보다 적게 반환될 수 있고, 없으면 [].
export async function pickBackgroundImages(headline, category, candidates, want = 3) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const list = candidates.map((c, i) => `${i}: ${c.tags}`).join('\n');
  const prompt =
    `당신은 한국어 카드뉴스 편집자입니다. 세로 영상의 배경으로 쓸 사진을 고릅니다.\n` +
    `영상 주제: [${category}] ${headline}\n\n` +
    `후보 사진(번호: 태그):\n${list}\n\n` +
    `선택 기준:\n` +
    `- 주제의 분위기에 어울리고, 내용과 모순되지 않을 것\n` +
    `  (예: 산불·재난 주제에 평화로운 들판이나 밝은 관광지는 부적절)\n` +
    `- 서로 너무 비슷하지 않게, 시각적으로 변화가 있는 조합으로\n` +
    `- 어울리는 것만 고르세요. 억지로 채우지 말고, 없으면 빈 배열.\n\n` +
    `최대 ${want}장을 화면에 나올 순서대로 고르세요.\n` +
    `JSON만 출력: {"indexes": [번호, 번호, ...]}`;

  try {
    const parsed = await askClaudeJson(prompt, claude.filterModel);
    const arr = Array.isArray(parsed?.indexes) ? parsed.indexes : [];
    const seen = new Set();
    return arr
      .map(Number)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < candidates.length && !seen.has(i) && seen.add(i))
      .slice(0, want);
  } catch {
    return [];
  }
}

// (pickBestImage는 pickBackgroundImages로 대체됨 — 릴스가 배경을 여러 장 쓰기 때문)
