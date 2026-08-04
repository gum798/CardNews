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

// 점 제거 에피소드 전/후 두 벌을 만든다. 눈물점은 양쪽 공통이라 같은 사람으로 읽히고,
// 입가 점 유무만 달라져 "변화"가 스토리로 설명된다.
const PHASES = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const TARGETS = PHASES.length ? PHASES : ['before', 'after'];

// 배경은 전부 같은 원룸. 달라지는 건 옷·자세·행동뿐이다.
const VARIANTS = [
  ['news-left', 'news', 'left', 'sitting at the desk reading the news to camera'],
  ['news-right', 'news', 'right', 'sitting at the desk reading the news to camera'],
  ['daily-front', 'daily', 'front', 'sitting relaxed on the bed edge, holding the mug'],
  ['daily-left', 'daily', 'left', 'at the desk marking a printed script with a pen'],
  ['dressed-front', 'dressed', 'front', 'standing near the clothing rack, ready to go out'],
];

for (const phase of TARGETS) {
  const OUT = path.join(root, 'assets', 'persona', 'hana', phase);
  await mkdir(OUT, { recursive: true });
  console.log(`\n════ ${phase} (${hana.appearance.phases[phase]?.label || phase}) ════`);

  // 앵커: 뉴스 룩 정면. 이 한 장이 그 시기 모든 이미지의 기준이 된다.
  const ANCHOR = path.join(OUT, 'anchor-news-front.png');
  console.log('1) 앵커 생성…');
  await generateImage(
    scenePrompt(hana, { look: 'news', angle: 'front', scene: 'sitting at the desk reading the news to camera', phase }),
    { outPath: ANCHOR }
  );
  console.log('   →', path.relative(root, ANCHOR));

  console.log('2) 변형 생성 (앵커를 레퍼런스로 첨부)…');
  for (const [name, look, angle, scene] of VARIANTS) {
    try {
      await generateImage(scenePrompt(hana, { look, angle, scene, phase, withReference: true, seed: name }), {
        refImages: [ANCHOR],
        outPath: path.join(OUT, `${name}.png`),
      });
      console.log('   ✓', name);
    } catch (e) {
      console.error('   ✗', name, '—', e.message.slice(0, 120));
    }
  }
}

console.log('\n완료 → assets/persona/hana/{' + TARGETS.join(',') + '}');
