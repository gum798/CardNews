// 텔레그램 봇 (grammY, 롱 폴링). 다이제스트 발송 · 승인 콜백 · 결과 보고.
// import만으로는 폴링/네트워크를 열지 않는다 (Bot은 함수 호출 시 지연 생성).
import { Bot, InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { telegram } from '../config.js';
import * as db from '../db/index.js';

const execFileAsync = promisify(execFile);

// 세로 영상 크기를 텔레그램에 알려준다. width/height를 안 주면 텔레그램이 비율을 모르고
// 미리보기를 납작하게 렌더링한다(파일 자체는 정상 9:16).
async function probeVideo(file) {
  try {
    const { stdout } = await execFileAsync('/opt/homebrew/bin/ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-show_entries', 'format=duration',
      '-of', 'json', file,
    ]);
    const j = JSON.parse(stdout);
    const s = j.streams?.[0] ?? {};
    const d = Number(j.format?.duration);
    return {
      width: Number(s.width) || undefined,
      height: Number(s.height) || undefined,
      duration: Number.isFinite(d) ? Math.round(d) : undefined,
    };
  } catch {
    return {}; // 메타 없이도 전송은 되게
  }
}

// 단일 Bot 인스턴스를 지연 생성 (프로세스 A/B가 각각 필요한 함수만 호출).
let _bot;
function getBot() {
  if (!_bot) _bot = new Bot(telegram.botToken);
  return _bot;
}

// 다이제스트: 후보별 제목+요약+AI 사유 텍스트 + [발행][스킵] 인라인 버튼.
// message_id를 DB에 저장해 콜백 시 버튼 교체에 사용. 폴링은 시작하지 않는다.
export async function sendDigest(candidates) {
  const bot = getBot();
  for (const { id, newsItem, reason } of candidates) {
    const full = newsItem.summary ?? '';
    const summary = full.length > 200 ? full.slice(0, 200) + '…' : full;
    const text = `${newsItem.title}\n\n${summary}\n\n🤖 ${reason}`;
    const keyboard = new InlineKeyboard().text('발행', `pub:${id}`).text('스킵', `skip:${id}`);
    const msg = await bot.api.sendMessage(telegram.chatId, text, { reply_markup: keyboard });
    db.setCandidateTelegramMessageId(id, msg.message_id);
  }
}

// 롱 폴링 리스너. pub/skip 콜백을 화이트리스트 검사 후 처리한다.
// 버튼을 "⏳ 생성 중…"으로 교체해 중복 탭을 막고 콜백을 실행. Bot 인스턴스 반환.
export function startListener({ onApprove, onSkip }) {
  const bot = getBot();
  const generating = () => new InlineKeyboard().text('⏳ 생성 중…', 'noop');

  // 허용 chat_id가 아니면 무시 (본인만 조작).
  const allowed = (ctx) => String(ctx.chat?.id) === String(telegram.chatId);

  // 콜백 응답 + 버튼 교체는 부가 UX — 오래된 쿼리 등으로 실패해도 파이프라인은 계속 진행.
  async function ack(ctx) {
    try {
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: generating() });
    } catch (e) {
      console.warn('[bot] ack 실패(계속 진행):', e?.description || e?.message);
    }
  }

  bot.callbackQuery(/^pub:(\d+)$/, async (ctx) => {
    if (!allowed(ctx)) return void ctx.answerCallbackQuery().catch(() => {});
    await ack(ctx);
    await onApprove(Number(ctx.match[1]));
  });

  bot.callbackQuery(/^skip:(\d+)$/, async (ctx) => {
    if (!allowed(ctx)) return void ctx.answerCallbackQuery().catch(() => {});
    await ack(ctx);
    await onSkip(Number(ctx.match[1]));
  });

  // 핸들러에서 던진 에러가 프로세스를 죽이지 않게 (없으면 update 재전송→크래시 루프).
  bot.catch((err) => {
    console.error('[bot] handler error:', err?.error?.description || err?.message || err);
  });

  bot.start(); // 롱 폴링 시작 (블로킹 프로미스이므로 await 하지 않음)
  return bot;
}

// 결과 보고: 카드 앨범(sendMediaGroup) + 릴스 영상 + 텍스트.
// 미디어 그룹은 인라인 버튼을 못 실으므로 텍스트를 뒤에 별도 전송. videoPath 주면 릴스도 첨부(수동 업로드용).
export async function report({ text, mediaPaths, videoPath }) {
  const bot = getBot();
  if (mediaPaths && mediaPaths.length) {
    if (mediaPaths.length === 1) {
      await bot.api.sendPhoto(telegram.chatId, new InputFile(mediaPaths[0]));
    } else {
      const media = mediaPaths.map((p) => InputMediaBuilder.photo(new InputFile(p)));
      await bot.api.sendMediaGroup(telegram.chatId, media);
    }
  }
  if (videoPath) {
    const meta = await probeVideo(videoPath);
    await bot.api.sendVideo(telegram.chatId, new InputFile(videoPath), {
      ...meta,
      supports_streaming: true,
    });
  }
  if (text) await bot.api.sendMessage(telegram.chatId, text);
}
