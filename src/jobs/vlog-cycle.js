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
import { generateImage, scenePrompt } from '../persona/image.js';
import { hana } from '../persona/hana.js';
import { paths, telegram } from '../config.js';
import { setMeta } from '../db/index.js';

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

  // 사진 생성. 첫 장은 인물 정면, 나머지는 각도를 바꿔 같은 방 안의 다른 컷처럼.
  const angles = ['front', 'left', 'right'];
  const files = [];
  for (let i = 0; i < post.photos.length; i++) {
    const ph = post.photos[i];
    const out = path.join(outDir, `photo-${i + 1}.png`);
    try {
      await generateImage(
        scenePrompt(hana, {
          look: ph.look,
          angle: angles[i % angles.length],
          scene: ph.action,
          framing: 'feed',
        }),
        { outPath: out }
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
