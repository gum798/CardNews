// 페르소나 이미지 생성.
// 백엔드 2종을 지원하고 .env로 고른다:
//   IMAGE_BACKEND=omniroute → 로컬 OmniRoute 게이트웨이 (OpenAI 호환 /v1/images/generations)
//   IMAGE_BACKEND=gemini    → Google Gemini API 직결
// 기본값은 OMNIROUTE_URL이 설정돼 있으면 omniroute, 아니면 gemini.
//
// 얼굴 일관성의 핵심은 두 가지다:
//   1) hana.appearance.referencePrompt를 절대 바꾸지 않는다 (바꾸면 다른 사람이 된다)
//   2) 기준 시트를 만든 뒤에는 그 이미지를 레퍼런스로 첨부해 생성한다
//      ※ OmniRoute의 /v1/images/generations는 OpenAI 형식이라 레퍼런스 첨부를 지원하지 않는다.
//        레퍼런스가 필요한 호출은 gemini 백엔드로 자동 폴백한다.
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cloudflare } from '../config.js';
import { foregroundMatte } from '../video/matte.js';
import { identityLockFor } from './hana.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
// 인계 문서에서 실호출로 검증된 모델 (200 · JPEG 1024x1024)
const OMNI_MODEL = process.env.OMNIROUTE_IMAGE_MODEL || 'antigravity/gemini-3.1-flash-image';

// 쓸 수 있는 백엔드를 우선순위대로 나열한다. 앞에서 실패하면 다음으로 넘어간다.
// 기본 순서는 gemini 우선 — OmniRoute의 무료 provider는 할당량 소진(429)이 잦다.
// IMAGE_BACKEND로 선두를 바꿀 수 있다.
function backendChain(wantRef) {
  const hasOmni = Boolean(process.env.OMNIROUTE_URL && process.env.OMNIROUTE_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasCF = Boolean(cloudflare.accountId && cloudflare.aiToken);

  let chain = [];
  if (hasGemini) chain.push('gemini');
  if (hasCF) chain.push('cf'); // 무료(일 10,000뉴런). IMAGE_BACKEND=cf로 선두 지정.
  if (hasOmni) chain.push('omniroute');

  // 레퍼런스 첨부: cf(input_image_0..3 네이티브)와 gemini만 지원.
  if (wantRef) chain = chain.filter((b) => b === 'gemini' || b === 'cf');

  const explicit = process.env.IMAGE_BACKEND;
  if (explicit && chain.includes(explicit)) {
    chain = [explicit, ...chain.filter((b) => b !== explicit)];
  }

  if (!chain.length) {
    throw new Error(
      wantRef
        ? '레퍼런스 첨부에는 GEMINI_API_KEY가 필요합니다'
        : '이미지 백엔드 없음: GEMINI_API_KEY 또는 OMNIROUTE_URL+OMNIROUTE_API_KEY 필요'
    );
  }
  return chain;
}

// ── OmniRoute (OpenAI 호환) ────────────────────────────────
// ⚠️ size는 OpenAI 표준값만 먹는다. 실측: '1024x1792' → 768x1376(세로 유지),
//    '1080x1920'은 무시되고 1024x1024 정사각형으로 떨어진다. 임의 해상도를 주지 말 것.
const OMNI_SIZE_VERTICAL = '1024x1792';

async function viaOmniroute(prompt, size) {
  const url = `${process.env.OMNIROUTE_URL.replace(/\/$/, '')}/images/generations`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OMNIROUTE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: OMNI_MODEL, prompt, n: 1, size: size || OMNI_SIZE_VERTICAL }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(`omniroute image ${res.status}: ${JSON.stringify(body).slice(0, 200)}`),
      { fatal: res.status === 401 || res.status === 404 }
    );
  }
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`이미지 없음: ${JSON.stringify(body).slice(0, 200)}`);
  return Buffer.from(b64, 'base64'); // 확장자 관례와 달리 JPEG가 온다
}

