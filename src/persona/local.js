// 로컬 이미지 생성 (mflux + FLUX.2-klein-4B, Apple Silicon MLX).
//
// 왜 로컬을 같이 쓰는가:
//   · CF 무료 뉴런은 하루 한도가 있다(9b 기준 계정 2개 14장). 8/20에 뉴스 발행이
//     하루치를 먼저 먹어 브이로그 5장이 전원 실패하고 작업이 통째로 죽은 적이 있다.
//   · 로컬은 무제한·무료라 장수를 늘려 고를 폭을 넓히는 데 쓴다.
//
// ⚠️ 얼굴 일관성은 CF가 낫다. 실측(같은 앵커·같은 프롬프트):
//      CF klein-9b   faceDist 0.40~0.48
//      로컬 klein-4b faceDist 0.54~0.56
//    스텝을 4→24로 올려도 0.54~0.56에서 정체했다 — 모델 용량 한계라 스텝으로는 못 넘는다.
//    그래서 로컬은 「얼굴 최상」이 아니라 「선택지 확대」 용도다.
//
// ⚠️ klein-9b 가중치를 받아 쓰면 안 된다. 9B는 FLUX Non-Commercial License에 게이트이고,
//    4B만 apache-2.0이다. CF로 9b를 쓰는 건 파트너 API 경로라 별개 문제 — 로컬은 4b가 상한.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';

// mflux 실행 파일과 8비트로 미리 저장해 둔 모델.
// ⚠️ 양자화본을 안 쓰면 25GB 원본이 통째로 메모리에 올라가 24GB 기기에서 스왑이 걸린다
//    (실측: 여유 메모리 6%까지 떨어짐). mflux-save로 만든 8GB 버전을 쓴다 — RSS 1.26GB.
const MFLUX_BIN = process.env.MFLUX_BIN || '';
const MFLUX_MODEL = process.env.MFLUX_MODEL || '';
const STEPS = Number(process.env.MFLUX_STEPS || 4);

export function localAvailable() {
  return Boolean(MFLUX_BIN && MFLUX_MODEL && existsSync(MFLUX_BIN) && existsSync(MFLUX_MODEL));
}

// 이미지 1장 생성. 성공하면 outPath, 실패하면 null(발행을 막지 않는다).
export function generateLocal(prompt, { outPath, refImage, seed, steps = STEPS, timeoutMs = 900_000 } = {}) {
  return new Promise((resolve) => {
    if (!localAvailable()) return resolve(null);
    const args = [
      '--model', MFLUX_MODEL,
      '--base-model', 'flux2-klein-4b',
      '--prompt', prompt,
      '--height', '1376', '--width', '768',
      '--steps', String(steps),
      '--output', outPath,
    ];
    if (seed !== undefined) args.push('--seed', String(seed));
    if (refImage && existsSync(refImage)) args.push('--image-paths', refImage);

    execFile(MFLUX_BIN, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err) => {
      if (err || !existsSync(outPath)) {
        console.warn(`[local] 생성 실패: ${String(err?.message || '출력 없음').slice(0, 120)}`);
        return resolve(null);
      }
      resolve(outPath);
    });
  });
}
