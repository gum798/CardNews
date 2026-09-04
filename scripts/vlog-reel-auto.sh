#!/bin/bash
# 검토 대기 중인 브이로그에 릴스를 붙인다.
#
# ⚠️ 원격 API(ZeroGPU) + ffmpeg만 쓴다 — 로컬 모델이 아니므로 업무시간 가드를 걸지 않는다.
# ⚠️ 이미 reel.mp4가 있으면 건너뛴다. 몇 번 깨워도 안전해야 한다.
# ⚠️ 점 빼기 전 시기 게시물(단계 3 미만)은 만들지 않는다 — src/vlog/review.js reelEligible.
#    2026-09-03 사용자 결정 「점빼고 얼굴이뻐지고 난 이후 사진만」. 옛 얼굴이 릴스에 섞이면 안 된다.
set -u
ROOT=/Users/seojeonghwa/project/CardNews
LOG="$ROOT/out/vlog-reel.log"
say() { echo "[auto] $(date '+%F %T') $*" >> "$LOG"; }

made=0
old=0
for d in "$ROOT"/out/vlog-*/; do
  [ -f "$d/post.json" ] || continue
  # 검토 대기(pending)이고 릴스 자격이 있는 것만. 이미 발행했거나 버린 건 건드리지 않는다.
  # (node 출력에 .env 배너가 섞이므로 S> 표식으로 골라낸다)
  st=$(cd "$ROOT" && D="$d" /opt/homebrew/bin/node --input-type=module -e "
    const { loadPost, reelEligible } = await import('./src/vlog/review.js');
    const p = loadPost(process.env.D.split('/').filter(Boolean).pop());
    console.log('S>' + (p ? p.status : '') + ':' + (p && reelEligible(p) ? 1 : 0));" 2>/dev/null | grep -oE '^S>.*' | cut -c3-)
  case "$st" in
    *:0)
      # 자격 없는 게시물에 릴스가 남아 있으면 지운다. 실측 2026-09-03: 가드 전에 돌던 루프가
      # 옛 얼굴 릴스를 다시 만들어 놓았다. 「있으면 건너뜀」만 하면 그게 영영 남는다.
      if [ -f "$d/reel.mp4" ]; then rm -f "$d/reel.mp4"; say "$(basename "$d") 옛 시기 릴스 삭제"; fi
      [ "${st%%:*}" = "pending" ] && old=$((old+1))
      continue ;;
    pending:1) [ -f "$d/reel.mp4" ] && continue ;;
    *) continue ;;
  esac

  say "$(basename "$d") 릴스 생성 시작"
  bash "$ROOT/scripts/vlog-reel.sh" "$d" "$d/reel.mp4" >> "$LOG" 2>&1
  if [ -f "$d/reel.mp4" ]; then
    dur=$(/opt/homebrew/bin/ffprobe -v error -show_entries format=duration -of csv=p=0 "$d/reel.mp4" 2>/dev/null)
    say "$(basename "$d") 완료 ${dur%.*}초"
    made=$((made+1))
    (cd "$ROOT" && D="$d" DUR="${dur%.*}" /opt/homebrew/bin/node -e "
      import('grammy').then(async ({ Bot, InputFile }) => {
        const { telegram } = await import('./src/config.js');
        const bot = new Bot(telegram.botToken);
        await bot.api.sendVideo(telegram.chatId, new InputFile(process.env.D + '/reel.mp4'),
          { caption: '🎬 ' + process.env.D.split('/').filter(Boolean).pop() + ' 릴스 (' + process.env.DUR + '초)' });
      });" >> "$LOG" 2>&1)
  else
    say "$(basename "$d") 실패"
  fi
done
[ "$old" -gt 0 ] && say "점 빼기 전 시기 게시물 ${old}건 건너뜀(릴스 자격 없음)"
[ "$made" -eq 0 ] && say "만들 것 없음"
