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

// 한 게시물의 사진 장수. 9b 뉴런 단가(장당 1,416)와 무료 한도(계정 2개 20,000/일)에
// 묶여 있다 — 2슬롯 x 5장 = 10장에 재시도 여유까지 하루 14장 안에 들어간다.
// 이 숫자를 올리려면 src/config.js의 imageModel을 4b로 되돌려야 한다.
const PHOTO_COUNT = 5;

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

// 일정(out/schedule/YYYYMMDD.json)이 있는 날의 동선. 정거장마다 사진을 배정한다.
// 정거장이 사진 장수보다 많으면 앞에서 자른다 — 장수는 뉴런 예산에 묶여 있다(PHOTO_COUNT).
function scheduleStops(schedule) {
  return (schedule?.stops || []).slice(0, PHOTO_COUNT).map((st) => ({
    key: String(st.key),
    place: String(st.place),
    label: st.label || hana.setting.summaryFor?.[st.place] || st.place,
    when: st.when || '',
    // 작성자가 정거장에 night를 명시했으면 그대로 실어 보낸다 — framingFor가 이걸 본다.
    ...(st.night === undefined ? {} : { night: Boolean(st.night) }),
  }));
}

// 사진마다 정거장을 붙인다. LLM이 준 stop 키가 틀리면 순서대로 고르게 나눠 배정한다.
function assignStops(photos, stops) {
  const keys = stops.map((s) => s.key);
  const out = photos.map((x, i) => {
    const k = keys.includes(String(x.stop)) ? String(x.stop) : keys[Math.min(keys.length - 1, Math.floor((i * keys.length) / photos.length))];
    return { ...x, stop: k };
  });
  const order = out.map((x) => keys.indexOf(x.stop));
  // 정거장이 빠지면(같은 키 중복으로 어느 정거장은 사진 0장) 순서대로 고르게 다시 배정한다.
  // 사진보다 정거장이 많을 땐 다 채울 수 없으니 건드리지 않는다(Math.min).
  if (new Set(order).size < Math.min(keys.length, out.length)) {
    return out.map((x, i) => ({ ...x, stop: keys[Math.min(keys.length - 1, Math.floor((i * keys.length) / out.length))] }));
  }
  // 정거장 순서를 거스르면(3번 뒤에 1번) 사진을 동선 순서로 재정렬한다.
  // ⚠️ 라벨만 다시 붙이면 action(그 정거장에서 벌어지는 일)이 엉뚱한 정거장에 붙어
  //    레퍼런스 사진·프레이밍·장소 설명이 통째로 어긋난다. 짝은 유지하고 순서만 고친다.
  if (order.some((v, i) => i && v < order[i - 1])) {
    return out.map((x, i) => ({ x, i })).sort((a, b) => order[a.i] - order[b.i] || a.i - b.i).map((o) => o.x);
  }
  return out;
}