// ── Cloudflare Workers AI (flux-2-klein-4b, 무료) ─────────────
// multipart 필수(JSON은 400). 레퍼런스는 input_image_0..3 — 서버가 512px 미만으로
// 축소하므로 큰 사진을 그대로 넣으면 얼굴이 뭉개진다. 넣기 전에 인물 머리 위주로
// 크롭해 480px로 만든다(matte의 bbox 이용, 실패 시 중앙 상단 크롭).
const execFileAsync = promisify(execFile);
const FFMPEG_BIN = '/opt/homebrew/bin/ffmpeg';

async function headCropForRef(imgPath) {
  const out = path.join(os.tmpdir(), 'cfref-' + path.basename(imgPath).replace(/[^w.]/g, '_') + '.jpg');
  try {
    const info = await foregroundMatte(imgPath);
    if (info) {
      // 인물 bbox의 위쪽 정사각형 = 머리 영역. 폭의 1.15배로 여유를 준다.
      const side = Math.min(Math.round(info.bbox.w * 1.15), info.width);
      const x = Math.max(0, Math.min(info.width - side, Math.round(info.bbox.x + info.bbox.w / 2 - side / 2)));
      const y = Math.max(0, Math.min(info.height - side, info.bbox.y));
      await execFileAsync(FFMPEG_BIN, ['-v','error','-i',imgPath,'-vf',`crop=${side}:${side}:${x}:${y},scale=480:480`,'-q:v','3',out,'-y']);
      return out;
    }
  } catch { /* 폴백으로 */ }
  // 매트 실패: 중앙 상단 정사각 크롭 (인물 사진 관례상 얼굴은 상단 중앙에 있다)
  await execFileAsync(FFMPEG_BIN, ['-v','error','-i',imgPath,'-vf',"crop='min(iw,ih)':'min(iw,ih)':(iw-min(iw,ih))/2:0,scale=480:480",'-q:v','3',out,'-y']);
  return out;
}

async function viaCloudflare(prompt, refImages, size) {
  const [w, h] = (size || '768x1376').split('x').map(Number);
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', String(w || 768));
  form.append('height', String(h || 1376));
  for (let i = 0; i < Math.min(refImages.length, 4); i++) {
    const cropped = await headCropForRef(refImages[i]);
    form.append(`input_image_${i}`, new Blob([readFileSync(cropped)], { type: 'image/jpeg' }), `ref${i}.jpg`);
  }
  // 계정별 무료 풀(일 10,000뉴런)을 순서대로 소진한다. 1번 429면 2번 시도.
  let res, buf;
  const accounts = cloudflare.accounts.length ? cloudflare.accounts : [{ accountId: cloudflare.accountId, token: cloudflare.aiToken }];
  for (let ai = 0; ai < accounts.length; ai++) {
    const acct = accounts[ai];
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct.accountId}/ai/run/${cloudflare.imageModel}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${acct.token}` },
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
    buf = Buffer.from(await res.arrayBuffer());
    if (res.ok) break;
    const last = ai === accounts.length - 1;
    if (res.status === 429 && !last) {
      console.warn(`[persona] cf 계정 ${ai + 1} 뉴런 소진 → 계정 ${ai + 2} 시도`);
      continue;
    }
    // 429(전 계정 소진)는 다음 백엔드(gemini)로 넘어가게 non-fatal로 둔다.
    throw Object.assign(new Error(`cf image ${res.status}: ${buf.toString().slice(0, 200)}`), {
      fatal: res.status === 401 || res.status === 403,
    });
  }
  if (buf[0] === 0x7b) { // JSON {result:{image:b64}}
    const j = JSON.parse(buf.toString());
    const b64 = j?.result?.image;
    if (!b64) throw new Error(`cf 이미지 없음: ${JSON.stringify(j).slice(0, 200)}`);
    return Buffer.from(b64, 'base64');
  }
  return buf; // 바이너리 응답
}

// ── Gemini 직결 (레퍼런스 이미지 첨부 지원) ──────────────────
function extractGeminiImage(body) {
  const parts = body?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const d = p.inlineData || p.inline_data;
    if (d?.data) return Buffer.from(d.data, 'base64');
  }
  const text = parts.map((p) => p.text).filter(Boolean).join(' ').slice(0, 200);
  throw new Error(`이미지 없음 (finishReason=${body?.candidates?.[0]?.finishReason}) ${text}`);
}

async function viaGemini(prompt, refImages) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 없음');
  const parts = [];
  for (const ref of refImages.slice(0, 4)) {
    parts.push({ inlineData: { mimeType: 'image/png', data: readFileSync(ref).toString('base64') } });
  }
  parts.push({ text: prompt });

  const res = await fetch(`${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'] } }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(`gemini image ${res.status}: ${String(body?.error?.message || '').slice(0, 200)}`),
      { fatal: true }
    );
  }
  return extractGeminiImage(body);
}

