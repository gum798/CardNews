// 페르소나 키프레임: 씬별 하나 이미지를 생성하고 캐시한다.
//
// 매 발행마다 새로 생성하면 (a) 비용이 쌓이고 (b) 방·얼굴이 미세하게 흔들린다.
// 씬 종류는 몇 개 안 되므로(인트로/아웃트로 × 룩) 캐시해서 재사용하는 게 낫다.
// 캐시 키에 phase를 넣어 점 제거 전/후가 섞이지 않게 한다.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config.js';
import { hana } from './hana.js';
import { generateImage, scenePrompt } from './image.js';

const CACHE_DIR = path.join(paths.root, 'assets', 'persona', 'cache');

// 릴스에서 쓰는 고정 씬. 여기서 벗어난 씬은 만들지 않는다 — 종류가 늘면 캐시 효율이 죽는다.
export const SCENES = {
  intro: {
    look: 'news',
    angle: 'front',
    action: 'sitting at the desk, looking straight at the camera, about to start speaking',
  },
  outro: {
    look: 'news',
    angle: 'right',
    action: 'sitting at the desk, slight friendly smile, wrapping up',
  },
};

function cacheKey(sceneName, phase) {
  const s = SCENES[sceneName];
  const src = JSON.stringify({ sceneName, phase, s, room: hana.setting.roomPrompt });
  return createHash('sha1').update(src).digest('hex').slice(0, 12);
}

// 씬 이미지를 얻는다. 캐시에 있으면 그대로, 없으면 생성 후 저장.
// 실패하면 null — 페르소나는 부가 요소라 이것 때문에 발행이 멈추면 안 된다.
export async function getKeyframe(sceneName, { phase = process.env.PERSONA_PHASE || 'before' } = {}) {
  const scene = SCENES[sceneName];
  if (!scene) return null;

  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${sceneName}-${phase}-${cacheKey(sceneName, phase)}.png`);
  if (existsSync(file)) return file;

  try {
    const prompt = scenePrompt(hana, {
      look: scene.look,
      angle: scene.angle,
      scene: scene.action,
      phase,
    });
    await generateImage(prompt, { outPath: file });
    console.log(`[persona] 키프레임 생성 ${sceneName}/${phase}`);
    return file;
  } catch (e) {
    console.warn(`[persona] 키프레임 실패 (${sceneName}): ${e.message.slice(0, 120)}`);
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
