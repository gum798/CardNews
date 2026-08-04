// 하나의 일상 브이로그 생성 → 텔레그램 전송. **자동 발행하지 않는다.**
// 사람이 보고 판단한 뒤 직접 올린다. 그래서 정책 리스크가 사실상 0이고,
// 실패해도 잃는 게 없다(생성 비용 몇 센트).
//
// 실행: VLOG_SLOT=day node src/jobs/vlog-cycle.js
// launchd: com.cardnews.vlog.plist (낮 13시 / 저녁 21시)
import { Bot, InputFile } from 'grammy';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { writeVlog } from '../curator/vlog.js';
import { synthesizeLines } from '../tts/index.js';
import { renderReelLines } from '../renderer/index.js';
import { makeNarratedReel } from '../video/index.js';
import { getKeyframe } from '../persona/keyframe.js';
import { searchTopicVideos, downloadVideo } from '../images/index.js';
import { hana } from '../persona/hana.js';
import { paths, telegram, reel as reelCfg } from '../config.js';
import { setMeta } from '../db/index.js';

// 후보 번호와 충돌하지 않게 별도 네임스페이스를 쓴다(발행 파이프라인과 무관한 산출물).
function vlogId(slot) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `vlog-${stamp}-${slot}`;
}

async function main() {
  const slot = process.env.VLOG_SLOT === 'evening' ? 'evening' : 'day';
  const id = vlogId(slot);
  console.log(`[vlog] start slot=${slot} id=${id}`);

  const data = await writeVlog(slot);
  console.log(`[vlog] 소재: ${data.theme}`);
  console.log(`[vlog] 훅: ${data.script.hook}`);

  const outDir = path.join(paths.out, id);
  await mkdir(outDir, { recursive: true }); // 배경 영상 다운로드 전에 있어야 한다

  // 배경: 브이로그는 하나가 주인공이므로 실사 스톡 영상 대신 방(키프레임)을 크게 쓴다.
  const look = slot === 'day' ? 'daily' : 'daily';
  const keyframe = await getKeyframe(slot === 'day' ? 'intro' : 'outro').catch(() => null);

  // 배경 영상은 있으면 쓰고 없으면 생략(키프레임이 배경 역할을 한다)
  let bgVideo = null;
  if (reelCfg.stockVideo && data.imageKeywords) {
    try {
      const vids = await searchTopicVideos(data.imageKeywords);
      if (vids.length) bgVideo = await downloadVideo(vids[0].url, path.join(outDir, 'bg.mp4'));
    } catch { /* 없으면 그냥 진행 */ }
  }

  const narration = [data.script.hook, ...data.script.lines];
  const segments = await synthesizeLines(narration, path.join(outDir, 'audio'));

  const frames = await renderReelLines(id, data.script, {
    theme: 'dark',
    bgs: keyframe ? ['file://' + keyframe] : [],
    account: hana.brand.account,
    aiNotice: 'AI 생성 콘텐츠',
    transparent: Boolean(bgVideo),
    persona: keyframe ? { intro: keyframe, outro: keyframe } : null,
  });

  const reelPath = await makeNarratedReel(id, frames, segments, { bgVideo });
  console.log(`[vlog] 영상 생성 완료: ${reelPath}`);

  // 텔레그램 전송 — 발행 버튼 없이 검토용으로만.
  const bot = new Bot(telegram.botToken);
  const text = [
    `🎬 하나 브이로그 (${slot === 'day' ? '낮' : '저녁'}) — 검토용`,
    '',
    `소재: ${data.theme}`,
    '',
    `「${data.script.hook}」`,
    '',
    data.script.lines.map((l, i) => `${i + 1}. ${l}`).join('\n'),
    '',
    data.script.shareCta ? `공유: ${data.script.shareCta}` : '',
    '',
    '📋 캡션 (복사용):',
    data.caption,
    '',
    '⚠️ 자동 발행하지 않았습니다. 확인 후 직접 올리세요.',
  ]
    .filter((x) => x !== undefined)
    .join('\n');

  await bot.api.sendMessage(telegram.chatId, text);
  await bot.api.sendVideo(telegram.chatId, new InputFile(reelPath), { supports_streaming: true });
  setMeta(`vlog_last:${slot}`, new Date().toISOString());
  console.log('[vlog] 텔레그램 전송 완료');
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[vlog] fatal:', err);
    try {
      const bot = new Bot(telegram.botToken);
      await bot.api.sendMessage(telegram.chatId, `⚠️ 브이로그 생성 실패\n${String(err.message).slice(0, 300)}`);
    } catch {}
    process.exit(1);
  });
