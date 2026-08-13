// 페르소나 키프레임: 릴스에 넣을 하나 이미지를 얻는다.
//
// ⚠️ 예전에는 씬+시기로만 캐시 키를 잡아 같은 파일이 영원히 재사용됐다.
//    그래서 어제 뉴스와 오늘 뉴스에 똑같은 사진이 나갔다.
//    이제 키에 날짜·슬롯·주제를 넣어 발행마다 다른 그림이 나온다.
//    같은 발행 안에서는 캐시가 그대로 먹으므로 재시도해도 그림이 튀지 않는다.
//
// 그림을 얻는 순서:
//   1) 전날 브이로그 사진 중 어울리는 것 재사용 (있으면 — 캐릭터의 하루가 이어져 보인다)
//   2) 새로 생성
//   3) 둘 다 실패하면 null (페르소나는 부가 요소라 발행을 막지 않는다)
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config.js';
import { hana } from './hana.js';
import { generateImage, scenePrompt } from './image.js';

const CACHE_DIR = path.join(paths.root, 'assets', 'persona', 'cache');

// 시기별 앵커 이미지. 이 한 장이 얼굴 일관성의 원천이라 리포에 커밋해 둔다.
export function anchorPath(phase = process.env.PERSONA_PHASE || 'before') {
  const p = path.join(paths.root, 'assets', 'persona', 'hana', phase, 'anchor-news-front.png');
  return existsSync(p) ? p : null;
}

// 릴스 씬. 행동을 여러 개 두고 날짜로 골라 매번 다른 그림이 나오게 한다.
// 장소는 뉴스룸(방 한쪽에 종이로 만든 세트)이므로 행동도 그 앞에서 성립해야 한다 —
// 바닥에 앉거나 침대 옆 같은 방 전용 동작은 여기 넣지 않는다.
export const SCENES = {
  intro: {
    look: 'news',
    angle: 'front',
    place: 'newsroom',
    actions: [
      'sitting upright at the desk facing the camera, a printed script page in one hand, about to speak',
      'leaning slightly toward the camera mid-sentence, one hand resting flat on the script',
      'sitting straight with both hands loosely clasped on the desk, mouth open mid-word',
      'glancing up from the script page to the camera as she starts talking',
      'sitting at the desk with a mug beside her hand, gesturing small with the other hand as she speaks',
    ],
  },
  outro: {
    look: 'news',
    angle: 'right',
    place: 'newsroom',
    actions: [
      'sitting at the desk, a small tired smile, wrapping up',
      'squaring the script pages against the desk with both hands, finishing',
      'stretching her shoulders back after finishing, half smiling',
      'resting her chin on her hand, looking past the camera, thinking',
      'reaching for the mug at the edge of the desk, mid-motion',
    ],
  },
};

// 발행 단위 키. 날짜·슬롯·주제가 바뀌면 새 그림이 나온다.
export function publishKey({ date, slot = '', topic = '' } = {}) {
  const d = date || new Date();
  const stamp =
    typeof d === 'string'
      ? d
      : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${stamp}-${slot}-${topic}`;
}

function pickAction(scene, seed) {
  let h = 0x811c9dc5;
  for (const c of String(seed)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return scene.actions[(h >>> 0) % scene.actions.length];
}

// 전날 브이로그 사진 중 쓸 만한 것. 캐릭터의 하루가 뉴스로 이어져 보인다.
// 어제 것을 우선하고 없으면 최근 것. 얼굴이 나온 첫 장(photo-1)만 쓴다.
export function recentVlogPhoto({ maxAgeDays = 3 } = {}) {
  try {
    const dirs = readdirSync(paths.out)
      .filter((d) => /^vlog-\d{8}-(day|evening)$/.test(d))
      .sort()
      .reverse();
    const today = new Date();
    for (const d of dirs) {
      const stamp = d.slice(5, 13); // YYYYMMDD
      const dt = new Date(
        Number(stamp.slice(0, 4)),
        Number(stamp.slice(4, 6)) - 1,
        Number(stamp.slice(6, 8))
      );
      const ageDays = (today - dt) / 86_400_000;
      if (ageDays < 0 || ageDays > maxAgeDays) continue;
      const p = path.join(paths.out, d, 'photo-1.png');
      if (existsSync(p)) return p;
    }
  } catch {
    /* out 디렉터리가 없을 수 있다 */
  }
  return null;
}

// 씬 이미지를 얻는다. key가 바뀌면 새로 만든다.
export async function getKeyframe(
  sceneName,
  { phase = process.env.PERSONA_PHASE || 'before', key = publishKey() } = {}
) {
  const scene = SCENES[sceneName];
  if (!scene) return null;

  await mkdir(CACHE_DIR, { recursive: true });
  const h = createHash('sha1').update(`${sceneName}|${phase}|${key}`).digest('hex').slice(0, 10);
  const file = path.join(CACHE_DIR, `${sceneName}-${phase}-${h}.png`);
  if (existsSync(file)) return file; // 같은 발행 안에서는 재사용(재시도해도 그림이 안 튄다)

  try {
    // 앵커를 레퍼런스로 첨부해야 같은 사람이 유지된다.
    // 최근 브이로그 사진(사람 검수를 거친 얼굴)을 두 번째 레퍼런스로 추가한다 —
    // 검수된 신원이 뉴스로 이어지고, CF 무료 백엔드의 드리프트를 줄인다.
    const anchor = anchorPath(phase);
    const vlogRef = recentVlogPhoto();
    const prompt = scenePrompt(hana, {
      look: scene.look,
      angle: scene.angle,
      scene: pickAction(scene, `${sceneName}-${key}`),
      phase,
      framing: scene.place === 'newsroom' ? 'reelSet' : 'reel',
      place: scene.place || 'room',
      withReference: Boolean(anchor),
      seed: `${sceneName}-${key}`,
    });
    await generateImage(prompt, { outPath: file, refImages: [anchor, vlogRef].filter(Boolean) });
    console.log(`[persona] 키프레임 생성 ${sceneName} (${key})`);
    return file;
  } catch (e) {
    console.warn(`[persona] 키프레임 실패 (${sceneName}): ${e.message.slice(0, 120)}`);
    // 생성이 막히면(할당량 등) 최근 브이로그 사진으로 대체한다.
    const fallback = recentVlogPhoto();
    if (fallback) {
      console.log(`[persona] 최근 브이로그 사진으로 대체: ${path.basename(path.dirname(fallback))}`);
      return fallback;
    }
    return null;
  }
}

// 릴스에 필요한 키프레임을 한 번에. 실패한 건 null로 남는다.
export async function getReelKeyframes(opts = {}) {
  const [intro, outro] = await Promise.all([
    getKeyframe('intro', opts),
    getKeyframe('outro', opts),
  ]);
  return { intro, outro };
}
