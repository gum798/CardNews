// 하나의 일상 포스트(사진 + 글) 생성 → 텔레그램 전송. **자동 발행하지 않는다.**
// 사람이 보고 판단한 뒤 직접 올린다. 발행 단계가 없어 정책 리스크가 사실상 0이다.
//
// 뉴스는 나레이션 릴스, 일상은 인스타 피드 사진 포스트로 형식을 완전히 나눈다.
//
// 실행: VLOG_SLOT=day node src/jobs/vlog-cycle.js
// launchd: com.cardnews.vlog.plist (낮 13시 / 저녁 21시)
import { Bot, InputFile, InputMediaBuilder } from 'grammy';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { writeVlogPost } from '../curator/vlog.js';
import { generateImage, scenePrompt, COMPOSITION_SETS } from '../persona/image.js';
import { anchorPath } from '../persona/keyframe.js';
import { hana } from '../persona/hana.js';
import { paths, telegram } from '../config.js';
import { setMeta } from '../db/index.js';

// 같은 날 같은 슬롯이면 항상 같은 순서 — 재실행해도 결과가 튀지 않는다.
// ⚠️ 단순 h*31 해시는 시드가 한 글자만 다르면 결과가 거의 안 바뀐다.
//    (날짜 시드가 딱 그런 형태라 실제로 일주일 내내 같은 구도가 나왔다)
//    FNV-1a + 눈사태 믹서로 작은 입력 차이가 출력 전체를 바꾸게 한다.
function hashSeed(seed) {
  let h = 0x811c9dc5;
  for (const c of String(seed)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 눈사태(avalanche)
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function shuffleWithSeed(arr, seed) {
  let h = hashSeed(seed);
  const next = () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return h;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function postId(slot) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `vlog-${stamp}-${slot}`;
}

async function main() {
  const slot = process.env.VLOG_SLOT === 'evening' ? 'evening' : 'day';
  const id = postId(slot);
  console.log(`[vlog] start slot=${slot} id=${id}`);

  const post = await writeVlogPost(slot);
  console.log(`[vlog] 소재: ${post.theme} / 사진 ${post.photos.length}장`);

  const outDir = path.join(paths.out, id);
  await mkdir(outDir, { recursive: true });

  // 사진 생성. 앵커를 첨부해 같은 사람을 유지하고, 구도·조명을 바꿔 다른 컷처럼 보이게 한다.
  // 매번 같은 "책상 앞 반신"이면 계정 전체가 한 장짜리처럼 보인다.
  // 슬롯마다 구도 세트를 다르게 두고, 그 안에서 날짜 시드로 섞는다.
  const anchor = anchorPath();
  const framings = ['feedWindow', 'feedWindow', 'feedFlash']; // 세 번째 컷만 플래시
  // 첫 장은 반드시 셀카 — 피드 썸네일에 얼굴이 걸려야 한다.
  const set = COMPOSITION_SETS[slot] || COMPOSITION_SETS.day;
  const compositions = [
    shuffleWithSeed(set.first, id)[0],
    ...shuffleWithSeed(set.rest, id),
  ];
  const files = [];
  for (let i = 0; i < post.photos.length; i++) {
    const ph = post.photos[i];
    const out = path.join(outDir, `photo-${i + 1}.png`);
    try {
      await generateImage(
        scenePrompt(hana, {
          look: ph.look,
          composition: compositions[i % compositions.length],
          scene: ph.action,
          framing: framings[i % framings.length],
          withReference: Boolean(anchor),
          seed: `${id}-${i}`,
        }),
        { outPath: out, refImages: anchor ? [anchor] : [] }
      );
      files.push(out);
      console.log(`[vlog] 사진 ${i + 1} 생성`);
    } catch (e) {
      console.warn(`[vlog] 사진 ${i + 1} 실패: ${e.message.slice(0, 120)}`);
    }
  }
  if (files.length === 0) throw new Error('사진을 한 장도 만들지 못했습니다');

  // 텔레그램 전송 — 검토용. 캡션은 복사해서 쓸 수 있게 따로 보낸다.
  const bot = new Bot(telegram.botToken);
  const caption = [post.caption, '', post.hashtags.join(' ')].filter(Boolean).join('\n');

  if (files.length === 1) {
    await bot.api.sendPhoto(telegram.chatId, new InputFile(files[0]));
  } else {
    await bot.api.sendMediaGroup(
      telegram.chatId,
      files.map((f) => InputMediaBuilder.photo(new InputFile(f)))
    );
  }

  await bot.api.sendMessage(
    telegram.chatId,
    [
      `📸 하나 일상 (${slot === 'day' ? '낮' : '저녁'}) — 검토용`,
      `소재: ${post.theme}`,
      '',
      '📋 캡션 (복사용):',
      caption,
      '',
      '⚠️ 자동 발행하지 않았습니다. 사진 저장 후 직접 올리세요.',
    ].join('\n')
  );

  setMeta(`vlog_last:${slot}`, new Date().toISOString());
  console.log('[vlog] 텔레그램 전송 완료');
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[vlog] fatal:', err);
    try {
      const bot = new Bot(telegram.botToken);
      await bot.api.sendMessage(
        telegram.chatId,
        `⚠️ 일상 포스트 생성 실패\n${String(err.message).slice(0, 300)}`
      );
    } catch {}
    process.exit(1);
  });
