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

  let chain = [];
  if (hasGemini) chain.push('gemini');
  if (hasOmni) chain.push('omniroute');

  // 레퍼런스 첨부는 OpenAI 형식(/v1/images/generations)이 지원하지 않는다 → gemini만.
  if (wantRef) chain = chain.filter((b) => b === 'gemini');

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
          which === 'omniroute' ? await viaOmniroute(prompt, size) : await viaGemini(prompt, refImages);
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
const FRAMING = {
  feedWindow:
    'Vertical 4:5. A snapshot from her own camera roll, shot on a phone main camera at 26mm equivalent, f/1.8, ' +
    'so the room behind her stays sharp and readable instead of blurring out. ' +
    'Late afternoon light comes only from the single window at camera left: the far side of her face is about two stops darker, ' +
    'a hard shadow falls under her jaw onto her neck, and a bright stripe lands on the wall beside her. ' +
    'The white balance is caught between the window and the ceiling LED, so the shadows carry a faint cool cast. ' +
    'Handheld and tilted about two degrees, she sits left of centre with dead space on the right, ' +
    'the top of her hair just clipped by the frame edge, and one object cropped by the right edge. ' +
    'Focus landed slightly behind her eyes, on her ear. ' +
    'ISO 800: grain in the shadows, a small blown highlight on her forehead, corners a little dark and soft.',

  feedFlash:
    'Vertical 4:5. A snapshot taken at night in her room with the phone flash on, 26mm equivalent. ' +
    'The flash is the only light: a hard specular highlight on her forehead, nose and cheekbones, ' +
    'a sharp dark shadow thrown onto the wall behind her shoulder, and the background falling off to near black. ' +
    'Her eyes catch a small round flash reflection. Slight red-eye correction artifact. ' +
    'Handheld, framing casual and a little crooked, subject off-centre. ' +
    'Colours look slightly washed out and cool the way direct phone flash renders skin.',

  reel:
    'Vertical 9:16, head and shoulders with room above her. Shot on a phone propped on the desk, 26mm equivalent, f/1.8. ' +
    'Window light from camera left only — one side of her face clearly darker, a shadow under the jaw. ' +
    'She sits slightly off-centre. Focus on her face, the room behind still legible. ' +
    'Mild grain in the shadows, corners a touch darker.',
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
function pickImperfections(seed, n = 3) {
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const pool = [...IMPERFECTIONS];
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
  { look = 'news', scene = '', angle = 'front', phase, framing = 'reel', withReference = false, seed = '' } = {}
) {
  const a = persona.appearance;
  const ph = phase || process.env.PERSONA_PHASE || 'before';
  const fragment = a.phases?.[ph]?.promptFragment || '';

  const angleText = {
    front: 'she is turned toward the camera but her eyes are not quite on the lens',
    left: 'turned about 25 degrees to her left, looking away from the lens',
    right: 'turned about 25 degrees to her right, looking past the camera',
  }[angle];

  const identity = withReference
    ? a.identityLock
    : a.referencePrompt.replace(/\s*Vertical 4:5, head and shoulders\.$/, '');

  return [
    identity,
    // ⚠️ 레퍼런스를 첨부할 때는 점을 말로 다시 설명하지 않는다.
    //    앵커가 시기별로 따로 있어 점 유무가 이미 반영돼 있고,
    //    "레퍼런스대로 베껴라"와 "여기에 그려라"가 충돌하면 모델이 위치를 재해석해 매번 옮긴다.
    withReference ? '' : fragment,
    `Styling: ${a.looks[look]}`,
    persona.setting?.roomPrompt || '',
    scene ? `Action: ${scene}` : '',
    FRAMING[framing] || FRAMING.reel,
    angleText,
    `Her face shows ${pickImperfections(seed || `${look}-${framing}-${scene}`)}`,
    'Unedited camera roll photo. No filter, no retouching, no beauty app.',
    'No legible text or characters anywhere in the image, no watermark, no logo.',
  ]
    .filter(Boolean)
    .join('\n');
}
