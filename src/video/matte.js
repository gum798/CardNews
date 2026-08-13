// 인물 매트: tools/matte(Vision 프레임워크) 호출 래퍼.
//
// 하나를 "방 사진째로 얹은 판때기"가 아니라 배경 영상 위에 선 사람으로 만들기 위해
// 알파 채널과 바운딩박스를 얻는다. 실패하면 null — 호출부는 기존 방식으로 폴백한다.
//
// 모델 다운로드도 추가 메모리도 없다(OS 내장). 실측 0.11~0.27초/장.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';

const MATTE_BIN = path.join(paths.root, 'tools', 'matte');

// 매트를 믿을 수 있는 조건. 벗어나면 폴백한다.
//  - instances가 많으면 인물 외 물체(옷걸이·가방)까지 묶였다는 뜻
//  - 화면 점유율이 너무 낮으면 인물을 못 잡은 것, 너무 높으면 배경까지 통째로 잡은 것
const MAX_INSTANCES = 2;
const MIN_COVER = 6;
const MAX_COVER = 72;

function parse(line) {
  const m = line.match(
    /ok instances=(\d+) mask=(\d+)x(\d+) bbox=(\d+),(\d+),(\d+),(\d+) cover=([\d.]+)/
  );
  const fm = line.match(/face=(\d+),(\d+),(\d+),(\d+)/);
  if (!m) return null;
  const [, inst, mw, mh, bx, by, bw, bh, cover] = m;
  return {
    instances: Number(inst),
    width: Number(mw),
    height: Number(mh),
    bbox: { x: Number(bx), y: Number(by), w: Number(bw), h: Number(bh) },
    cover: Number(cover),
    face: fm ? { x: Number(fm[1]), y: Number(fm[2]), w: Number(fm[3]), h: Number(fm[4]) } : null,
  };
}

// 전경 매트를 뽑는다. 성공하면 { maskPath, width, height, bbox, instances, cover }, 아니면 null.
export function foregroundMatte(imgPath) {
  return new Promise((resolve) => {
    if (!existsSync(MATTE_BIN) || !existsSync(imgPath)) return resolve(null);
    const maskPath = imgPath.replace(/\.[^.]+$/, '') + '.mask.png';

    execFile(MATTE_BIN, [imgPath, maskPath], { timeout: 30_000 }, (err, stdout) => {
      if (err) return resolve(null); // exit 1 = 전경 미검출 → 폴백
      const info = parse(String(stdout).trim());
      if (!info) return resolve(null);

      if (info.instances > MAX_INSTANCES || info.cover < MIN_COVER || info.cover > MAX_COVER) {
        console.log(
          `[matte] 신뢰 못 함 → 폴백 (instances=${info.instances} cover=${info.cover}%) ${path.basename(imgPath)}`
        );
        return resolve(null);
      }
      resolve({ maskPath, ...info });
    });
  });
}

// 매트 정보 → 1080×1920 화면 안에서의 배치.
// 인물의 발끝을 화면 바닥에, 머리끝을 자막 안전영역 아래로 내려놓는다.
// (템플릿의 .safe.with-persona가 자막 하단을 bottom:1020px에 두므로 자막은 y<900에만 있다)
export function personaPlacement(info, { frameW = 1080, frameH = 1920, headTopY = 985 } = {}) {
  const { bbox, width, height } = info;
  const scale = (frameH - headTopY) / bbox.h; // 인물 키가 화면 아래쪽을 채우도록
  const canvasW = Math.round(width * scale);
  const canvasH = Math.round(height * scale);
  // 인물 바닥이 화면 바닥에 오도록 캔버스를 올린다.
  const y = Math.round(frameH - (bbox.y + bbox.h) * scale);
  // 인물 중심이 화면 중앙에 오도록.
  const x = Math.round(frameW / 2 - (bbox.x + bbox.w / 2) * scale);
  return { canvasW, canvasH, x, y, scale };
}
