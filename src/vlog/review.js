// 브이로그 검토 상태. out/<id>/post.json 하나가 진실의 원천이다.
//
// 인스타 API에는 초안·비공개·예약 게시가 없다(컨테이너를 안 올리면 앱에서 보이지도 않고
// 24시간 뒤 만료). 그래서 "올려두고 나중에 공개"가 아니라 "승인 전까지 아예 안 올림"으로 간다.
// 검토 목적으로는 이쪽이 안전하다 — 잘못 나간 글이 잠깐이라도 노출될 일이 없다.
import { InlineKeyboard } from 'grammy';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';

const ID_RE = /^vlog-\d{8}-(day|evening)$/;

export function postPath(id) {
  return path.join(paths.out, id, 'post.json');
}

export function loadPost(id) {
  if (!ID_RE.test(id)) return null; // 경로 주입 방지
  const p = postPath(id);
  if (!existsSync(p)) return null;
  try {
    const post = JSON.parse(readFileSync(p, 'utf8'));
    // 예전 파일 호환: selected가 없으면 전부 선택으로 본다.
    if (!Array.isArray(post.selected) || post.selected.length !== post.files.length) {
      post.selected = post.files.map(() => true);
    }
    // status가 없으면 검토 대기로 본다. 없다고 편집을 막으면 사진 토글이 조용히 씹힌다.
    if (!post.status) post.status = 'pending';
    return post;
  } catch {
    return null;
  }
}

export function savePost(post) {
  writeFileSync(postPath(post.id), JSON.stringify(post, null, 2));
  return post;
}

// 선택된 사진만, 원래 순서대로.
export function selectedFiles(post) {
  return post.files.filter((f, i) => post.selected[i] && existsSync(f));
}

export function reviewText(post) {
  const n = post.selected.filter(Boolean).length;
  const lines = [
    `📸 하나 일상 (${post.slot === 'day' ? '낮' : '저녁'}) — 검토`,
    `소재: ${post.theme}`,
    '',
    post.caption,
    '',
    `🖼 사진 ${n}/${post.files.length}장 선택됨`,
  ];
  if (post.status === 'published') {
    lines.push('', `✅ 게시 완료 (media_id: ${post.mediaId})`);
  } else if (post.status === 'skipped') {
    lines.push('', '🗑 보류함');
  } else {
    lines.push(
      '',
      '✏️ 글을 고치려면 이 메시지에 답장으로 새 글을 보내세요.',
      '🖼 번호 버튼으로 쓸 사진을 고르세요.',
      '📤 버튼을 누르기 전까지 인스타에 올라가지 않습니다.'
    );
  }
  return lines.join('\n');
}

export function reviewKeyboard(post) {
  const kb = new InlineKeyboard();
  if (post.status === 'published') return kb.text('✅ 게시됨', 'noop');
  if (post.status === 'skipped') return kb.text('🗑 보류함', 'noop');

  // 사진 토글 — 한 줄에 최대 5개
  post.files.forEach((_, i) => {
    kb.text(`${i + 1} ${post.selected[i] ? '✅' : '⬜️'}`, `vsel:${post.id}:${i}`);
    if ((i + 1) % 5 === 0) kb.row();
  });
  kb.row();

  const n = post.selected.filter(Boolean).length;
  // 사진이 0장이면 게시할 게 없다 — 버튼을 눌러도 아무 일 없게 안내로 바꾼다.
  kb.text(n > 0 ? '📤 인스타 게시' : '⚠️ 사진을 골라주세요', n > 0 ? `vpub:${post.id}` : 'noop');
  kb.text('🗑 보류', `vskip:${post.id}`);
  return kb;
}