// prompt로 이미지 1장 생성. refImages(파일 경로)를 주면 그 인물을 유지하도록 첨부한다.
export async function generateImage(prompt, { refImages = [], outPath, size } = {}) {
  const chain = backendChain(refImages.length > 0);
  let lastErr;

  // 백엔드 하나가 할당량(429)에 걸려도 다른 쪽으로 넘어간다. 둘 다 무료라 비용은 안 든다.
  for (const which of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const buf =
          which === 'omniroute' ? await viaOmniroute(prompt, size)
          : which === 'cf' ? await viaCloudflare(prompt, refImages, size)
          : await viaGemini(prompt, refImages);
        if (buf.length < 1000) throw new Error('빈 이미지 응답');
        if (outPath) {
          await mkdir(path.dirname(outPath), { recursive: true });
          await writeFile(outPath, buf);
        }
        return outPath || buf;
      } catch (e) {
        lastErr = e;
        // 인증·요청 형식 오류는 재시도해도 같은 결과 → 바로 다음 백엔드로.
        if (e.fatal) break;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (chain.length > 1) {
      console.warn(`[persona] ${which} 실패 → 다음 백엔드 시도: ${String(lastErr?.message).slice(0, 100)}`);
    }
  }
  throw lastErr;
}

export function activeBackend(wantRef = false) {
  try {
    return backendChain(wantRef)[0];
  } catch {
    return null;
  }
}

// 씬 프롬프트를 조립한다. 각도를 정면 ±30°로 묶는 게 드리프트를 가장 크게 줄인다.
// 촬영 조건. AI 티의 대부분은 "조명이 고르고 구도가 완벽한 것"에서 온다.
// 창광/플래시 두 종을 두고 로테이션한다 — 매번 같은 빛이면 그 자체가 패턴이 된다.
// ⚠️ FRAMING은 빛과 센서 특성만 말한다. 카메라 위치는 COMPOSITIONS가 정한다.
//    여기서 "she sits left of centre" 같은 3인칭 구도를 지정하면 셀카 구도와 싸워서
//    오버헤드 셀카를 요청해도 평범한 눈높이 사진이 나온다(실제로 그 증상을 겪었다).
const FRAMING = {
  feedWindow:
    'Vertical 4:5, a snapshot straight from her camera roll. ' +
    'Late afternoon light comes only from the room\'s single window — whichever side of the frame it falls on: ' +
    'the side of her face away from it is about two stops darker, ' +
    'a hard shadow falls under her jaw onto her neck, and a bright stripe lands on the wall beside her. ' +
    'The white balance is caught between the window and the ceiling LED, so the shadows carry a faint cool cast. ' +
    'ISO 800: grain in the shadows, a small blown highlight on her forehead, corners a little dark and soft. ' +
    'Handheld, the frame tilted a couple of degrees.',

  feedFlash:
    'Vertical 4:5, taken at night in her room with the phone flash on. ' +
    'The flash is the only light: a hard specular highlight on her forehead, nose and cheekbones, ' +
    'a sharp dark shadow thrown onto the wall behind her, and the background falling off to near black. ' +
    // ⚠️ 'red-eye artifact'를 요구하면 모델이 눈동자를 진짜 새빨갛게 칠한다(실제로 그랬다).
    //    적목은 "달라고 하는 결함"이 아니다. 플래시 반사만 남기고 눈 색은 건드리지 않게 한다.
    'Her eyes catch a small round flash reflection. Her irises stay their natural dark brown — ' +
    'no red or coloured pupils, no glowing eyes. ' +
    'Colours look slightly washed out and cool the way direct phone flash renders skin. ' +
    'Handheld, framing casual and a little crooked.',

  reel:
    'Vertical 9:16 with room above her head. Shot on a phone propped on the desk, 26mm equivalent, f/1.8. ' +
    'Lit only by the room\'s single window — one side of her face clearly darker, a shadow under the jaw. ' +
    'Focus on her face, the room behind still legible. Mild grain in the shadows, corners a touch darker.',

  // 밤의 방. 플래시 없이 실내등만 — feedFlash(플래시 직광)와 다른 부드러운 밤 룩.
  // 밤 소재(열대야·새벽 공부)에서 창밖이 대낮이면 글과 그림이 어긋난다.
  feedNight:
    'Vertical 4:5, a snapshot straight from her camera roll, taken at night in her room. ' +
    'The windows are dark — just faint reflections of the room in the glass, no daylight at all. ' +
    'The room is lit by the warm ceiling light and a small desk lamp: soft, slightly yellow, ' +
    'uneven light with gentle shadows, dimmer toward the corners of the room. ' +
    'ISO 1600: visible grain, especially in the shadows, and slightly muted colours. ' +
    'Handheld, the frame tilted a couple of degrees.',

  // 집 밖에서 낮에 찍은 컷. feedWindow/feedFlash는 「그녀의 방」·「밤」을 전제하므로
  // 편의점·카페 같은 장소에서 쓰면 장소 묘사와 정면으로 싸운다.
  feedPublic:
    'Vertical 4:5, a snapshot straight from her camera roll, taken in the middle of the day. ' +
    'Two light sources fight each other: flat daylight through the big window beside her and ' +
    'greenish fluorescent tubes overhead, so the white balance never fully resolves — ' +
    'the daylight side of her face reads slightly blue, the shadow side slightly green. ' +
    'The window side is about a stop and a half brighter and a little blown near the glass. ' +
    'ISO 400: light grain, corners a touch dark and soft. ' +
    'Handheld, the frame tilted a couple of degrees, framing casual and not quite level.',
};

