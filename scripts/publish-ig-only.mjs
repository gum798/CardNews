// 이미 렌더·업로드된 후보를 인스타그램에만 재발행 (유튜브 재업로드 없음).
// IG 발행만 실패했을 때 복구용. 실행:
//   NODE_EXTRA_CA_CERTS=certs/corp-root.pem node scripts/publish-ig-only.mjs 40
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getCandidate, insertPublish, updateCandidateStatus } from '../src/db/index.js';
import { publishCarousel, publishReel, checkPublishingLimit } from '../src/publisher/index.js';
import { publicUrlFor } from '../src/storage/index.js';
import { report } from '../src/bot/index.js';
import { account, dryRun, profile } from '../src/config.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const id = Number(process.argv[2]);
if (!Number.isFinite(id)) {
  console.error('사용법: node scripts/publish-ig-only.mjs <후보번호>');
  process.exit(1);
}

const cand = getCandidate(id);
if (!cand) throw new Error(`후보 ${id} 없음`);
const caption = cand.card?.caption ?? '';

const dir = path.join(ROOT, 'out', String(id));
if (!existsSync(dir)) throw new Error(`렌더 결과 폴더 없음: ${dir} (재생성이 필요합니다)`);
const cardCount = readdirSync(dir).filter((f) => /^card-\d+\.jpg$/.test(f)).length;
if (!cardCount) throw new Error('카드 이미지가 없습니다');

// 업로드 시 사용한 키 규칙(storage/index.js)과 동일하게 URL 재구성.
const cardUrls = Array.from({ length: cardCount }, (_, i) => publicUrlFor(`${id}/card-${i + 1}.jpg`));
const reelUrl = publicUrlFor(`${id}/reel.mp4`);
const coverUrl = publicUrlFor(`${id}/cover.jpg`);

console.log(`[ig-only] [${profile.key}/${account.name}] 후보 ${id} (${cand.topic}) 카드 ${cardCount}장, dryRun=${dryRun}`);
console.log(`[ig-only] 캡션: ${caption.slice(0, 60)}…`);

await checkPublishingLimit();

let carouselId = null;
let reelId = null;
try {
  carouselId = await publishCarousel(cardUrls, caption);
} catch (e) {
  console.error('[ig-only] 캐러셀 실패:', e.message);
}
try {
  reelId = await publishReel(reelUrl, coverUrl, caption);
} catch (e) {
  console.error('[ig-only] 릴스 실패:', e.message);
}

if (!carouselId && !reelId) {
  await report({ text: `❌ [후보 ${id}] 인스타 재발행 실패` }).catch(() => {});
  console.error('[ig-only] 둘 다 실패');
  process.exit(1);
}

insertPublish({ candidateId: id, igCarouselId: carouselId, igReelId: reelId });
updateCandidateStatus(id, 'published');

const lines = [`✅ [후보 ${id}] 인스타 재발행 완료`];
if (carouselId) lines.push(`📷 캐러셀: ${carouselId}`);
if (reelId) lines.push(`🎬 릴스: ${reelId}`);
await report({ text: lines.join('\n') }).catch(() => {});
console.log('[ig-only]', lines.join(' / '));
process.exit(0);
