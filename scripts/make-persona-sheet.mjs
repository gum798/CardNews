// 페르소나 「하나」 캐릭터 시트 생성.
// 1) 기준 정면 1장을 먼저 만든다 (앵커)
// 2) 나머지는 그 1장을 레퍼런스로 첨부해 생성 → 같은 사람 유지
// 결과: assets/persona/hana/*.png (git 커밋해서 영구 아이덴티티 앵커로 삼는다)
//
// 실행: NODE_EXTRA_CA_CERTS=certs/corp-root.pem node scripts/make-persona-sheet.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import '../src/config.js'; // .env를 먼저 로드해야 process.env가 채워진다
import { hana } from '../src/persona/hana.js';
import { generateImage, scenePrompt } from '../src/persona/image.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(root, 'assets', 'persona', 'hana');
await mkdir(OUT, { recursive: true });

// 앵커: 뉴스 룩 정면. 이 한 장이 이후 모든 이미지의 기준이 된다.
const ANCHOR = path.join(OUT, 'anchor-news-front.png');

console.log('1) 기준 이미지 생성 (앵커)…');
await generateImage(scenePrompt(hana, { look: 'news', angle: 'front', scene: '뉴스 진행 중, 심플한 스튜디오 배경' }), {
  outPath: ANCHOR,
});
console.log('   →', path.relative(root, ANCHOR));

// 앵커를 레퍼런스로 첨부해 나머지 생성
const VARIANTS = [
  ['news-left', 'news', 'left', '뉴스 진행 중, 심플한 스튜디오 배경'],
  ['news-right', 'news', 'right', '뉴스 진행 중, 심플한 스튜디오 배경'],
  ['daily-front', 'daily', 'front', '원룸에서 편하게 있는 모습, 자연광'],
  ['daily-left', 'daily', 'left', '카페에서 원고 보는 모습, 창가 자연광'],
  ['dressed-front', 'dressed', 'front', '외출 준비를 마친 모습, 도시 야경 보케 배경'],
];

console.log('\n2) 변형 생성 (앵커를 레퍼런스로 첨부)…');
for (const [name, look, angle, scene] of VARIANTS) {
  const out = path.join(OUT, `${name}.png`);
  try {
    await generateImage(scenePrompt(hana, { look, angle, scene }), {
      refImages: [ANCHOR],
      outPath: out,
    });
    console.log('   ✓', name);
  } catch (e) {
    console.error('   ✗', name, '—', e.message.slice(0, 120));
  }
}

console.log('\n완료 →', path.relative(root, OUT));