// 사진 구도 풀. 인스타에 실제로 올라오는 형태들이다.
// 매번 같은 "책상 앞 반신"이면 계정 전체가 한 장짜리처럼 보인다.
// 셀카는 전면카메라 특성(광각·팔 길이·약간 위에서)을 명시해야 셀카로 읽힌다.
export const COMPOSITIONS = {
  // ── 셀카 계열 ──
  selfieHigh:
    'This photo IS taken by the phone she is holding — the phone must not appear in the frame. ' +
    'A front-camera selfie held at arm\'s length, about 45cm from her face, raised slightly above eye level ' +
    'and angled down, so her face is a little larger than the rest of the frame and the ceiling shows behind her. ' +
    'Wide front-camera lens, about 23mm equivalent: mild barrel distortion, her nose and the near cheek slightly enlarged. ' +
    'Her extended arm is cut off at the bottom corner of the frame. ' +
    'Whatever activity the scene describes, at this moment she has paused it to take the selfie: ' +
    'her eyes are open and looking straight into the lens, aware of the camera.',

  // 머리 위에서 내려찍는 각도. 한국 셀카에서 가장 흔한 구도다.
  // ⚠️ 전면카메라 셀카는 폰이 곧 카메라라 화면에 폰이 보이면 안 된다.
  //    명시하지 않으면 모델이 폰 든 손을 그려 거울샷처럼 만들어 버린다.
  selfieOverhead:
    'This photo IS taken by the phone she is holding above her head — the phone itself is the camera ' +
    'and must not appear anywhere in the frame. Her hand and the phone are out of shot. ' +
    'The camera looks steeply down on her from about 40cm above her head, tilted down roughly 40 degrees. ' +
    'Because of the high angle: the top of her head and her forehead are closest to the lens and largest, ' +
    'her chin and shoulders recede and look small, and the background behind her is the floor and her lap, ' +
    'not the wall. Whatever the scene describes her doing, she has paused to take this selfie — ' +
    'she tilts her chin up and looks up directly into the lens. ' +
    'Wide front-camera lens at 23mm equivalent with the mild distortion that angle produces.',

  selfieLow:
    'This photo IS taken by the phone she is holding — the phone must not appear in the frame. ' +
    'A front-camera selfie held at chest height and tilted up slightly, about 40cm from her face, shot in a hurry — ' +
    'her face fills a third of the frame and part of her extended arm shows at the bottom edge; ' +
    'the frame is crooked, part of her shoulder fills the lower left corner, and she is looking at the screen ' +
    'rather than the lens so her eyes are a fraction off-axis. Wide front-camera lens, mild distortion.',

  mirrorSelfie:
    'A mirror selfie taken in her room: she stands holding the phone up in front of her chest, ' +
    'the phone and her hand clearly visible in the reflection, her face partly behind it. ' +
    'The mirror is a little smudged, the tidy room reflected behind her — made bed, clear floor. ' +
    'Shot on the rear camera through the mirror.',

  // ── 남이 찍어준 것 같은 계열 ──
  candidSide:
    'Shot from the side by someone else in the room, she is not aware of the camera, ' +
    'looking down at what she is doing. Her face is in three-quarter profile, one ear toward the lens.',

  overShoulder:
    'Shot from slightly behind and above her shoulder, so we see the back of her head, ' +
    'part of her cheek, and what she is looking at on the desk in front of her.',

  // ── 얼굴이 없거나 작은 계열 (피드에 리듬을 준다) ──
  handsOnly:
    'A close-up of her hands and the desk surface only — her face is not in the frame at all. ' +
    'Shot looking down from her own eye level, phone held in one hand.',

  wideRoom:
    'A wide shot of the whole room taken from the doorway, she is small in the frame and off to one side, ' +
    'absorbed in what she is doing. Most of the frame is the room itself.',
};

