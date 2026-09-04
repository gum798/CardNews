// 브이로그 검토 상태. out/<id>/post.json 하나가 진실의 원천이다.
//
// 인스타 API에는 초안·비공개·예약 게시가 없다(컨테이너를 안 올리면 앱에서 보이지도 않고
// 24시간 뒤 만료). 그래서 "올려두고 나중에 공개"가 아니라 "승인 전까지 아예 안 올림"으로 간다.
// 검토 목적으로는 이쪽이 안전하다 — 잘못 나간 글이 잠깐이라도 노출될 일이 없다.
import { InlineKeyboard } from 'grammy';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { stageOn } from '../persona/hana.js';

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

// 이 게시물이 만들어진 변신 단계. 2026-09-03부터는 post.json에 적혀 있고,
// 그 전 것은 날짜로 되짚는다(hana.STAGE_HISTORY).
export function postStage(post) {
  if (Number.isInteger(post.stage)) return post.stage;
  return stageOn(String(post.id || '').replace(/^vlog-/, ''));
}

// 릴스에 쓸 수 있는 게시물인가.
// ⚠️ 2026-09-03 사용자 결정: 「점 빼고 얼굴 이뻐지고 난 이후 사진만」. 단계 3(화장이
//    또렷해진 시기, phase after)부터다. 그 전 사진은 점·자국이 있고 화장기가 없어서
//    지금 얼굴과 다른 사람처럼 보인다 — 릴스로 올리면 한 계정 안에 얼굴이 둘이 된다.
//    사진 게시물(캐러셀)까지 막지는 않는다. 그건 사람이 보고 고른다.
export const REEL_MIN_STAGE = 3;
export function reelEligible(post) {
  return postStage(post) >= REEL_MIN_STAGE;
}

export function reviewText(post) {
  const n = post.selected.filter(Boolean).length;
  const lines = [
    `📸 하나 일상 (${post.slot === 'day' ? '낮' : '저녁'}) — 검토`,
    `소재: ${post.theme}`,
    '',
    post.caption,
    '',
    `🖼 사진 ${n}/${post.files.length}장 선택됨  (기본 해제 — 쓸 것만 체크)`,
  ];
  // 검수에 걸린 컷을 알려준다. 걸렸다고 못 쓰는 건 아니고 사람이 보고 판단한다.
  if (post.flagged?.length) {
    lines.push(`⚠️ 검수 걸림: ${post.flagged.map((i) => i + 1).join(', ')}번`);
  }
  if (!reelEligible(post)) {
    lines.push(`⛔ 점 빼기 전 시기 얼굴(단계 ${postStage(post)}) — 릴스는 만들지 않습니다`);
  }
  if (post.status === 'published') {
    lines.push('', '✅ 영상 생성 완료');
  } else if (post.status === 'skipped') {
    lines.push('', '🗑 보류함');
  } else {
    lines.push(
      '',
      '✏️ 글을 고치려면 이 메시지에 답장으로 새 글을 보내세요.',
      '🖼 번호 버튼으로 쓸 사진을 고르세요 (기본은 전부 해제).',
      reelEligible(post)
        ? '🎬 「영상 만들기」를 누르면 고른 사진으로 릴스를 만들어 보내드립니다.'
        : '📷 이 글은 사진 게시물로만 씁니다 (릴스 없음).'
    );
  }
  return lines.join('\n');
}

export function reviewKeyboard(post) {
  const kb = new InlineKeyboard();
  // ⚠️ published는 「인스타 게시됨」이 아니라 「영상 생성 완료」다.
  //    2026-09-03부터 인스타 자동 게시를 끄고, 승인하면 릴스를 만들어 텔레그램으로 보낸다.
  if (post.status === 'published') return kb.text('✅ 영상 만듦', 'noop');
  if (post.status === 'skipped') return kb.text('🗑 보류함', 'noop');

  // 사진 토글 — 한 줄에 최대 5개
  post.files.forEach((_, i) => {
    kb.text(`${i + 1} ${post.selected[i] ? '✅' : '⬜️'}`, `vsel:${post.id}:${i}`);
    if ((i + 1) % 5 === 0) kb.row();
  });
  kb.row();

  const n = post.selected.filter(Boolean).length;
  // 사진이 0장이면 게시할 게 없다 — 버튼을 눌러도 아무 일 없게 안내로 바꾼다.
  // 점 빼기 전 시기 게시물은 릴스 버튼 자체를 빼서 실수로 못 누르게 한다(reelEligible).
  if (!reelEligible(post)) kb.text('⛔ 이전 시기 — 릴스 없음', 'noop');
  else kb.text(n > 0 ? `🎬 영상 만들기 (${n}장)` : '⚠️ 사진을 골라주세요', n > 0 ? `vpub:${post.id}` : 'noop');
  kb.text('🗑 보류', `vskip:${post.id}`);
  return kb;
}
