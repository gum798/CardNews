#!/bin/bash
# 「가구 보러 간 날 → 종아리 풀러 간 날」 2편을 하루치로 만들어 두는 일회성 스크립트.
#
# 왜 따로 두는가:
#   사용자가 실제로 다녀온 사진을 보고 만든 지정 소재라, 21시 크론이 무작위 소재로
#   덮어쓰면 안 된다. 미리 만들어 두면 크론은 「검토 대기 중」을 보고 건너뛴다.
#
# ⚠️ 두 편을 연달아 만들면 안 된다. 5장 x 2편 = 14,160뉴런이고 하루 한도가 20,000인데
#    뉴스 발행이 같은 풀에서 하루 약 6,000을 쓴다(8/30 실측). 연달아 돌리면 뉴스가 죽는다.
#    그래서 낮 편은 리셋 직후, 저녁 편은 뉴스가 하루치를 쓴 뒤에 만든다.
#
# ⚠️ 뉴런 한도는 00:00 UTC = KST 09:00에 초기화된다.
set -u

ROOT=/Users/seojeonghwa/project/CardNews
LOG="$ROOT/out/ikea-vlog.log"
DATE=20260831

say() { echo "[ikea] $(date '+%F %T') $*" >> "$LOG"; }

# 아직 안 만든 편을 만든다. 시각이 아니라 「무엇이 남았는가」로 정한다.
# ⚠️ 예전엔 시각으로만 갈랐다. 그런데 8/31 저녁에 뉴런이 0장이라 저녁 편이 못 돌았고,
#    다음날 아침에 깨어나도 「낮 편은 이미 있음」만 보고 그대로 끝나 버렸다.
#    남은 편을 찾아 만들게 바꾼다.
if [ ! -f "$ROOT/out/vlog-$DATE-day/post.json" ]; then
  SLOT=day
  THEME='가구 보러 간 날'
elif [ ! -f "$ROOT/out/vlog-$DATE-evening/post.json" ]; then
  SLOT=evening
  THEME='종아리 풀러 간 날'
else
  say "2편 다 있음 → launchd 잡 해제 후 종료"
  launchctl bootout "gui/$(id -u)/com.cardnews.ikeavlog" 2>/dev/null
  exit 0
fi

# 뉴런이 모자라면 아예 시작하지 않는다. 글값(claude 호출)만 버리고 끝나는 걸 막는다.
AFFORD=$(cd "$ROOT" && /opt/homebrew/bin/node -e "
import('./src/persona/budget.js').then(async b=>{
  const {cloudflare}=await import('./src/config.js');
  const n=cloudflare.accounts.length||1;
  console.log(b.planPhotos(cloudflare.imageModel,5,{accountCount:n,refs:1}).affordable);
});" 2>/dev/null | tail -1)
if [ "${AFFORD:-0}" -lt 3 ]; then
  say "$SLOT 보류 — 뉴런 부족(가능 ${AFFORD:-0}장). KST 09시 리셋 후 재시도."
  exit 0
fi

# 이미지 생성이 돌고 있으면 비켜준다 — 같이 돌리면 스왑이 걸린다(실측).
if pgrep -f "mflux-generate" > /dev/null; then
  say "로컬 생성 중 → 이번 회차 건너뜀"
  exit 0
fi

say "$SLOT 시작 · 소재=$THEME"
cd "$ROOT" || exit 1
VLOG_DATE="$DATE" VLOG_SLOT="$SLOT" VLOG_THEME="$THEME" \
  /opt/homebrew/bin/node src/jobs/vlog-cycle.js >> "$LOG" 2>&1
say "$SLOT 종료 rc=$?"

# 둘 다 만들었으면 이 일회성 잡을 내린다.
if [ -f "$ROOT/out/vlog-$DATE-day/post.json" ] && [ -f "$ROOT/out/vlog-$DATE-evening/post.json" ]; then
  say "2편 완료 → launchd 잡 해제"
  launchctl bootout "gui/$(id -u)/com.cardnews.ikeavlog" 2>/dev/null
fi
