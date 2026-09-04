// 프로세스 B: launchd KeepAlive로 상시 상주. grammY 롱 폴링.
// 승인(pub) 콜백 → 공유 파이프라인 실행. 스킵(skip) → status=skipped.
// (자동 발행이 켜져 있으면 대부분은 hourly-collect가 자동 처리하고, 여기선 한도 초과분의 수동 승인만 받는다.)
//
// 브이로그(vsel/vpub/vskip + 답장으로 글 수정)는 여기서만 발행된다 — 자동 발행 경로가 없다.
// 인스타에 초안·비공개 게시가 없어서, "올려두고 나중에 공개" 대신 "승인 전까지 안 올림"으로 간다.
//
// 각 핸들러는 갱신된 { text, keyboard }를 돌려주고, 봇이 검토 메시지를 그 자리에서 고쳐 쓴다.
import { existsSync } from 'node:fs';
import { startListener, report } from '../bot/index.js';
import { updateCandidateStatus, setMeta } from '../db/index.js';
import { generateAndPublish } from '../pipeline.js';
import { loadPost, savePost, selectedFiles, reviewText, reviewKeyboard, reelEligible, postStage, REEL_MIN_STAGE } from '../vlog/review.js';
import { dryRun, paths, telegram } from '../config.js';

async function onApprove(candidateId) {
  await generateAndPublish(candidateId);
}

async function onSkip(candidateId) {
  updateCandidateStatus(candidateId, 'skipped');
  console.log(`[bot] skipped candidate ${candidateId}`);
}

const view = (post) => (post ? { text: reviewText(post), keyboard: reviewKeyboard(post) } : null);

// 사진 선택 토글.
async function onVlogSelect(id, idx) {
  const post = loadPost(id);
  if (!post || post.status !== 'pending') return view(post);
  if (idx < 0 || idx >= post.selected.length) return view(post);
  post.selected[idx] = !post.selected[idx];
  savePost(post);
  console.log(`[bot] ${id} 사진 ${idx + 1} ${post.selected[idx] ? '선택' : '해제'}`);
  return view(post);
}

// 글 교체. 게시 전에 문구를 통째로 손볼 수 있게 한다.
async function onVlogCaption(id, caption) {
  const post = loadPost(id);
  if (!post) return null;
  if (post.status !== 'pending') return view(post);
  post.caption = caption;
  savePost(post);
  console.log(`[bot] ${id} 글 수정 (${caption.length}자)`);
  return view(post);
}

async function onVlogSkip(id) {
  const post = loadPost(id);
  if (!post) return null;
  if (post.status === 'pending') {
    post.status = 'skipped';
    savePost(post);
  }
  console.log(`[bot] ${id} 보류`);
  return view(post);
}

// 승인 → **선택한 사진으로 릴스를 만들어 텔레그램으로 보낸다.**
//
// ⚠️ 인스타에 자동 게시하지 않는다(2026-09-03 사용자 결정: "인스타는 내가 수동으로 올릴께").
//    예전에는 여기서 R2 업로드 후 publishPhoto/publishCarousel을 호출했다. 그 경로는
//    src/publisher/에 그대로 남아 있으니 되돌리려면 이 함수만 복구하면 된다.
//
// ⚠️ 릴스는 선택한 사진만 쓴다. 사용자가 텔레그램에서 고른 것이 곧 편집 결정이다.
async function onVlogPublish(id) {
  const post = loadPost(id);
  if (!post) {
    await report({ text: `⚠️ ${id} 를 찾지 못했습니다 (post.json 없음)` });
    return null;
  }
  if (post.status === 'published') {
    await report({ text: `이미 영상을 만든 글입니다 (${id})` });
    return view(post);
  }
  // 버튼을 숨겨도 예전 검토 메시지엔 버튼이 남아 있다. 여기서 한 번 더 막는다.
  if (!reelEligible(post)) {
    await report({ text: `⛔ ${id}는 점 빼기 전 시기 사진(단계 ${postStage(post)} < ${REEL_MIN_STAGE})이라 릴스를 만들지 않습니다` });
    return view(post);
  }

  try {
    const files = selectedFiles(post);
    if (files.length === 0) throw new Error('선택된 사진이 없습니다');

    await report({ text: `🎬 ${id} 영상 만드는 중… (사진 ${files.length}장, 1~2분)` });

    // 선택된 사진만 따로 모아 릴스를 만든다. tools/reel/build.sh는 photo-N.png 규칙을 따르므로
    // 임시 디렉터리에 1번부터 다시 번호를 매겨 넘긴다.
    const { mkdtempSync, copyFileSync, existsSync: exists } = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const tmp = mkdtempSync(pathMod.join(os.tmpdir(), 'reel-'));
    files.forEach((f, i) => {
      copyFileSync(f, pathMod.join(tmp, `photo-${i + 1}.png`));
      // 마스크가 있으면 같이 넘긴다 — 2.5D 패럴랙스가 인물을 오려내는 데 쓴다.
      const m = f.replace(/\.png$/, '.mask.png');
      if (exists(m)) copyFileSync(m, pathMod.join(tmp, `photo-${i + 1}.mask.png`));
    });
    copyFileSync(pathMod.join(pathMod.dirname(files[0]), 'post.json'), pathMod.join(tmp, 'post.json'));

    const out = pathMod.join(pathMod.dirname(files[0]), 'reel-selected.mp4');
    const { execFileSync } = await import('node:child_process');
    execFileSync('/bin/bash', [pathMod.join(paths.root, 'scripts/vlog-reel.sh'), tmp, out], {
      timeout: 900_000,
      env: { ...process.env, HERO_SLOT: post.slot },
    });
    if (!exists(out)) throw new Error('릴스 파일이 만들어지지 않았습니다');

    post.status = 'published';   // 「처리 완료」 표시. 인스타 게시가 아니라 영상 생성 완료다.
    post.reelPath = out;
    savePost(post);
    setMeta(`vlog_reel:${post.slot}`, new Date().toISOString());

    const { Bot, InputFile } = await import('grammy');
    const tg = new Bot(telegram.botToken);
    await tg.api.sendVideo(telegram.chatId, new InputFile(out), {
      caption: [
        `🎬 ${post.slot === 'day' ? '낮' : '저녁'} 일상 릴스 (사진 ${files.length}장)`,
        `소재: ${post.theme}`,
        '',
        post.caption,
      ].join('\n').slice(0, 1000),
    });
    return view(post);
  } catch (e) {
    console.error(`[bot] ${id} 영상 생성 실패:`, e);
    await report({ text: `⚠️ 영상 생성 실패 (${id})\n${String(e.message).slice(0, 400)}` });
    return view(loadPost(id)); // pending 유지 → 고쳐서 다시 시도할 수 있다
  }
}

startListener({ onApprove, onSkip, onVlogSelect, onVlogPublish, onVlogSkip, onVlogCaption });
console.log(`[bot] listener up (dryRun=${dryRun})`);
