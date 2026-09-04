// 뉴스 인트로 히어로 컷 — 하나 키프레임을 6초 실사 영상으로.
//
// 계층: 무료(ZeroGPU) → 유료(Hailuo) → null(정지 사진 폴백).
//   1) ZeroGPU H3/WAN — 완전 무료. 하루 할당량(5분)이 남아 있을 때만.
//   2) Hailuo — 크레딧 $0.19/클립. 할당량이 없거나 ZeroGPU가 실패했을 때.
//   3) 둘 다 안 되면 null → pipeline이 기존 컷아웃(정지 사진)으로 그린다.
//
// 왜 이 순서인가(2026-09-03 사용자 결정 "FFMPEG-ZeroGPU-뉴스영상으로 이어지게"):
//   무료 계층을 먼저 소진하고, 정말 필요할 때만 돈을 쓴다. 브이로그도 같은 원칙이다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { animatePersona } from './hailuo.js';
import { remaining as zeroRemaining, record as zeroRecord, costOf } from '../persona/zerogpu-budget.js';

const execFileAsync = promisify(execFile);
const PY = path.join(process.env.HOME, 'models/localgen/.venv/bin/python');

// 인트로용 미세 모션 프롬프트. Hailuo INTRO_PROMPT와 같은 취지 — 장면 전환 금지.
const INTRO_PROMPT =
  'A young Korean woman looks toward the camera and gives a small gentle closed-lip smile, ' +
  'she blinks and breathes, slight natural head movement, a few hair strands move, ' +
  'very slight handheld camera sway. No scene change, no cut, no zoom, photorealistic.';

// ZeroGPU로 6초 인트로 생성. 성공 시 outPath, 실패/할당량부족 시 null.
async function viaZeroGpu(imagePath, outPath, { duration = 4, kind = 'h3,wan' } = {}) {
  if (!existsSync(PY)) return null;
  const cost = costOf(kind.split(',')[0], duration);  // 첫 시도 기준으로 예산 확인
  if (zeroRemaining() < cost) {
    console.log(`[intro] ZeroGPU 할당량 부족(남은 ${zeroRemaining()}s < 필요 ${cost}s) → 다음 계층`);
    return null;
  }
  try {
    await execFileAsync(
      PY,
      [
        path.join(paths.root, 'scripts/zerogpu-clip.py'),
        '--kind', kind,   // 'h3,wan' 폴백 사슬
        '--image', imagePath,
        '--prompt', INTRO_PROMPT,
        '--duration', String(duration),
        '--out', outPath,
      ],
      { timeout: 900_000 }
    );
    if (existsSync(outPath)) {
      zeroRecord(cost);
      console.log(`[intro] ZeroGPU 인트로 생성 (${duration}초, ${kind})`);
      return outPath;
    }
  } catch (e) {
    // rc=3 = 할당량 거절(스크립트가 out/zerogpu-quota.json에 실제 잔량을 남긴다)
    console.warn(`[intro] ZeroGPU 실패(다음 계층): ${String(e.message).slice(0, 120)}`);
  }
  return null;
}

/**
 * 뉴스 인트로 영상. 무료(ZeroGPU) → 유료(Hailuo) → null 순으로 시도한다.
 * @param {boolean} allowPaid Hailuo(유료) 폴백을 허용할지. 기본 false = 완전 무료만.
 */
export async function makeIntroVideo(imagePath, outPath, { duration = 4, allowPaid = false } = {}) {
  const free = await viaZeroGpu(imagePath, outPath, { duration });
  if (free) return free;

  if (allowPaid) {
    const paid = await animatePersona(imagePath, outPath, { duration });
    if (paid) {
      console.log('[intro] Hailuo(유료) 인트로로 폴백');
      return paid;
    }
  }
  console.log('[intro] 인트로 영상 없음 → 정지 사진 폴백');
  return null;
}