// 슬롯별 구도 배분. 첫 장은 항상 셀카로 고정하고(피드 썸네일에 얼굴이 걸리게),
// 나머지는 섞는다. 얼굴 없는 컷을 하나쯤 넣어야 피드에 리듬이 생긴다.
// 방에서만 성립하는 구도. 밖에서 찍는 날엔 빼야 한다
// (전신거울과 방 전경은 편의점·카페에 없다).
export const ROOM_ONLY_COMPOSITIONS = ['mirrorSelfie', 'wideRoom'];

// 장소에 맞는 구도만 남긴다. 전부 걸러지면 원본을 그대로 돌려준다(빈 배열 방지).
export function compositionsForPlace(list, place) {
  if (place === 'room') return list;
  const kept = list.filter((c) => !ROOM_ONLY_COMPOSITIONS.includes(c));
  return kept.length ? kept : list;
}

export const COMPOSITION_SETS = {
  day: {
    first: ['selfieOverhead', 'selfieHigh', 'selfieLow'],
    rest: ['handsOnly', 'candidSide', 'overShoulder'],
  },
  evening: {
    first: ['selfieOverhead', 'selfieLow', 'mirrorSelfie', 'selfieHigh'],
    rest: ['wideRoom', 'overShoulder', 'handsOnly', 'candidSide'],
  },
};

// 불완전성 풀. 한 이미지당 2~3개만 쓴다 — 넘기면 오히려 더 눈에 띄는 AI 티가 된다.
// 반드시 얼굴의 특정 위치에 고정한다. 위치 없는 형용사는 전역 균일 적용돼 무효가 된다.
const IMPERFECTIONS = [
  'a faint under-eye shadow, she looks a little tired',
  'a few flyaway hairs catching the light near her part',
  'her lower lip slightly chapped',
  'a faint shine on her forehead and the bridge of her nose',
  'one eyebrow sitting marginally higher than the other',
  'slight redness at the sides of her nose',
  'one small healing blemish near her chin',
  'uneven colour between her forehead and her jaw',
  'baby hairs along her hairline',
  'dark roots showing at her part',
];

