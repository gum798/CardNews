// 하나의 일상 포스트 대본 — 인스타 피드 형식(사진 + 글).
// 뉴스는 나레이션 릴스, 일상은 사진 포스트로 형식을 완전히 나눈다.
// 일상까지 영상으로 만들면 제작비도 들고 "채널이 하나의 포맷만 찍어낸다"는
// 인상을 줘서 유튜브 템플릿 반복 조항에도 불리하다.
//
// ⚠️ 자동 발행하지 않는다. 텔레그램으로 보내 사람이 보고 판단한다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claude } from '../config.js';
import { getMeta, setMeta } from '../db/index.js';
import { hana, placeForTheme, expressionForTheme } from '../persona/hana.js';
import { getSeoulWeather, weatherBrief } from '../weather/seoul.js';

const execFileAsync = promisify(execFile);

function stripFences(text) {
  const t = String(text).trim();
  const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return (fence ? fence[1] : t).trim();
}

async function askClaudeJson(prompt) {
  const RULE =
    '\n\n[출력 규칙] 오직 유효한 JSON만 출력하세요(코드펜스·설명 금지). ' +
    'JSON 문자열 값 안에서 인용이 필요하면 큰따옴표(") 대신 홑따옴표(\') 또는 「」를 쓰세요.';

  let lastErr;
  for (const [i, wait] of [0, 5000, 20000].entries()) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const exec = execFileAsync(
        claude.bin,
        [
          '-p',
          prompt + RULE + (i ? '\n\n앞선 응답이 유효한 JSON이 아니었습니다. 다시 출력하세요.' : ''),
          '--output-format', 'json', '--model', claude.copyModel,
        ],
        { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
      );
      exec.child?.stdin?.end();
      const { stdout } = await exec;
      return JSON.parse(stripFences(JSON.parse(stdout).result));
    } catch (e) {
      lastErr = e;
      console.warn(`[vlog] claude 실패(재시도): ${e.message.slice(0, 100)}`);
    }
  }
  throw lastErr;
}

// 최근에 쓴 소재를 피해 새 소재를 고른다. 사용 이력은 meta에 남긴다.
function pickTheme(slot) {
  const pool = hana.dailyThemes[slot] || [];
  const key = `vlog_used:${slot}`;
  let used = [];
  try {
    used = JSON.parse(getMeta(key) || '[]').filter((t) => pool.includes(t));
  } catch {
    used = [];
  }
  let avail = pool.filter((t) => !used.includes(t));
  if (avail.length === 0) {
    const last = used[used.length - 1];
    avail = pool.filter((t) => t !== last);
    used = last ? [last] : [];
  }
  const chosen = avail[Math.floor(Math.random() * avail.length)];
  used.push(chosen);
  while (used.length > pool.length - 1) used.shift();
  setMeta(key, JSON.stringify(used));
  return chosen;
}

const PLACE_LABEL = {
  convenienceStore: '편의점 (창가 취식 카운터에서 도시락)',
};

const SLOT_GUIDE = {
  day: {
    label: '낮 — 지금 하고 있는 일',
    guide: '지금 이 순간을 찍어 올린 것처럼. 현재진행형. 짧고 가볍게.',
    lookHint: 'daily',
  },
  evening: {
    label: '저녁 — 오늘 있었던 일 하나',
    guide: '하루를 마치며 쓴 글. 오늘 있었던 작은 일 하나. 조금 더 길고 담담하게.',
    lookHint: 'daily',
  },
};

