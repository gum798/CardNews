// 이미 만들어 둔 브이로그의 검토 메시지를 다시 보낸다. 사진은 재생성하지 않는다.
// 검토 UI를 고쳤거나 메시지를 지웠을 때 쓴다.
//
// 사용: node scripts/vlog-resend.mjs [vlog-20260805-day]
//       인자를 생략하면 가장 최근 pending 건.
import '../src/config.js';
import { Bot, InputFile, InputMediaBuilder } from 'grammy';
import { existsSync, readdirSync } from 'node:fs';
import { telegram, paths } from '../src/config.js';
import { loadPost, savePost, reviewText, reviewKeyboard } from '../src/vlog/review.js';

// 검토 대기 중인 것을 우선, 없으면 post.json이 있는 가장 최근 건.
// post.json이 없는 디렉터리(구버전에서 만든 것)는 되살릴 정보가 없으므로 고르지 않는다.
function latestPending() {
  const dirs = readdirSync(paths.out)
    .filter((d) => /^vlog-\d{8}-(day|evening)$/.test(d))
    .sort()
    .reverse();
  const withPost = dirs.map((d) => [d, loadPost(d)]).filter(([, p]) => p);
  return (
    withPost.find(([, p]) => p.status === 'pending')?.[0] || withPost[0]?.[0] || null
  );
}

const id = process.argv[2] || latestPending();
if (!id) {
  console.error('보낼 브이로그가 없습니다');
  process.exit(1);
}

const post = loadPost(id);
if (!post) {
  console.error(`${id}: post.json이 없습니다 (이 스크립트는 새로 만들지 않습니다)`);
  process.exit(1);
}

const files = post.files.filter(existsSync);
if (files.length === 0) {
  console.error(`${id}: 사진 파일이 남아있지 않습니다`);
  process.exit(1);
}

const bot = new Bot(telegram.botToken);
if (files.length === 1) {
  await bot.api.sendPhoto(telegram.chatId, new InputFile(files[0]), { caption: '1' });
} else {
  await bot.api.sendMediaGroup(
    telegram.chatId,
    files.map((f, i) => InputMediaBuilder.photo(new InputFile(f), { caption: `${i + 1}` }))
  );
}

const msg = await bot.api.sendMessage(telegram.chatId, reviewText(post), {
  reply_markup: reviewKeyboard(post),
});
post.reviewMessageId = msg.message_id;
savePost(post);

console.log(`[vlog] ${id} 검토 메시지 재전송 (사진 ${files.length}장, 상태 ${post.status})`);
process.exit(0);
