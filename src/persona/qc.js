// 생성 이미지 해부학 검수. tools/qc(Vision) 래퍼.
//
// 무료 이미지 모델은 팔이 하나 더 달린 컷을 꾸준히 만든다(실측: 차이나타운 컷에서
// 하나에게 팔 3개). 사람이 매번 10장을 눈으로 거르는 건 낭비이므로 기계로 먼저 친다.
//
// ⚠️ 셀 수 있는 것만 판정한다. "어색하다"는 판단은 하지 않는다 —
//    오탐이 나면 멀쩡한 컷이 버려지고, 그건 결함 하나를 통과시키는 것보다 손해다.
//    (시각 LLM으로 판정해봤으나 haiku·sonnet 모두 실제 결함을 통과시켜 신뢰 못 한다.)
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';

const QC_BIN = path.join(paths.root, 'tools', 'qc');

function parse(line) {
  const m = line.match(/faces=(\d+) bigFaces=(\d+) hands=(\d+) bodies=(\d+) fingers=(\d+)/);
  if (!m) return null;
  return {
    faces: Number(m[1]),
    bigFaces: Number(m[2]),
    hands: Number(m[3]),
    bodies: Number(m[4]),
    fingers: Number(m[5]),
  };
}

// 이미지 1장 검수. { ok, reason, stats } 반환. 도구가 없거나 실패하면 통과시킨다
// (검수 때문에 발행이 멈추면 안 된다).
export function inspectImage(imgPath) {
  return new Promise((resolve) => {
    if (!existsSync(QC_BIN) || !existsSync(imgPath)) return resolve({ ok: true, reason: 'skip' });
    execFile(QC_BIN, [imgPath], { timeout: 30_000 }, (err, stdout) => {
      if (err) return resolve({ ok: true, reason: 'qc 실행 실패(통과 처리)' });
      const s = parse(String(stdout).trim());
      if (!s) return resolve({ ok: true, reason: 'qc 파싱 실패(통과 처리)' });

      // 1인 셀카/스냅 기준. 배경 행인의 작은 얼굴은 bigFaces에서 빠지므로 허용된다.
      if (s.hands > 2) return resolve({ ok: false, reason: `손 ${s.hands}개`, stats: s });
      if (s.bigFaces > 1) return resolve({ ok: false, reason: `큰 얼굴 ${s.bigFaces}개`, stats: s });
      if (s.bodies > 1) return resolve({ ok: false, reason: `몸통 ${s.bodies}개`, stats: s });
      resolve({ ok: true, stats: s });
    });
  });
}
