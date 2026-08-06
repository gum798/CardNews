// 검토 대기 중인 브이로그에 컷을 하나 더 만들어 붙인다.
// 사진을 다시 뽑고 싶은 게 아니라 "이런 장면 하나만 더" 일 때 쓴다.
// 붙인 뒤에는 scripts/vlog-resend.mjs로 검토 메시지를 다시 보내야 버튼에 반영된다.
//
// 사용:
//   node scripts/vlog-add-photo.mjs --id vlog-20260806-evening \
//     --action "pointing at the moles above the right corner of her mouth" \
//     --expression "openly pleased, half laughing" \
//     --composition selfieHigh
//
// --id 생략 시 가장 최근 pending 건. --composition 생략 시 selfieHigh.
import '../src/config.js';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { paths } from '../src/config.js';
import { hana, placeForTheme } from '../src/persona/hana.js';
import { generateImage, scenePrompt } from '../src/persona/image.js';
import { anchorPath } from '../src/persona/keyframe.js';
import { loadPost, savePost } from '../src/vlog/review.js';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function latestPending() {
  const dirs = readdirSync(paths.out)
    .filter((d) => /^vlog-\d{8}-(day|evening)$/.test(d))
    .sort()
    .reverse();
  return dirs.map((d) => [d, loadPost(d)]).find(([, p]) => p?.status === 'pending')?.[0] || null;
}

const id = arg('id') || latestPending();
const action = arg('action');
if (!id || !action) {
  console.error('사용: node scripts/vlog-add-photo.mjs [--id <vlog-id>] --action "<영문 장면>" [--expression "<영문>"] [--composition <키>]');
  process.exit(2);
}

const post = loadPost(id);
if (!post) {
  console.error(`${id}: post.json이 없습니다`);
  process.exit(1);
}
if (post.status !== 'pending') {
  console.error(`${id}: 상태가 ${post.status} 라 추가할 수 없습니다`);
  process.exit(1);
}

// 기존 컷과 같은 조건(장소·복장)을 그대로 따라간다. 안 그러면 이 한 장만 튄다.
const place = placeForTheme(post.theme);
const outfit = post.outfit || '';
const n = post.files.length + 1;
const out = path.join(paths.out, id, `photo-${n}.png`);
const anchor = anchorPath();

const prompt = scenePrompt(hana, {
  look: 'daily',
  composition: arg('composition', 'selfieHigh'),
  scene: action,
  expression: arg('expression'),
  styling: outfit,
  place,
  framing: place === 'room' ? 'feedWindow' : 'feedPublic',
  withReference: Boolean(anchor),
  seed: `${id}-add-${n}`,
});

console.log(`[vlog] ${id} 에 컷 ${n} 추가 중… (장소=${place}${outfit ? ', 복장 고정' : ''})`);
await generateImage(prompt, { outPath: out, refImages: anchor ? [anchor] : [] });
if (!existsSync(out)) {
  console.error('생성 실패');
  process.exit(1);
}

post.files.push(out);
post.selected.push(true);
savePost(post);
console.log(`[vlog] 완료 → ${out}`);
console.log('검토 메시지에 반영하려면: node scripts/vlog-resend.mjs ' + id);
process.exit(0);
