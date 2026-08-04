// 하나의 일상 브이로그 대본 생성.
// 뉴스와 달리 사실 근거가 없는 창작이므로, 검증된 사실을 다루지 않는 대신
// "이 캐릭터가 실제로 겪을 법한 하루"의 밀도를 만드는 게 목적이다.
//
// ⚠️ 자동 발행하지 않는다. 텔레그램으로 보내 사람이 보고 판단한다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claude, reel as reelCfg } from '../config.js';
import { getMeta, setMeta } from '../db/index.js';
import { hana } from '../persona/hana.js';

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
        ['-p', prompt + RULE + (i ? '\n\n앞선 응답이 유효한 JSON이 아니었습니다. 다시 출력하세요.' : ''),
         '--output-format', 'json', '--model', claude.copyModel],
        { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
      );
      exec.child?.stdin?.end();
      const { stdout } = await exec;
      const outer = JSON.parse(stdout);
      return JSON.parse(stripFences(outer.result));
    } catch (e) {
      lastErr = e;
      console.warn(`[vlog] claude 실패(재시도): ${e.message.slice(0, 100)}`);
    }
  }
  throw lastErr;
}

// 최근에 쓴 소재를 피해 새 소재를 고른다. meta에 사용 이력을 남긴다.
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
    // 한 바퀴 다 돌았으면 리셋하되 직전 소재만 제외
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

const SLOT_GUIDE = {
  day: {
    label: '낮 — 지금 하고 있는 일',
    guide:
      '지금 이 순간 하고 있는 일을 보여준다. 현재진행형. ' +
      '완결된 이야기가 아니라 "지금 이러고 있어요" 느낌.',
  },
  evening: {
    label: '저녁 — 오늘 있었던 일 하나',
    guide:
      '오늘 하루 중 기억에 남는 일 하나를 꺼낸다. 작은 사건이어야 한다. ' +
      '거창한 성취나 교훈으로 끝내지 말 것. 담담하게.',
  },
};

// slot: 'day' | 'evening' → { theme, script:{ hook, lines[], checklist?, shareCta } }
export async function writeVlog(slot = 'day') {
  const theme = pickTheme(slot);
  const s = SLOT_GUIDE[slot] || SLOT_GUIDE.day;
  const { min, max } = reelCfg.scriptLines;
  const p = hana.profile;
  const v = hana.voice;

  const prompt =
    `당신은 한국어 숏폼 대본 작가입니다. 아래 인물의 일상 브이로그 대본을 씁니다.\n\n` +
    `[인물]\n` +
    `- 이름: ${hana.name}, ${p.age}세, ${p.job}\n` +
    `- 상황: ${p.status}\n` +
    `- 사는 곳: ${p.livesIn} (${p.hometown} 출신)\n` +
    `- 동기: ${p.motivation}\n` +
    `- 성격: ${hana.personality.traits.join(', ')}\n` +
    `- 결점: ${hana.personality.flaws.join(', ')}\n` +
    `- 버릇: ${hana.personality.quirks.join(', ')}\n\n` +
    `[이번 편]\n` +
    `- 시간대: ${s.label}\n` +
    `- 소재: ${theme}\n` +
    `- ${s.guide}\n\n` +
    `[말투]\n${v.tone}\n${v.rules.map((r) => '- ' + r).join('\n')}\n\n` +
    `[⚠️ 이 대본이 지켜야 할 것]\n` +
    `- 뉴스가 아니라 개인의 하루입니다. 정보 전달하지 마세요.\n` +
    `- 구체적인 장면 하나로 시작하세요. 「오늘은」, 「여러분」으로 시작 금지.\n` +
    `- 감정을 설명하지 말고 행동으로 보여주세요.\n` +
    `  나쁜 예: 「긴장됐어요」 / 좋은 예: 「대본을 세 번 다시 읽었어요」\n` +
    `- 교훈이나 다짐으로 끝내지 마세요. 여운으로 끝내세요.\n` +
    `- 과장 금지. 「대박」, 「충격」, 「인생이 바뀐」 같은 표현 쓰지 마세요.\n\n` +
    `[대본 구조]\n` +
    `- hook: 첫 화면. 12자 이내. 장면이 그려지는 한 마디.\n` +
    `  예: 「오늘도 3분 지각」, 「대본 세 번 읽었어요」\n` +
    `- lines: 나레이션 겸 자막 ${min}~${max}줄. 각 줄 16~28자, 해요체.\n` +
    `- shareCta: 공유 유도 한 줄. 수신자를 지정하세요.\n` +
    `  예: 「같이 준비하는 친구한테 보내주세요」\n\n` +
    `아래 형식의 JSON만 출력하세요(다른 텍스트 금지):\n` +
    `{"script":{"hook":"...","kicker":"...","lines":["...","..."],"shareCta":"..."},"caption":"인스타 캡션(해시태그 3~5개 포함)","imageKeywords":"영어 키워드 2~3개"}`;

  const parsed = await askClaudeJson(prompt);
  const sc = parsed?.script;
  if (!sc?.hook || !Array.isArray(sc.lines) || sc.lines.length < min) {
    throw new Error(`vlog 스키마 검증 실패 (lines=${sc?.lines?.length})`);
  }

  return {
    account: hana.brand.account,
    slot,
    theme,
    script: { ...sc, hookType: '일상', scriptStyle: 'vlog' },
    caption: String(parsed.caption ?? ''),
    imageKeywords: String(parsed.imageKeywords ?? ''),
  };
}
