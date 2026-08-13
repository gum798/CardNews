// Hailuo i2v — 하나 키프레임 사진을 6초 실사 영상으로 만든다 (인트로 히어로 컷).
//
// i2v는 입력 사진 자체를 움직이므로 얼굴 드리프트가 원리적으로 최소다.
// 결제는 크레딧 지갑(MINIMAX_SUB_KEY) — 클립당 약 $0.19.
// ⚠️ H3(MiniMax-H3)는 크레딧을 거부한다(2013 에러). H3로 올릴 땐 PAYG 지갑 필요.
//
// 베스트에포트: 실패·크레딧 소진(402)·타임아웃 모두 null 반환 → 정지 사진 폴백.
import { writeFileSync, readFileSync } from 'node:fs';
import { minimax } from '../config.js';

const MODEL = process.env.HAILUO_MODEL || 'MiniMax-Hailuo-2.3-Fast';
const POLL_MS = 15_000;
const MAX_POLLS = 24; // 6분 — 실측 60~75초라 넉넉히

// 인트로용 미세 모션. 장면 전환·컷 금지가 핵심 — 배경 위 오버레이가 아니라
// 훅 구간의 전체 화면이므로 갑자기 다른 장면이 되면 안 된다.
const INTRO_PROMPT =
  'The woman comes to life with subtle natural motion: she blinks, breathes, ' +
  'her eyes look toward the camera and she gives a small gentle closed-lip smile, ' +
  'slight natural head movement, a few hair strands move, very slight handheld camera sway. ' +
  'No scene change, no camera cut, no zoom, photorealistic.';

async function api(path, opts = {}) {
  const res = await fetch(`https://api.minimax.io${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${minimax.subKey}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// 사진 → 6초 영상. 성공 시 outPath, 실패 시 null.
export async function animatePersona(imagePath, outPath, { prompt = INTRO_PROMPT, duration = 6 } = {}) {
  if (!minimax.subKey) return null;
  try {
    const b64 = readFileSync(imagePath).toString('base64');
    const sub = await api('/v1/video_generation', {
      method: 'POST',
      body: JSON.stringify({
        model: MODEL,
        prompt,
        first_frame_image: `data:image/png;base64,${b64}`,
        duration,
        resolution: '768P',
      }),
    });
    const taskId = sub.json?.task_id;
    if (!taskId) {
      console.warn(`[hailuo] 제출 실패 (${sub.status}): ${JSON.stringify(sub.json).slice(0, 150)}`);
      return null;
    }

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const q = await api(`/v1/query/video_generation?task_id=${taskId}`);
      const st = q.json?.status;
      if (st === 'Success') {
        const f = await api(`/v1/files/retrieve?file_id=${q.json.file_id}`);
        const url = f.json?.file?.download_url;
        if (!url) return null;
        const v = await fetch(url, { signal: AbortSignal.timeout(180_000) });
        if (!v.ok) return null;
        writeFileSync(outPath, Buffer.from(await v.arrayBuffer()));
        console.log(`[hailuo] 인트로 영상 생성 (${duration}초, task=${taskId})`);
        return outPath;
      }
      if (st === 'Fail') {
        console.warn(`[hailuo] 생성 실패: ${JSON.stringify(q.json).slice(0, 150)}`);
        return null;
      }
    }
    console.warn('[hailuo] 폴링 타임아웃');
    return null;
  } catch (e) {
    console.warn(`[hailuo] 오류(정지 사진 폴백): ${String(e.message).slice(0, 120)}`);
    return null;
  }
}