// slot: 'day' | 'evening'
// → { theme, place, caption, hashtags[], photos:[{ action, look, stop?, place }], stops? }
// schedule: 그날의 동선(out/schedule/YYYYMMDD.json). 있으면 소재·장소·상황을 일정에서 가져오고
//           사진마다 정거장을 배정한다. 없으면 예전처럼 소재 풀에서 뽑는다.
export async function writeVlogPost(slot = 'day', { theme: forcedTheme, placeSeed = '', schedule = null } = {}) {
  const stops = scheduleStops(schedule);
  // 소재를 지정하면 풀에서 뽑지 않는다(수동 실행에서 오늘 소재를 바꿀 때).
  // 일정이 있는 날은 일정 제목이 소재다 — 풀 사용 이력(meta)도 건드리지 않는다.
  const theme = stops.length ? schedule.title || forcedTheme || '오늘의 동선' : forcedTheme || pickTheme(slot);
  // 소재가 장소를 못박지 않았으면 시간대 풀에서 시드로 고른다 —
  // 회고형 소재가 전부 방으로 몰려 매일 같은 그림이 나오던 문제(방 비중 73%).
  const place = stops.length ? stops[0].place : placeForTheme(theme, placeSeed || `${slot}-${theme}`, slot);
  const expression = expressionForTheme(theme);
  const brief = (stops.length && schedule.brief) || hana.themeBriefs?.[theme] || '';
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
    // ⚠️ 장소를 반드시 넘긴다. 예전엔 summaryFor가 없어 undefined가 들어갔고,
    //    글 쓰는 쪽이 어디인지 몰라 집 이야기를 써서 사진(카페)과 어긋났다.
    (stops.length
      ? `- 오늘의 동선(시간 순) — 글은 이 동선을 따라갑니다. 여기 없는 장소·일은 쓰지 마세요.\n` +
        stops.map((st, i) => `  ${i + 1}. ${st.when ? st.when + ' ' : ''}${st.label} [stop=${st.key}]`).join('\n') + '\n'
      : place !== 'room'
      ? `- 장소: ${hana.setting.summaryFor?.[place] || place} — 집이 아닙니다. 이 장소에서 할 법한 행동만 쓰세요.\n` +
        `  글 전체가 이 장소에서 벌어져야 합니다. 집·방 이야기를 쓰지 마세요.\n`
      : '- 장소: 자취방 (원룸) — 이 글은 방 안에서 쓴 것입니다.\n') +
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
    `- 이 글에 어울리는 사진 5장을 정합니다. 서로 다른 순간·다른 각도·다른 거리(얼굴 클로즈업, 반신, 손·사물 클로즈업)로 폭넓게 섞으세요.\n` +
    `- photos[].action: 사진에 담길 장면을 **영어로** 한 문장. 인물이 뭘 하고 있는지.\n` +
    `  예: 'sitting cross-legged on the floor, marking a printed script with a highlighter'\n` +
    `- 셀카처럼 자연스러운 순간이어야 합니다. 화보처럼 꾸미지 마세요.\n` +
    // ⚠️ 이미지 모델(FLUX.2)은 네거티브 프롬프트가 무효라 「웃지 마라」를 못 알아듣는다.
    //    그래서 여기 LLM 단계에서 미리 막는다 — LLM은 부정 지시를 이해한다.
    //    크게 웃는 컷은 눈이 감겨 이 캐릭터의 식별점(좌우 비대칭 눈매)이 사라진다.
    `- action에 laughing, grinning, giggling, mouth open, eyes closed 를 쓰지 마세요.\n` +
    `  웃는 장면이 필요하면 'a small soft smile with both eyes open'처럼 쓰세요.\n` +
    // 손은 결함이 가장 잦은 부위다. 화면 가운데 크게 펼쳐지지 않게 유도한다.
    `- 손이 화면 가운데 크게 펼쳐진 장면을 쓰지 마세요. 손은 컵·가방·주머니에 반쯤 가려지거나\n` +
    `  프레임 가장자리에 걸치게 쓰세요.\n` +
    `- 첫 장은 인물이 보이는 사진, 나머지는 손·사물 클로즈업도 좋습니다.\n` +
    (stops.length
      ? `- 사진마다 어느 정거장에서 찍었는지 photos[].stop 에 위 [stop=…] 키를 적으세요.\n` +
        `  동선 순서대로, 모든 정거장이 최소 한 장씩 나오게 하세요. action의 장면도 그 정거장에서 벌어지는 일이어야 합니다.\n` +
        // 친구는 별도 인물 참조가 없어 얼굴을 그리면 매번 다른 사람이 된다.
        `- 함께 있는 사람은 얼굴이 나오지 않게 쓰세요(손·어깨·뒷모습·프레임 밖). 인물의 얼굴은 하나뿐입니다.\n`
      : '') +
    `\n아래 형식의 JSON만 출력하세요(다른 텍스트 금지):\n` +
    `{"caption":"게시물 본문(줄바꿈 포함)","hashtags":["#취준일기","#공채준비"],` +
    (stops.length ? `"photos":[{"stop":"정거장 키","action":"영어 한 문장"}]}` : `"photos":[{"action":"영어 한 문장"}]}`);

  const parsed = await askClaudeJson(prompt);
  const caption = String(parsed?.caption ?? '').trim();
  const photos = Array.isArray(parsed?.photos) ? parsed.photos.filter((x) => x?.action) : [];
  if (!caption || photos.length === 0) {
    throw new Error(`vlog 스키마 검증 실패 (caption=${caption.length}자, photos=${photos.length})`);
  }

  const picked = photos.slice(0, PHOTO_COUNT);
  if (!stops.length) {
    return {
      slot,
      theme,
      place,
      expression,
      weather,
      caption,
      hashtags: (parsed.hashtags || []).slice(0, 6).map(String),
      photos: picked.map((x) => ({ action: String(x.action), look: s.lookHint })),
    };
  }
  const placeOf = Object.fromEntries(stops.map((st) => [st.key, st.place]));
  return {
    slot,
    theme,
    place,
    expression,
    weather,
    caption,
    hashtags: (parsed.hashtags || []).slice(0, 6).map(String),
    schedule: { date: schedule.stamp || schedule.date || '', title: schedule.title || '' },
    stops,
    photos: assignStops(picked, stops).map((x) => ({ action: String(x.action), look: s.lookHint, stop: x.stop, place: placeOf[x.stop] })),
  };
}