// 결정적 선택 — 같은 씬은 항상 같은 결점을 갖고, 씬이 바뀌면 조합이 바뀐다.
// 피부가 좋아진 시기(glow)에는 「붉은기」·「트러블」을 빼야 한다.
// 안 빼면 phases.glow의 "붉은기가 가라앉았다"와 정면 충돌해서 모델이
// 한쪽으로 몰아버린다 — 지금까지 이 프로젝트에서 사고가 난 패턴이 전부 이 형태였다.
// 다만 질감·피곤함·잔머리는 남긴다. 그게 사라지면 AI 티가 돌아온다.
const SKIN_CONFLICTS = ['slight redness at the sides of her nose', 'one small healing blemish near her chin'];

function pickImperfections(seed, n = 3, phase = 'before') {
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const pool =
    phase === 'glow' ? IMPERFECTIONS.filter((x) => !SKIN_CONFLICTS.includes(x)) : [...IMPERFECTIONS];
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    out.push(...pool.splice(h % pool.length, 1));
  }
  return out.join(', ') + '.';
}

// phase: 'before' | 'after' — 점 제거 에피소드 전/후. 기본값은 PERSONA_PHASE 환경변수.
// framing: 'reel' | 'feedWindow' | 'feedFlash'
// withReference=true면 짧은 identityLock을 쓴다(레퍼런스 이미지를 함께 첨부할 때).
// 긴 얼굴 묘사를 매번 반복하면 토큰이 얼굴로 쏠려 촬영 조건 지시가 묻힌다.
export function scenePrompt(
  persona,
  {
    look = 'news',
    scene = '',
    angle = 'front',
    phase,
    framing = 'reel',
    withReference = false,
    seed = '',
    composition = null, // COMPOSITIONS 키. 주면 angle 대신 이걸 쓴다.
    place = 'room', // setting.places 키. 방 밖에서 찍는 날에 쓴다.
    styling = '', // looks[look] 대신 쓸 구체 복장. 게시물 안에서 옷을 고정할 때.
    expression = '', // 표정 지정. 안 주면 imperfections가 만드는 무심한 얼굴.
    seasonNote = '', // 계절 보정. 고정 배치 중 계절에 안 맞는 물건을 덮어쓴다.
  } = {}
) {
  const a = persona.appearance;
  const ph = phase || process.env.PERSONA_PHASE || 'before';
  const fragment = a.phases?.[ph]?.promptFragment || '';

  // 구도가 지정되면 그게 카메라 위치를 결정한다. 아니면 기존 각도 표현.
  const angleText =
    (composition && COMPOSITIONS[composition]) ||
    {
      front: 'she is turned toward the camera but her eyes are not quite on the lens',
      left: 'turned about 25 degrees to her left, looking away from the lens',
      right: 'turned about 25 degrees to her right, looking past the camera',
    }[angle];

  const identity = withReference
    ? identityLockFor(ph)
    : a.referencePrompt.replace(/\s*Vertical 4:5, head and shoulders\.$/, '');

  return [
    identity,
    // ⚠️ 레퍼런스를 첨부할 때는 점을 말로 다시 설명하지 않는다.
    //    앵커가 시기별로 따로 있어 점 유무가 이미 반영돼 있고,
    //    "레퍼런스대로 베껴라"와 "여기에 그려라"가 충돌하면 모델이 위치를 재해석해 매번 옮긴다.
    withReference ? '' : fragment,
    `Styling: ${styling || a.looks[look]}`,
    a.figurePrompt || '',
    persona.setting?.places?.[place] || persona.setting?.roomPrompt || '',
    seasonNote,
    scene ? `Action: ${scene}` : '',
    FRAMING[framing] || FRAMING.reel,
    angleText,
    expression ? `Her expression: ${expression}.` : '',
    `Her face shows ${pickImperfections(seed || `${look}-${framing}-${scene}`, 3, ph)}`,
    'Unedited camera roll photo. No filter, no retouching, no beauty app.',
    'No legible text or characters anywhere in the image, no watermark, no logo.',
    // 화면은 글자를 부르는 가장 강한 유인이다. 따로 못박지 않으면 영문 UI를 그려 넣어
    // (한국인 일상 사진에 영어 앱 화면) 단번에 AI 티가 난다.
    'Any phone, laptop or monitor screen in frame shows only blurred, indistinct interface shapes — ' +
    'no readable words, no numbers, no app names, and no visible brand logos on any device.',
  ]
    .filter(Boolean)
    .join('\n');
}
