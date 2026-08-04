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

function backend(wantRef) {
  const explicit = process.env.IMAGE_BACKEND;
  const hasOmni = Boolean(process.env.OMNIROUTE_URL && process.env.OMNIROUTE_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  // 레퍼런스 첨부가 필요하면 OmniRoute(OpenAI 형식)로는 불가 → gemini 우선
  if (wantRef && hasGemini) return 'gemini';
  if (explicit === 'omniroute' && hasOmni) return 'omniroute';
  if (explicit === 'gemini' && hasGemini) return 'gemini';
  if (hasOmni) return 'omniroute';
  if (hasGemini) return 'gemini';
  throw new Error('이미지 백엔드 없음: OMNIROUTE_URL+OMNIROUTE_API_KEY 또는 GEMINI_API_KEY 필요');
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
  const which = backend(refImages.length > 0);
  let lastErr;

  for (let attempt = 0; attempt < 3; attempt++) {
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
      if (e.fatal) throw e;
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export function activeBackend(wantRef = false) {
  try {
    return backend(wantRef);
  } catch {
    return null;
  }
}

// 씬 프롬프트를 조립한다. 각도를 정면 ±30°로 묶는 게 드리프트를 가장 크게 줄인다.
// phase: 'before' | 'after' — 점 제거 에피소드 전/후. 기본값은 PERSONA_PHASE 환경변수.
export function scenePrompt(persona, { look = 'news', scene = '', angle = 'front', phase } = {}) {
  const a = persona.appearance;
  const ph = phase || process.env.PERSONA_PHASE || 'before';
  const fragment = a.phases?.[ph]?.promptFragment || '';

  const angleText = {
    front: 'facing the camera directly',
    left: 'turned about 25 degrees to her left, still facing camera',
    right: 'turned about 25 degrees to her right, still facing camera',
  }[angle];

  return [
    a.referencePrompt,
    fragment, // 시기별 차이(입가 점 유무)
    `Styling: ${a.looks[look]}`,
    // 방 배치를 매번 동일하게 박는다. 이게 없으면 같은 사람이어도 다른 채널처럼 보인다.
    persona.setting?.roomPrompt || '',
    scene ? `Action: ${scene}` : '',
    `Camera: ${angleText}. Keep the head angle within 30 degrees of frontal.`,
    // 눈물점은 영구 표식이라 매번 반복해야 유지된다
    `Important: keep the single small beauty mark below her left eye in the same position.`,
    `Do not beautify or slim the face. Keep the ordinary, natural look.`,
    `No text, no watermark, no logo in the image.`,
  ]
    .filter(Boolean)
    .join('\n');
}