// slot: 'day' | 'evening'
// → { theme, caption, hashtags[], photos:[{ action, look }] }
export async function writeVlogPost(slot = 'day', { theme: forcedTheme } = {}) {
  // 소재를 지정하면 풀에서 뽑지 않는다(수동 실행에서 오늘 소재를 바꿀 때).
  const theme = forcedTheme || pickTheme(slot);
  const place = placeForTheme(theme);
  const expression = expressionForTheme(theme);
  const brief = hana.themeBriefs?.[theme] || '';
  // 날씨를 모르면 8월에 「쌀쌀하네요」 같은 글이 나온다.
  const weather = await getSeoulWeather();
  const s = SLOT_GUIDE[slot] || SLOT_GUIDE.day;
  const p = hana.profile;
  const v = hana.voice;

  const prompt =
    `당신은 인스타그램 피드 글을 쓰는 작가입니다. 아래 인물이 직접 올린 사진 게시물을 만듭니다.\n\n` +
    `[인물]\n` +
    `- ${hana.name}, ${p.age}세, ${p.job}\n` +
    `- ${p.status}\n` +
    `- ${p.livesIn} (${p.hometown} 출신)\n` +
    `- 동기: ${p.motivation}\n` +
    `- 성격: ${hana.personality.traits.join(', ')}\n` +
    `- 결점: ${hana.personality.flaws.join(', ')}\n` +
    `- 버릇: ${hana.personality.quirks.join(', ')}\n\n` +
    `[이번 게시물]\n` +
    `- 시간대: ${s.label}\n` +
    `- 소재: ${theme}\n` +
    (place !== 'room' ? `- 장소: ${hana.setting.summaryFor?.[place] || PLACE_LABEL[place]} — 집이 아닙니다. 이 장소에서 할 법한 행동만 쓰세요.\n` : '') +
    `- ${s.guide}\n` +
    (brief ? `\n[이 소재의 상황 — 반드시 반영]\n${brief}\n` : '') +
    `\n[오늘 날씨]\n${weatherBrief(weather)}\n` +
    '날씨를 글 소재로 억지로 끌어들이지는 마세요. 다만 계절과 어긋나는 말은 절대 쓰지 마세요.\n' +
    '\n' +
    `[말투]\n${v.tone}\n${v.rules.map((r) => '- ' + r).join('\n')}\n\n` +
    `[⚠️ 인스타 글쓰기 규칙]\n` +
    `- 뉴스가 아니라 개인의 하루입니다. 정보 전달·설명하지 마세요.\n` +
    `- 첫 줄이 제일 중요합니다. 구체적인 장면이나 한마디로 시작하세요.\n` +
    `  「오늘은」, 「여러분」, 「안녕하세요」로 시작 금지.\n` +
    `- 감정을 설명하지 말고 행동으로 보여주세요.\n` +
    `  나쁜 예: 「긴장됐어요」 / 좋은 예: 「대본을 세 번 다시 읽었어요」\n` +
    `- 교훈·다짐으로 끝내지 마세요. 여운으로 끝내세요.\n` +
    `- 과장 금지. 「대박」, 「충격」, 「인생이 바뀐」 금지.\n` +
    `- 길이: ${slot === 'day' ? '3~5줄' : '5~8줄'}. 줄바꿈으로 호흡을 주세요.\n\n` +
    `[사진]\n` +
    `- 이 글에 어울리는 사진 10장을 정합니다. 서로 다른 순간·다른 각도·다른 거리(얼굴 클로즈업, 반신, 손·사물 클로즈업)로 폭넓게 섞으세요.\n` +
    `- photos[].action: 사진에 담길 장면을 **영어로** 한 문장. 인물이 뭘 하고 있는지.\n` +
    `  예: 'sitting cross-legged on the floor, marking a printed script with a highlighter'\n` +
    `- 셀카처럼 자연스러운 순간이어야 합니다. 화보처럼 꾸미지 마세요.\n` +
    `- 첫 장은 인물이 보이는 사진, 나머지는 손·사물 클로즈업도 좋습니다.\n\n` +
    `아래 형식의 JSON만 출력하세요(다른 텍스트 금지):\n` +
    `{"caption":"게시물 본문(줄바꿈 포함)","hashtags":["#취준일기","#공채준비"],` +
    `"photos":[{"action":"영어 한 문장"}]}`;

  const parsed = await askClaudeJson(prompt);
  const caption = String(parsed?.caption ?? '').trim();
  const photos = Array.isArray(parsed?.photos) ? parsed.photos.filter((x) => x?.action) : [];
  if (!caption || photos.length === 0) {
    throw new Error(`vlog 스키마 검증 실패 (caption=${caption.length}자, photos=${photos.length})`);
  }

  return {
    slot,
    theme,
    place,
    expression,
    weather,
    caption,
    hashtags: (parsed.hashtags || []).slice(0, 6).map(String),
    photos: photos.slice(0, 10).map((x) => ({ action: String(x.action), look: s.lookHint })),
  };
}
