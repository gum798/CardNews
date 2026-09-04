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
import { cloudflare, paths } from '../config.js';
import { foregroundMatte } from '../video/matte.js';
import { identityLockFor, currentStage, makeupFor } from './hana.js';
import { estimateNeurons, record as recordNeurons, markExhausted, isExhausted } from './budget.js';

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

// ⚠️ 레퍼런스는 두 종류다: 신원(하나 얼굴)과 장소(도서관·헬스장 실사 사진).
//    신원 레퍼런스만 얼굴로 자른다 — 장소 사진을 자르면 그 공간이 안 나온다.
//    구분은 얼굴 크기로 한다: 신원 사진의 얼굴은 세로 15~20%, 장소 사진 배경 인물은 2% 미만.
const IDENTITY_FACE_RATIO = 0.1;

// ⚠️ 얼굴 「개수」가 아니라 「크기」로 갈라야 한다. 방 사진에도 그녀가 작게 찍혀 있어서
//    개수로 보면 인물 사진으로 오판하고 방을 잘라낸다(실측: 사용자가 준 방 전경 사진).
//    tools/qc의 bigFaces는 세로 10% 이상인 얼굴만 세므로 IDENTITY_FACE_RATIO와 같은 기준이다.
//    실패하면 -1을 주고 호출부가 기존(인물) 동작을 유지하게 한다.
async function bigFaceCount(imgPath) {
  try {
    const { stdout } = await execFileAsync(path.join(paths.root, 'tools', 'qc'), [imgPath], { timeout: 30_000 });
    const m = String(stdout).match(/bigFaces=(\d+)/);
    return m ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}

async function headCropForRef(imgPath) {
  const out = path.join(os.tmpdir(), 'cfref-' + path.basename(imgPath).replace(/[^\w.]/g, '_') + '.jpg');
  try {
    const info = await foregroundMatte(imgPath);
    const isIdentity = info?.face && info.face.h / info.height >= IDENTITY_FACE_RATIO;
    if (info && !isIdentity) {
      // 장소 레퍼런스: 통째로 넘긴다(긴 변 480). CF가 어차피 512 미만으로 줄인다.
      await execFileAsync(FFMPEG_BIN, ['-v','error','-i',imgPath,'-vf','scale=480:480:force_original_aspect_ratio=decrease','-q:v','3',out,'-y']);
      return out;
    }
    if (info) {
      // ⚠️ 인물 bbox로 자르면 셀카의 「폰 든 팔」과 옷이 같이 들어가고, 생성물이 그
      //    포즈·복장을 그대로 베낀다(뉴스 세트에 나시티+폰이 나온 실측 사례).
      //    얼굴 박스가 있으면 그 주변만 잘라 신원만 넘긴다 — 나머지는 프롬프트가 정한다.
      // ⚠️ 1.8배로 자르면 앵커의 남색 정장 옷깃과 흰 셔츠가 프레임에 남고, 그게 그대로
      //    생성물의 옷이 된다(실측: 흰 반팔 지시인데 5장 중 2장이 남색 정장으로 나옴).
      //    1.35배면 얼굴·머리만 남아 옷은 프롬프트가 정한다. 신원 정보는 얼굴에 다 있다.
      const f = info.face;
      const side = f
        ? Math.min(Math.round(f.h * 1.35), info.width, info.height)
        : Math.min(Math.round(info.bbox.w * 1.15), info.width);
      const cx = f ? f.x + f.w / 2 : info.bbox.x + info.bbox.w / 2;
      const cy = f ? f.y + f.h / 2 : info.bbox.y + side / 2;
      const x = Math.max(0, Math.min(info.width - side, Math.round(cx - side / 2)));
      const y = Math.max(0, Math.min(info.height - side, Math.round(cy - side / 2)));
      await execFileAsync(FFMPEG_BIN, ['-v','error','-i',imgPath,'-vf',`crop=${side}:${side}:${x}:${y},scale=480:480`,'-q:v','3',out,'-y']);
      return out;
    }
  } catch { /* 폴백으로 */ }

  // ⚠️ matte는 「사람」을 찾는 도구라 사람이 없는 장소 사진에서는 항상 null을 준다.
  //    예전엔 그걸 전부 인물 사진으로 보고 중앙 상단 정사각으로 잘랐는데,
  //    빈 방 기준 사진을 넣으면 방이 잘려 구조 레퍼런스 역할을 못 한다(실측).
  //    얼굴이 실제로 있는지로 갈라야 한다.
  const faces = await bigFaceCount(imgPath);
  if (faces === 0) {
    // 장소 레퍼런스: 통째로 넘긴다(긴 변 480).
    await execFileAsync(FFMPEG_BIN, ['-v','error','-i',imgPath,'-vf','scale=480:480:force_original_aspect_ratio=decrease','-q:v','3',out,'-y']);
    return out;
  }
  // 인물 사진인데 매트만 실패: 중앙 상단 정사각 크롭 (관례상 얼굴은 상단 중앙에 있다)
  await execFileAsync(FFMPEG_BIN, ['-v','error','-i',imgPath,'-vf',// ⚠️ ffmpeg 필터에서 min(iw,ih)의 쉼표는 필터 구분자로 파싱된다. 반드시 이스케이프.
      'crop=w=min(iw\\,ih):h=min(iw\\,ih):x=(iw-min(iw\\,ih))/2:y=0,scale=480:480','-q:v','3',out,'-y']);
  return out;
}

// CF 계정별로 「오늘 아직 살아 있나」를 아주 싼 호출로 확인해 장부에 반영한다.
// CF는 남은 뉴런 조회 API가 없어서 장부는 추정일 뿐이고, 자정(UTC) 초기화가 계정마다
// 제때 안 오기도 한다(실측 2026-09-04: 계정 1은 00:50 UTC에도 429, 계정 2는 초기화됨).
// 글값(claude 호출)을 쓰기 전에 이걸로 재면 「장부는 여유·실제는 전 계정 429」를 피한다.
// 비용: flux-1-schnell 1024x1024 한 장 = 약 40뉴런/계정. 이미 소진 표시된 계정은 건너뛴다.
export async function probeCloudflare({ log = console.log } = {}) {
  const accounts = cloudflare.accounts.length ? cloudflare.accounts : [{ accountId: cloudflare.accountId, token: cloudflare.aiToken }];
  const model = '@cf/black-forest-labs/flux-1-schnell';
  let alive = 0;
  for (let ai = 0; ai < accounts.length; ai++) {
    if (isExhausted(ai)) continue;
    const acct = accounts[ai];
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct.accountId}/ai/run/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${acct.token}`, 'Content-Type': 'application/json' },
        // ⚠️ schnell은 width/height를 받지 않는다(넣으면 400 Bad input, 실측). 기본 1024x1024·1스텝.
        body: JSON.stringify({ prompt: 'a plain grey wall', steps: 1 }),
        signal: AbortSignal.timeout(60_000),
      });
      await res.arrayBuffer();
      if (res.status === 429) { markExhausted(ai); log(`[persona] cf 계정 ${ai + 1} 오늘 소진(탐침)`); continue; }
      if (!res.ok) { log(`[persona] cf 계정 ${ai + 1} 탐침 ${res.status} — 판단 보류`); alive++; continue; }
      recordNeurons(estimateNeurons(model, { width: 1024, height: 1024 }), ai);
      alive++;
    } catch (e) {
      // 네트워크 문제는 소진이 아니다. 살아 있는 쪽으로 세되 로그는 남긴다.
      log(`[persona] cf 계정 ${ai + 1} 탐침 실패 — 판단 보류: ${e.message}`);
      alive++;
    }
  }
  return { alive, total: accounts.length };
}

async function viaCloudflare(prompt, refImages, size, modelOverride) {
  // 호출부가 모델을 지정할 수 있다. 뉴스 키프레임처럼 화질이 덜 중요한 쪽은 싼 모델로
  // 내려서 하루 뉴런을 브이로그 피드 사진에 몰아준다(9B 1장 = 4B 아홉 장 값).
  const model = modelOverride || cloudflare.imageModel;
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
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct.accountId}/ai/run/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${acct.token}` },
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
    buf = Buffer.from(await res.arrayBuffer());
    // 성공한 호출만 뉴런을 장부에 적는다. 429는 뉴런을 안 쓰지만 「이 계정은 오늘 끝」으로
    // 표시한다 — 안 그러면 장부는 여유 있다는데 실제론 전 계정 429인 상태를 가드가 못 잡는다
    // (실측 2026-09-04: 남은 12,794라며 통과 → 5장 전원 실패).
    if (res.ok) { recordNeurons(estimateNeurons(model, { width: w, height: h, refs: Math.min(refImages.length, 4) }), ai); break; }
    if (res.status === 429) markExhausted(ai);
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
export async function generateImage(prompt, { refImages = [], outPath, size, model } = {}) {
  const chain = backendChain(refImages.length > 0);
  let lastErr;

  // 백엔드 하나가 할당량(429)에 걸려도 다른 쪽으로 넘어간다. 둘 다 무료라 비용은 안 든다.
  for (const which of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const buf =
          which === 'omniroute' ? await viaOmniroute(prompt, size)
          : which === 'cf' ? await viaCloudflare(prompt, refImages, size, model)
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

  // 뉴스 세트용. reel은 「방 창문 조명」을 전제하므로 링라이트 세트와 싸운다.
  // 정면 링라이트지만 값싼 장비라 균일하지 않다 — 그 어설픔이 세트 컨셉과 맞는다.
  reelSet:
    'Vertical 9:16 with room above her head, framed chest-up so the paper backdrop fills the frame behind her. ' +
    'Shot on a phone propped on a small tripod at eye level, 26mm equivalent, f/1.8. ' +
    'A cheap clip-on ring light is the key light, slightly off to one side rather than dead centre, ' +
    'so one cheek is brighter and a soft double shadow falls on the paper behind her. ' +
    'A small ring-shaped catchlight sits in each eye. The room lamp adds a warmer tint on the shadow side. ' +
    'Mild grain, corners a touch darker, the frame very slightly off level. ' +
    // ⚠️ 레퍼런스가 셀카라 옷차림과 폰 든 손이 그대로 따라온다(실측). 여기서 덮어쓴다.
    'This is NOT a selfie: the phone is on a tripod and must not appear in the frame, ' +
    'and neither of her hands holds a phone — they rest on the desk or hold the script pages. ' +
    'She is dressed for filming in the navy interview blazer over a white blouse, ' +
    'regardless of what she wears in the reference images.',

  // 밤의 방. 플래시 없이 실내등만 — feedFlash(플래시 직광)와 다른 부드러운 밤 룩.
  // 밤 소재(열대야·새벽 공부)에서 창밖이 대낮이면 글과 그림이 어긋난다.
  feedNight:
    'Vertical 4:5, a snapshot straight from her camera roll, taken at night in her room. ' +
    'The windows are dark — just faint reflections of the room in the glass, no daylight at all. ' +
    'The room is lit by the warm ceiling light and a small desk lamp: soft, slightly yellow, ' +
    'uneven light with gentle shadows, dimmer toward the corners of the room. ' +
    'ISO 1600: visible grain, especially in the shadows, and slightly muted colours. ' +
    'Handheld, the frame tilted a couple of degrees.',

  // 야외 해질녘. feedPublic은 실내 형광등을 전제하므로 바닷가·공원에는 못 쓴다.
  feedOutdoorGolden:
    'Vertical 4:5, a snapshot straight from her camera roll, taken outdoors in the last hour before sunset. ' +
    'The low sun is behind her at an angle: a warm rim of light runs along her hair and one shoulder, ' +
    'her face sits in soft open shade and is a stop darker than the bright background, ' +
    'and a lens flare streaks across one corner. ' +
    'The sky and water are blown out slightly near the horizon. ' +
    'Warm colour cast overall, deep contrast, ISO 100: clean but with visible sensor noise in the shadows. ' +
    'Shot at f/1.8 with focus locked on her face, so everything more than a metre behind her falls into soft bokeh and background surfaces read as smooth blocks of colour. ' +
    'Handheld, the frame tilted a couple of degrees, framing casual and not quite level.',

  // 야외 흐림·비. 구름이 거대한 디퓨저라 그림자가 거의 없고 색이 빠진다 —
  // 골든아워와 정반대 조건이라 같은 프레이밍으로 못 덮는다.
  feedOutdoorOvercast:
    'Vertical 4:5, a snapshot straight from her camera roll, taken outdoors under a heavy overcast sky. ' +
    'The cloud layer acts as one huge softbox: the light is flat and comes from straight above, ' +
    'so there are almost no shadows, only a soft darkening under her chin and brow. ' +
    'Colours are desaturated and slightly cool-blue; the sea and sky are grey and the horizon is hazy. ' +
    'It has been raining on and off — the sand is damp and darker where it is wet, ' +
    'and a few raindrops sit on the lens edge. Her hair is dry apart from a couple of stray strands. ' +
    'ISO 400, mild grain, corners a touch darker. Handheld, the frame tilted a couple of degrees.',

  // 집 밖 + 밤/새벽. feedPublic은 「대낮」을 전제해서 새벽 장면과 싸운다.
  feedPublicNight:
    'Vertical 4:5, a snapshot straight from her camera roll, taken before sunrise. ' +
    'Outside is still dark — only the first blue-grey light in the sky — so the interior lighting ' +
    'dominates and the windows act as mirrors, reflecting the room back. ' +
    'The overhead fluorescent light is flat, slightly green and cold, and it comes from directly above, ' +
    'so there are small shadows under her eyes and nose. ' +
    'ISO 1600: visible grain, slightly muted colours, corners a touch darker. ' +
    'Shot at f/1.8 with focus locked on her face, so everything more than a metre behind her falls into soft bokeh and background surfaces read as smooth blocks of colour. ' +
    'Handheld, the frame tilted a couple of degrees.',

  // 집 밖 실내 + 저녁. feedPublicNight는 「해 뜨기 전 형광등」이라 저녁 식당·극장·카페의
  // 따뜻한 조명과 싸운다(일정 브이로그, 2026-09-04).
  // ⚠️ 창문·색온도를 여기서 단정하지 않는다 — 극장 로비는 창이 없고 차가운 조명이고,
  //    카페는 따뜻하다. 그건 장소 블록(hana.setting.places)이 말한다. 여기선 「밤이다」와
  //    카메라·노출만.
  feedIndoorNight:
    'Vertical 4:5, a snapshot straight from her camera roll, taken indoors in the evening. ' +
    'It is already night outside, so the interior lighting of the place is the only light, ' +
    'and any window in the frame is dark and reflects the room back. ' +
    'That light is soft and uneven, with gentle shadows and dimmer far corners. ' +
    'ISO 1600: visible grain, especially in the shadows, slightly muted colours, corners a touch darker. ' +
    'Shot at f/1.8 with focus locked on her face, so everything more than a metre behind her falls into soft bokeh and background surfaces read as smooth blocks of colour. ' +
    'Handheld, the frame tilted a couple of degrees.',

  // 야외 + 밤. 가로등·간판 불빛만 있는 조건이라 실내 프레이밍을 못 쓴다.
  feedOutdoorNight:
    'Vertical 4:5, a snapshot straight from her camera roll, taken outdoors at night. ' +
    'The sky is deep blue-black. The only light comes from street lamps, shop signs and distant ' +
    'city lights: her face is lit warm on one side by the nearest lamp and falls into shadow on the other, ' +
    'and the lights behind her bloom into soft glowing dots. ' +
    'ISO 3200: heavy grain, muted colours, blacks slightly lifted, corners darker. ' +
    // ⚠️ 아래 문장은 SHALLOW_DOF와 글자 단위로 같아야 한다 — framingForDistance가 그 문장을 찾아
    //    와이드/디테일 컷에서 바꿔 끼운다. 한 단어라도 다르면 밤 산책 와이드 컷이 f/1.8로 남는다.
    'Shot at f/1.8 with focus locked on her face, so everything more than a metre behind her falls into soft bokeh and background surfaces read as smooth blocks of colour. ' +
    'Handheld, a hint of motion blur in the background lights, the frame tilted a couple of degrees.',

  // 집 밖에서 낮에 찍은 컷. feedWindow/feedFlash는 「그녀의 방」·「밤」을 전제하므로
  // 편의점·카페 같은 장소에서 쓰면 장소 묘사와 정면으로 싸운다.
  feedPublic:
    'Vertical 4:5, a snapshot straight from her camera roll, taken in the middle of the day. ' +
    'Two light sources fight each other: flat daylight through the big window beside her and ' +
    'greenish fluorescent tubes overhead, so the white balance never fully resolves — ' +
    'the daylight side of her face reads slightly blue, the shadow side slightly green. ' +
    'The window side is about a stop and a half brighter and a little blown near the glass. ' +
    'ISO 400: light grain, corners a touch dark and soft. ' +
    'Shot at f/1.8 with focus locked on her face, so everything more than a metre behind her falls into soft bokeh and background surfaces read as smooth blocks of colour. ' +
    'Handheld, the frame tilted a couple of degrees, framing casual and not quite level.',
};

// 사진 구도 풀. 인스타에 실제로 올라오는 형태들이다.
// 매번 같은 "책상 앞 반신"이면 계정 전체가 한 장짜리처럼 보인다.
// 셀카는 전면카메라 특성(광각·팔 길이·약간 위에서)을 명시해야 셀카로 읽힌다.
export const COMPOSITIONS = {
  // ⚠️ 이 문자열들은 프롬프트 2번 자리에 들어간다 — 실측상 「어떤 그림이 되는가」를
  //    사실상 결정하는 자리다. 그래서 여기에 장소를 적으면 맨 뒤의 장소 블록을 이긴다.
  //    예전 문자열들은 전부 그녀의 방을 전제하고 있었다("in the room", "on the desk",
  //    "the ceiling shows behind her", "the background is the floor and her lap").
  //    그 결과 가구매장 소재인데 5장 전부 남의 집 침실에서 찍힌 채로 나왔다(2026-08-31 실측).
  //    → 규칙: 구도는 카메라 위치·렌즈·거리·행동만 말한다. 장소 이름과 가구는 말하지 않는다.
  //    가구가 필요하면 "the surface in front of her"처럼 장소가 채워 넣을 자리로 비워둔다.

  // ── 셀카 계열 (가까움) ──
  selfieHigh:
    'This photo IS taken by the phone she is holding — the phone itself is the camera and stays out of frame. ' +
    'A front-camera selfie at arm\'s length, about 45cm from her face, raised slightly above eye level and angled down. ' +
    'Wide front-camera lens, about 23mm equivalent: mild barrel distortion, her nose and near cheek slightly enlarged. ' +
    'Her extended arm is cut off at the bottom corner. ' +
    'Whatever the scene describes, she has paused it to take this selfie: eyes open and looking into the lens.',

  selfieOverhead:
    'This photo IS taken by the phone she holds above her head — the phone itself is the camera and stays out of frame. ' +
    'The camera looks down on her from about 40cm above, tilted down roughly 40 degrees, so the top of her head reads ' +
    'largest and her chin and shoulders recede. ' +
    'She tilts her chin up into the lens. Wide front-camera lens at 23mm equivalent with the distortion that angle gives.',

  selfieLow:
    'This photo IS taken by the phone she is holding — the phone itself is the camera and stays out of frame. ' +
    'A front-camera selfie held at chest height and tilted up slightly, about 40cm from her face, shot in a hurry: ' +
    'her face fills a third of the frame, part of her extended arm shows at the bottom edge, the frame is crooked, ' +
    'and she is looking at the screen rather than the lens so her eyes sit a fraction off-axis.',

  // 셀카인데 뒤 공간이 살아 있는 컷. 「어디에 있는지 보이는 셀카」가 없어서 새로 넣는다.
  selfieWithPlace:
    'This photo IS taken by the phone she is holding — the phone itself is the camera and stays out of frame. ' +
    'She holds it out at full arm\'s length and leans back so the camera catches the space she is standing in, ' +
    'not just her face: her head and shoulders sit in the lower third of the frame and off to one side, ' +
    'and the upper two thirds are the place opening up behind and above her, in focus and legible. ' +
    'Wide front-camera lens, 23mm equivalent. She looks into the lens.',

  // ── 남이 찍어준 것 같은 계열 (중간) ──
  candidSide:
    'Shot from the side by someone standing a couple of metres away, she is unaware of the camera, ' +
    'looking down at what she is doing. Her face is in three-quarter profile, one ear toward the lens. ' +
    'Her whole upper body is in frame with space around her.',

  overShoulder:
    'Shot from slightly behind and above her shoulder, so we see the back of her head, part of her cheek, ' +
    'and what she is looking at on the surface in front of her.',

  // 남이 몇 걸음 떨어져 찍어준 전신. 방 밖 소재에 「사람이 공간 안에 서 있는」 컷이 없었다.
  fullBodyCandid:
    'Shot by someone standing five or six metres away, holding the phone vertically at chest height. ' +
    'She is in full length from head to feet, standing about a third of the way in from one edge, ' +
    'and she takes up roughly half the height of the frame. The rest of the frame is the space around her, ' +
    'sharp enough to read. She is absorbed in what she is doing and not looking at the camera.',

  // ── 공간이 주인공인 계열 (넓음) ──
  // ⚠️ 얼굴이 작아지면 앵커 신원이 무너진다. 그래서 「멀리서 찍되 얼굴은 알아볼 수 있는
  //    거리」로 못박는다. "she is small in the frame" 같은 표현은 쓰지 않는다 —
  //    검증 결과 그러면 얼굴이 30px가 되어 신원도 QC도 같이 무너진다.
  wideEstablishing:
    'A wide establishing shot taken from about eight metres back, phone held vertically at chest height. ' +
    'The space itself takes up most of the frame — it runs away from the camera and its far end is visible — ' +
    'and she stands in the middle distance, turned three-quarters away, occupying about a third of the frame height. ' +
    'Her face is still clearly readable at that distance. Everything from her to the far end stays in focus.',

  downTheAisle:
    'Shot straight down a long open run of the space from about six metres back, so the two sides of it ' +
    'frame the picture and converge toward a bright far end. She stands off-centre in the middle distance, ' +
    'facing away and looking at something to one side, taking up about a third of the frame height. ' +
    'Her face reads in profile. The whole depth of the run is in focus.',

  // ── 얼굴이 없거나 작은 계열 (디테일 — 피드에 리듬을 준다) ──
  // ⚠️ 원래 "her face is not in the frame at all"이라고 썼는데 이건 네거티브라 FLUX.2가 무시한다
  //    (실측 2026-08-31: 손만 나와야 할 4번 컷에 얼굴이 그대로 나옴).
  //    「무엇이 없다」 대신 「프레임이 무엇으로 가득 차고 어디서 끝나는가」로 쓴다.
  handsOnly:
    'The camera points straight down at the surface in front of her from chest height. ' +
    'That surface and her two hands working on it fill the frame edge to edge, ' +
    'and the top edge of the frame cuts across her forearms.',

  // 같은 이유로 긍정형. 프레임의 끝을 손목으로 못박아 얼굴이 들어올 자리를 남기지 않는다.
  objectDetail:
    'The one object this moment is about fills the frame edge to edge, held in or just under her hands. ' +
    'The camera looks straight down at it from chest height and the frame ends at her wrists, ' +
    'with one sleeve entering from a corner. The background falls away soft behind the object.',

  // ── 방 전용 ──
  mirrorSelfie:
    'A mirror selfie: she stands holding the phone up in front of her chest, the phone and her hand clearly ' +
    'visible in the reflection, her face partly behind it. The mirror is a little smudged, her tidy room ' +
    'reflected behind her — made bed, clear floor. Shot on the rear camera through the mirror.',

  wideRoom:
    'A wide shot of the whole room taken from the doorway, she is seated or standing off to one side and ' +
    'absorbed in what she is doing, taking up about a third of the frame height. Most of the frame is the room itself.',
};

// 구도별 촬영 거리. 이게 있어야 「5장의 거리 배분」을 강제할 수 있다.
// ⚠️ 예전엔 거리라는 축 자체가 없어서, 서로 다른 구도 키 5개가 전부 팔 길이 셀카일 수 있었다.
//    실제로 2026-08-31 이케아 5장이 정확히 그렇게 나왔다.
export const COMPOSITION_DISTANCE = {
  selfieHigh: 'close',
  selfieOverhead: 'close',
  selfieLow: 'close',
  selfieWithPlace: 'medium',
  candidSide: 'medium',
  overShoulder: 'medium',
  fullBodyCandid: 'wide',
  wideEstablishing: 'wide',
  downTheAisle: 'wide',
  handsOnly: 'detail',
  objectDetail: 'detail',
  mirrorSelfie: 'close',
  wideRoom: 'wide',
};

// 슬롯별 구도 배분. 첫 장은 항상 셀카로 고정하고(피드 썸네일에 얼굴이 걸리게),
// 나머지는 섞는다. 얼굴 없는 컷을 하나쯤 넣어야 피드에 리듬이 생긴다.
// 방에서만 성립하는 구도. 밖에서 찍는 날엔 빼야 한다
// (전신거울과 방 전경은 편의점·카페에 없다).
// 장소의 「종류」. 같은 실내라도 6평 원룸과 2만평 창고는 성립하는 구도가 다르다.
// ⚠️ 예전엔 이 축이 없어서 room이냐 아니냐로만 갈랐고, 유일한 와이드 구도(wideRoom)가
//    방 밖에서 전부 제거됐다. 그래서 가구매장·헬스장·바닷가에 「공간이 보이는 컷」을
//    만들 수단이 아예 없었다(2026-08-31 실측: 이케아 5장 전부 팔 길이 셀카).
export const VENUE_OF_PLACE = {
  room: 'home',
  movingRoom: 'home',
  // 넓은 실내 — 멀리까지 시선이 뻗는 곳. 와이드가 성립한다.
  ikea: 'largeVenue',
  gym: 'largeVenue',
  gymMassage: 'largeVenue',
  library: 'largeVenue',
  laundromat: 'smallIndoor',
  libraryCafe: 'smallIndoor',
  cafe: 'smallIndoor',
  convenienceStore: 'smallIndoor',
  chinatown: 'smallIndoor',
  // 야외 — 하늘과 지평선이 있어 가장 넓게 찍을 수 있다.
  beach: 'outdoor',
  park: 'outdoor',
  nightStreet: 'outdoor',
  bathhouseStreet: 'outdoor',
  busStop: 'outdoor',
  earlyTrain: 'transit',
  // ── 인플루언서 아크에서 추가 ──
  hotplaceCafe: 'largeVenue',
  noodleShop: 'smallIndoor',
  nightView: 'outdoor',
  beautyStore: 'smallIndoor',
  marketAlley: 'outdoor',
  hanokAlley: 'outdoor',
  riversideDusk: 'outdoor',
  // ── 일정 브이로그(2026-09-04)에서 추가 ──
  restaurant: 'smallIndoor',
  cinema: 'largeVenue',
  riverNight: 'outdoor',
};

export function venueOf(place) {
  return VENUE_OF_PLACE[place] || 'smallIndoor';
}

// 장소 종류별로 성립하는 구도. 없는 종류는 smallIndoor로 떨어진다.
// ⚠️ mirrorSelfie·wideRoom은 전신거울과 방 전경이라 집에서만 성립한다.
const VENUE_COMPOSITIONS = {
  home:        ['selfieHigh','selfieOverhead','selfieLow','mirrorSelfie','candidSide','overShoulder','handsOnly','objectDetail','wideRoom'],
  largeVenue:  ['selfieHigh','selfieOverhead','selfieLow','selfieWithPlace','candidSide','overShoulder','fullBodyCandid','wideEstablishing','downTheAisle','handsOnly','objectDetail'],
  smallIndoor: ['selfieHigh','selfieOverhead','selfieLow','selfieWithPlace','candidSide','overShoulder','fullBodyCandid','handsOnly','objectDetail'],
  outdoor:     ['selfieHigh','selfieOverhead','selfieLow','selfieWithPlace','candidSide','fullBodyCandid','wideEstablishing','handsOnly','objectDetail'],
  transit:     ['selfieHigh','selfieOverhead','selfieLow','selfieWithPlace','candidSide','overShoulder','downTheAisle','handsOnly','objectDetail'],
};

// 장소에 맞는 구도만 남긴다. 전부 걸러지면 원본을 그대로 돌려준다(빈 배열 방지).
export function compositionsForPlace(list, place) {
  const allowed = VENUE_COMPOSITIONS[venueOf(place)] || VENUE_COMPOSITIONS.smallIndoor;
  const kept = list.filter((c) => allowed.includes(c));
  return kept.length ? kept : allowed;
}

// 한 게시물 5장의 거리 배분 계약.
// ⚠️ 이게 없으면 구도 키가 5개 다 달라도 전부 팔 길이 셀카일 수 있다 — 실제로 그랬다.
//    1번은 반드시 close(피드 썸네일에 얼굴이 걸려야 한다), 나머지는 넓게→좁게 훑는다.
//    집은 넓게 찍을 게 없으므로 와이드를 한 장만 준다.
const DISTANCE_PLAN = {
  home:        ['close', 'medium', 'detail', 'wide',   'close'],
  largeVenue:  ['close', 'wide',   'medium', 'detail', 'wide'],
  smallIndoor: ['close', 'medium', 'wide',   'detail', 'medium'],
  outdoor:     ['close', 'wide',   'medium', 'detail', 'wide'],
  transit:     ['close', 'medium', 'wide',   'detail', 'close'],
};

// n장을 뽑을 때 각 장의 목표 거리. 5장보다 적게 뽑아도 앞에서부터 잘라 쓴다
// (뉴런이 모자라 3장으로 줄어도 close·wide·medium은 확보된다).
export function distancePlanFor(place, n = 5) {
  const plan = DISTANCE_PLAN[venueOf(place)] || DISTANCE_PLAN.smallIndoor;
  return Array.from({ length: n }, (_, i) => plan[i % plan.length]);
}

// 목표 거리에 맞는 구도를 뽑는다. 같은 게시물 안에서 구도 키가 겹치지 않게 used를 넘긴다.
// 목표 거리에 남은 게 없으면 인접 거리로 물러난다 — 빈손으로 돌아가지 않는다.
const DISTANCE_FALLBACK = {
  wide: ['wide', 'medium', 'close', 'detail'],
  medium: ['medium', 'wide', 'close', 'detail'],
  close: ['close', 'medium', 'detail', 'wide'],
  detail: ['detail', 'close', 'medium', 'wide'],
};

export function pickComposition(place, wantDistance, used = [], shuffled = []) {
  const allowed = VENUE_COMPOSITIONS[venueOf(place)] || VENUE_COMPOSITIONS.smallIndoor;
  // shuffled는 호출부가 시드로 섞어 넘긴 순서. 같은 날 같은 게시물은 항상 같은 결과가 나온다.
  const order = shuffled.length ? shuffled.filter((c) => allowed.includes(c)) : allowed;
  for (const dist of DISTANCE_FALLBACK[wantDistance] || DISTANCE_FALLBACK.medium) {
    const hit = order.find((c) => COMPOSITION_DISTANCE[c] === dist && !used.includes(c));
    if (hit) return hit;
  }
  return order.find((c) => !used.includes(c)) || order[0];
}

export const COMPOSITION_SETS = {
  day: {
    first: ['selfieOverhead', 'selfieHigh', 'selfieLow', 'candidSide'],
    rest: ['wideEstablishing','downTheAisle','fullBodyCandid','selfieWithPlace','candidSide','overShoulder','objectDetail','handsOnly','selfieHigh','selfieLow','selfieOverhead','wideRoom'],
  },
  evening: {
    first: ['selfieOverhead', 'selfieLow', 'mirrorSelfie', 'selfieHigh', 'candidSide'],
    rest: ['wideEstablishing','fullBodyCandid','downTheAisle','selfieWithPlace','overShoulder','handsOnly','objectDetail','candidSide','selfieHigh','selfieLow','selfieOverhead','wideRoom'],
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

// 넓은 컷에서는 배경을 지우면 안 된다.
// ⚠️ FRAMING들이 "everything more than a metre behind her falls into soft bokeh"를 들고 있는데,
//    이 문장은 프롬프트 10번 자리라 12번의 장소 블록보다 앞선다. 즉 장소를 묘사하기도 전에
//    「배경을 뭉개라」가 먼저 걸린다. 60m 창고를 찍어도 익명의 색 덩어리가 나온 이유다.
//    close/detail 컷에서는 그대로 두고(그게 셀카의 실제 심도다), wide/medium에서만 바꾼다.
const SHALLOW_DOF =
  'Shot at f/1.8 with focus locked on her face, so everything more than a metre behind her ' +
  'falls into soft bokeh and background surfaces read as smooth blocks of colour.';
const DEEP_DOF =
  'Shot at f/5.6 with a deep focus that holds both her and the space behind her sharp all the way ' +
  'to its far end, so the place she is in is legible rather than blurred away.';

const DETAIL_DOF =
  'Shot at f/2.8 with focus locked on her hands and the surface they rest on, ' +
  'so the object is crisp and everything beyond it softens away.';

// Pexels alt 정제 — 「Explore the lively, bustling …」 같은 홍보 어투와 인파·간판 형용사를 뺀다.
function cleanPlaceNote(note) {
  return String(note)
    .replace(/^(explore|discover|experience|enjoy|visit|capture|step into)\s+/i, '')
    // 「with bright signage」「and bustling nightlife」「, crowds」 — 접속사째로 뺀다
    .replace(/(,|\band|\bwith)?\s*\b(bright|neon|colou?rful|bustling|lively|busy|vibrant)?\s*\b(signage|signs|crowds?|nightlife|people|pedestrians|shoppers|tourists)\b/gi, '')
    .replace(/\b(lively|bustling|vibrant|busy|crowded|packed|inviting|stylish|ideal|perfect)\b,?\s*/gi, '')
    .replace(/\b(of|in|at)\s*,/g, ',').replace(/\s+,/g, ',').replace(/,\s*(,|\.|$)/g, '$1').replace(/\s{2,}/g, ' ').replace(/[,\s]*\.?\s*$/, '').trim();
}

function framingForDistance(text, distance) {
  if (distance === 'detail') {
    // ⚠️ FRAMING 문장들이 「그녀의 얼굴에 빛이 어떻게 떨어지는가」로 쓰여 있다.
    //    얼굴이 프레임에 없는 컷에서 얼굴을 언급하면 모델이 얼굴을 그려 넣는다.
    return (text.includes(SHALLOW_DOF) ? text.replace(SHALLOW_DOF, DETAIL_DOF) : text)
      .replace('the daylight side of her face reads slightly blue, the shadow side slightly green',
               'the daylight side of the surface reads slightly blue, the shadow side slightly green');
  }
  if (distance !== 'wide' && distance !== 'medium') return text;
  return text.includes(SHALLOW_DOF) ? text.replace(SHALLOW_DOF, DEEP_DOF) : text;
}

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
    distance = '',   // 'wide'|'medium'|'close'|'detail'. 배경을 살릴지 뭉갤지를 정한다.
    // 섭외한 실사 레퍼런스의 한 줄 설명(영어). 장소 블록 끝에 「레퍼런스 사진이 이 장소다」로 붙는다.
    // 레퍼런스는 편집 대상이라 그림을 정하고, 이 문장은 그 그림에 이름을 붙여 텍스트와 사진이
    // 같은 곳을 가리키게 한다(일정 브이로그, 2026-09-04).
    placeNote = '',
  } = {}
) {
  const a = persona.appearance;
  const stage = currentStage();
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

  // ⚠️ 순서가 곧 주인공을 정한다. 예전엔 장소 묘사가 프롬프트 한가운데 가장 긴 덩어리로
  //    들어가 있었고, 그래서 모델이 「방 사진」을 그렸다. 실측(9b, 레퍼런스 동일):
  //      · 33단어 짧은 프롬프트        → 하나가 화면을 채움
  //      · +방 묘사 288단어            → 하나가 저 멀리 등 돌리고 앉은 배경 요소로 밀림
  //      · 전체 파이프라인 프롬프트    → 하나가 아예 사라지고 빈 방만
  //    그래서 (1) 맨 앞에 「인물이 주인공」을 못박고 (2) 장소는 맨 뒤로 보내
  //    「그녀 뒤의 배경」이라고 이름 붙인다. 장소는 배경이지 피사체가 아니다.
  const placeText = persona.setting?.places?.[place] || persona.setting?.roomPrompt || '';
  // 장소 한 줄 요약(영어). 1번 자리와 장소 블록 접두사가 같이 쓴다.
  const placeHeadline = persona.setting?.headlineFor?.[place] || (place === 'room' ? 'the room' : '');
  // ⚠️ 넓은 컷에서 장소를 "out of focus and secondary"라고 소개하면 배경을 보여달라는
  //    구도 지시와 정면으로 싸운다. 거리에 따라 소개 방식을 바꾼다.
  const wideShot = distance === 'wide' || distance === 'medium';
  // ⚠️ 디테일 컷은 손과 상판만 나오는 컷이다. 그런데 예전에는 그 뒤로 얼굴 묘사(141단어),
  //    체형(156단어), 목선·화장·얼굴 결점까지 500단어 가까이가 그대로 붙었다.
  //    40단어짜리 구도 지시가 이길 수 없다 — 실측 2026-08-31: 손만 나와야 할 컷이
  //    전신 정면으로 나왔다. 프레임에 얼굴이 없으면 얼굴 이야기를 하지 않는다.
  const detailShot = distance === 'detail';
  const placeLead = wideShot
    ? 'The place she is in, sharp and clearly readable around her:'
    : 'Behind her, out of focus and secondary to her:';
  return [
    // ⚠️ "fills most of the frame"까지 쓰면 구도 지시를 눌러버려 5장이 전부 같은
    //    정면 반신으로 나온다(실측). 거리·구도는 아래 composition/FRAMING이 정하게 두고,
    //    여기서는 「무엇을 찍는 사진인가」만 못박는다.
    // ⚠️ 여기는 프롬프트 1번 자리 — 가장 강한 자리다. 예전엔 장소와 무관하게 항상
    //    "the room is the background"라고 못박혀 있었다. 그래서 place가 ikea든 beach든
    //    모델이 맨 먼저 읽는 단어가 「방」이었고, 12번 자리의 장소 블록은 이길 수가 없었다
    //    (2026-08-31 실측: 가구매장 소재 5장이 전부 남의 집 침실에서 나옴).
    detailShot
      ? 'A close-up photo of a young Korean woman\'s hands and the surface in front of her. ' +
        'Her hands and that surface are what this photo is of.'
      : 'A photo of one young Korean woman. She is what this photo is of — the camera is placed ' +
        `to photograph her, and ${placeHeadline} is the background she happens to be in.`,
    // 장소 한 줄을 앞으로 끌어올린다. 상세 묘사는 뒤에 두되, 「어디인가」만 먼저 못박는다.
    // 뒤쪽 긴 블록이 예산에 밀려 무시돼도 장소 정체성은 살아남는다.
    // ⚠️ "She is ${headline}" 형태로 쓰면 「She is a warehouse store.」 같은 문장이 된다.
    //    장소마다 전치사가 달라(in the room / on a beach) 안전한 명사구 형태로 붙인다.
    // 넓은/중간 컷에서만 장소를 한 번 더 못박는다. 배경이 보여야 하는 컷이라 반복이 값을 한다.
    // 가까운 컷·디테일 컷에서는 배경이 어차피 안 보이므로 단어만 낭비다.
    placeHeadline && wideShot ? `The place around her: ${placeHeadline}.` : '',
    // 구도를 앞으로 올린다. 뒤에 두면 긴 묘사에 묻혀 매번 같은 그림이 된다.
    angleText,
    // ⚠️ 표정도 같은 이유로 앞에 둔다. 예전엔 FRAMING(조명·카메라 설정 한 문단) 뒤에
    //    있었는데, 표정 지시를 컷마다 다르게 넣어도 결과는 전부 같은 무표정이었다(실측).
    //    표정은 「어떤 사진인가」를 정하는 요소지 마감 손질이 아니다.
    detailShot ? '' : expression ? `Her expression in this photo: ${expression}.` : '',
    detailShot ? '' : identity,
    // ⚠️ 레퍼런스를 첨부할 때는 점을 말로 다시 설명하지 않는다.
    //    앵커가 시기별로 따로 있어 점 유무가 이미 반영돼 있고,
    //    "레퍼런스대로 베껴라"와 "여기에 그려라"가 충돌하면 모델이 위치를 재해석해 매번 옮긴다.
    withReference ? '' : fragment,
    // 변신 단계가 바꾸는 건 화장뿐이다. 옷차림·노출은 exposureStandard로 고정
    // (사용자가 바닷가 V넥 컷을 표준으로 확정) — 단계가 올라가도 안 변한다.
    detailShot ? '' : makeupFor(stage, place),
    detailShot
      ? `Only her forearms and sleeves show, from: ${styling || a.looks[look]}.`
      // ⚠️ 옷 문장은 331번째 단어, 체형은 422번째다. 옷이 90단어 앞서므로 옷이 이긴다.
      //    「니트」처럼 헐렁한 옷을 지정하면 체형 문장이 통째로 눌린다(실측 2026-09-03:
      //    베이지 니트를 입혔더니 D컵 실루엣이 사라졌다).
      //    그래서 옷을 말하는 자리에서 「그 옷이 그녀 몸 위에 어떻게 걸리는가」까지 같이 말한다.
      : `What she is wearing right now: ${styling || a.looks[look]}. ` +
        'Whatever the garment is, it follows the shape of her body rather than hanging straight ' +
        'from her shoulders: it drapes over the full curve of her bust and falls in from there, ' +
        'so her figure still reads clearly through the clothing. ' +
        'She has these clothes on in every photo of this set.',
    detailShot ? '' : persona.exposureStandard,
    // 넓은 컷에서는 체형을 실루엣 수준으로만 말한다 — 상세판은 가까운 거리에서만 의미가 있고,
    // 넓은 컷에 넣으면 예산을 먹으면서 「더 가까이」로 작용한다.
    (detailShot ? '' : distance === 'wide' ? a.figurePromptWide || a.figurePrompt : a.figurePrompt) || '',
    scene ? `Action: ${scene}` : '',
    framingForDistance(FRAMING[framing] || FRAMING.reel, distance),
    detailShot ? '' : `Her face shows ${pickImperfections(seed || `${look}-${framing}-${scene}`, 3, ph)}`,
    // ⚠️ 디테일 컷에는 장소 상세(300단어 이상)를 넣지 않는다. 손과 상판만 보이는 컷인데
    //    「홀이 뒤로 열린다」 같은 문장이 들어가면 모델이 그걸 그리려고 카메라를 뒤로 뺀다
    //    (실측: 손 클로즈업을 요청했는데 통로 전경이 나오고 팔이 세 개가 됐다).
    //    어디인지 한 줄만 남긴다 — 상판 재질과 조명만 맞으면 충분하다.
    detailShot
      ? (placeHeadline ? `They are in ${placeHeadline}, but only the surface and her hands are in shot.` : '')
      : placeText
        // 섭외 사진(Pexels)은 낮에 찍힌 게 많다. 배치·재질은 사진대로, 빛은 프레이밍대로.
        // ⚠️ 레퍼런스 문장은 장소 블록 「앞」에 둔다 — 장소 블록 끝의 간판·인파 억제 문장이
        //    마지막 말이어야 한다. Pexels alt는 「lively, bustling nightlife」 같은 홍보 문구라
        //    뒤에 붙이면 그게 억제 문장을 덮는다(실측 2026-09-04 밤거리 컷). 그 단어들은 지운다.
        ? `${placeLead} ${placeNote ? `The reference photo shows this exact place: ${cleanPlaceNote(placeNote)}. Keep its layout, furnishings and materials, but light it as described above. ` : ''}${placeText}`
        : '',
    seasonNote,
    'Unedited camera roll photo. No filter, no retouching, no beauty app.',
    // ⚠️ FLUX.2는 네거티브를 지원하지 않는다. BFL 문서의 치환 예시대로 긍정형으로 쓴다.
    //    (identityLock의 'Do not mirror/restyle'는 t2i 억제가 아니라 편집 문맥의 보존
    //     지시라 성격이 다르다 — 그건 건드리지 않는다.)
    'Every surface in the frame is clean and unmarked.',
    // 화면은 글자를 부르는 가장 강한 유인이다. 따로 못박지 않으면 영문 UI를 그려 넣어
    // (한국인 일상 사진에 영어 앱 화면) 단번에 AI 티가 난다.
    'Any phone, laptop or monitor screen in frame shows only blurred, indistinct interface shapes — ' +
    'no readable words, no numbers, no app names, and no visible brand logos on any device.',
  ]
    .filter(Boolean)
    .join('\n');
}
