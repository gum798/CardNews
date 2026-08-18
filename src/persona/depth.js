// 배경 심도 후처리 — 깨진 한글 간판을 물리적으로 지운다.
//
// 생성 모델은 한글을 못 쓴다. 「글자 없게」 지시는 FLUX.2에서 네거티브 프롬프트라
// 무효이고(BFL 공식), 긍정형으로 바꿔도 유사 글자가 남는다.
// OCR로 잡아 지우는 것도 불가능하다 — 깨진 한글은 OCR에도 글자로 안 잡힌다(실측).
//
// 그래서 렌즈로 해결한다. 인물 매트로 배경만 흐리면 간판 글자가 통째로 뭉개지고,
// 폰 인물모드처럼 보여 오히려 사진이 자연스러워진다.
//
// ⚠️ 균일 블러는 인공적이다(발밑 바닥까지 흐려진다). 위로 갈수록 강해지는
//    세로 그라디언트를 써야 실제 심도처럼 읽힌다.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { foregroundMatte } from '../video/matte.js';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';

// 간판·상품명이 화면을 채우는 장소. 여기서만 적용한다.
// 방·바닷가는 글자가 거의 없고, 뉴스룸은 종이 배경이 세트라 흐리면 안 된다.
export const SIGNAGE_PLACES = new Set([
  'convenienceStore',
  'bathhouseStreet',
  'chinatown',
  'earlyTrain',
  'gym',
  'libraryCafe',
  'library',
]);

// 배경에 그라디언트 심도를 넣는다. 성공하면 true, 실패하면 false(원본 유지).
export function applyDepthBlur(imgPath, { far = 9, near = 2.5 } = {}) {
  return new Promise(async (resolve) => {
    if (!existsSync(imgPath)) return resolve(false);
    const info = await foregroundMatte(imgPath);
    // 인물을 못 오려내면 배경만 흐릴 방법이 없다 — 원본을 그대로 둔다.
    if (!info?.maskPath || !existsSync(info.maskPath)) return resolve(false);

    const tmp = imgPath.replace(/\.png$/i, '.depth.png');
    const filter =
      `[0:v]gblur=sigma=${far}[far];` +
      `[0:v]gblur=sigma=${near}[near];` +
      // 위(먼 배경)로 갈수록 far 쪽 가중치가 커진다. 발밑은 거의 near.
      `color=c=black:s=${info.width}x${info.height},format=gray,` +
      `geq=lum='clip(255-(Y/H)*300,0,255)'[grad];` +
      `[near][far][grad]maskedmerge[bgmix];` +
      // 매트 경계를 부드럽게 — 안 하면 오려붙인 티가 난다.
      `[1:v]gblur=sigma=3,format=gray[m];` +
      `[0:v][m]alphamerge[fg];` +
      `[bgmix][fg]overlay=0:0,format=rgb24`;

    execFile(
      FFMPEG,
      ['-v', 'error', '-i', imgPath, '-i', info.maskPath, '-filter_complex', filter,
       '-frames:v', '1', tmp, '-y'],
      { timeout: 60_000 },
      (err) => {
        if (err || !existsSync(tmp)) return resolve(false);
        // 원본을 결과로 교체
        execFile('/bin/mv', [tmp, imgPath], (e2) => resolve(!e2));
      }
    );
  });
}
