// 페르소나 이미지 생성 (Google Gemini Image).
// 얼굴 일관성의 핵심은 두 가지다:
//   1) hana.appearance.referencePrompt를 절대 바꾸지 않는다 (바꾸면 다른 사람이 된다)
//   2) 기준 시트를 만든 뒤에는 그 이미지를 레퍼런스로 첨부해 생성한다
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// 3.1 flash image = 품질/비용 균형. 인물 일관성은 레퍼런스 첨부로 확보한다.
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

function apiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY 없음 (.env에 추가하세요)');
  return k;
}

// 응답에서 첫 이미지 파트를 꺼낸다. 모델이 텍스트만 돌려주는 경우가 있어 그때는 사유를 남긴다.
function extractImage(body) {
  const parts = body?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const d = p.inlineData || p.inline_data;
    if (d?.data) return Buffer.from(d.data, 'base64');
  }
  const text = parts.map((p) => p.text).filter(Boolean).join(' ').slice(0, 200);
  const finish = body?.candidates?.[0]?.finishReason;
  throw new Error(`이미지 없음 (finishReason=${finish}) ${text}`);
}

// prompt로 이미지 1장 생성. refImages(파일 경로 배열)를 주면 그 인물을 유지하도록 첨부한다.
export async function generateImage(prompt, { refImages = [], outPath } = {}) {
  const parts = [];
  for (const ref of refImages.slice(0, 4)) {
    parts.push({
      inlineData: { mimeType: 'image/png', data: readFileSync(ref).toString('base64') },
    });
  }
  parts.push({ text: prompt });

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/${MODEL}:generateContent?key=${apiKey()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (res.status === 429 || res.status >= 500) throw new Error(`retryable ${res.status}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw Object.assign(
          new Error(`gemini image ${res.status}: ${String(body?.error?.message || '').slice(0, 200)}`),
          { fatal: true }
        );
      }

      const buf = extractImage(body);
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

// 씬 프롬프트를 조립한다. 각도를 정면 ±30°로 묶는 게 드리프트를 가장 크게 줄인다.
export function scenePrompt(persona, { look = 'news', scene = '', angle = 'front' } = {}) {
  const a = persona.appearance;
  const angleText = {
    front: 'facing the camera directly',
    left: 'turned about 25 degrees to her left, still facing camera',
    right: 'turned about 25 degrees to her right, still facing camera',
  }[angle];

  return [
    a.referencePrompt,
    `Styling: ${a.looks[look]}`,
    scene ? `Scene: ${scene}` : '',
    `Camera: ${angleText}. Keep the head angle within 30 degrees of frontal.`,
    // 식별 표식을 매번 반복해야 유지된다
    `Important: keep the beauty mark below her left eye and the mole above the right corner of her mouth visible and in the same positions.`,
    `Do not beautify or slim the face. Keep the ordinary, natural look.`,
    `No text, no watermark, no logo in the image.`,
  ]
    .filter(Boolean)
    .join('\n');
}
