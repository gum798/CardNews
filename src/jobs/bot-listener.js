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
import { uploadFile } from '../storage/index.js';
import { publishCarousel, publishPhoto } from '../publisher/index.js';
import { loadPost, savePost, selectedFiles, reviewText, reviewKeyboard } from '../vlog/review.js';
import { dryRun, account } from '../config.js';

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

// 승인 → R2 업로드 → 인스타 피드 게시. 1장이면 단일 사진, 2장 이상이면 캐러셀.
async function onVlogPublish(id) {
  const post = loadPost(id);
  if (!post) {
    await report({ text: `⚠️ ${id} 를 찾지 못했습니다 (post.json 없음)` });
    return null;
  }
  if (post.status === 'published') {
    await report({ text: `이미 게시된 글입니다 (${id})` });
    return view(post);
  }

  try {
    const files = selectedFiles(post);
    if (files.length === 0) throw new Error('선택된 사진이 없습니다');

    const urls = [];
    for (let i = 0; i < files.length; i++) {
      // 사진은 확장자가 .png지만 내용은 JPEG다(생성 API 산출물) → content-type을 내용에 맞춘다.
      urls.push(await uploadFile(`${id}/photo-${i + 1}.jpg`, files[i], 'image/jpeg'));
    }
    console.log(`[bot] ${id} R2 업로드 ${urls.length}장`);

    const mediaId =
      urls.length === 1
        ? await publishPhoto(urls[0], post.caption)
        : await publishCarousel(urls, post.caption);

    post.status = 'published';
    post.mediaId = mediaId;
    savePost(post);
    setMeta(`vlog_published:${post.slot}`, new Date().toISOString());

    await report({
      text: [
        `✅ 인스타 게시 완료 (${post.slot === 'day' ? '낮' : '저녁'} 일상)`,
        `소재: ${post.theme} / 사진 ${files.length}장`,
        `media_id: ${mediaId}`,
        `https://instagram.com/${String(account.handle || '').replace('@', '')}`,
      ].join('\n'),
    });
    return view(post);
  } catch (e) {
    console.error(`[bot] ${id} 게시 실패:`, e);
    await report({ text: `⚠️ 인스타 게시 실패 (${id})\n${String(e.message).slice(0, 400)}` });
    return view(loadPost(id)); // pending 유지 → 고쳐서 다시 시도할 수 있다
  }
}

startListener({ onApprove, onSkip, onVlogSelect, onVlogPublish, onVlogSkip, onVlogCaption });
console.log(`[bot] listener up (dryRun=${dryRun})`);
