#!/bin/bash
# 「친구랑 용산 아이맥스에서 「오디세이」」(2026-09-04 저녁) 다시 뽑기 — 일회성.
#
# 왜: 첫 생성(09-04 09:50)이 옷 풀의 「목에 땀 식히는 손수건」을 뽑아 다섯 장 전부
#     목에 흰 목욕 수건을 두른 채 영화관·카페에 들어갔다. 문구는 지웠고(hana.js), 사진만
#     다시 뽑으면 된다. 섭외 사진(out/scout/20260904)은 캐시라 배경은 그대로 나온다.
#     사용자 결정(09-04): "내일 아침에 다시 뽑아줘".
#
# 언제: 뉴런이 KST 09:00에 초기화되므로 그 직후. 부족하면 다음 회차가 다시 시도한다.
# 끝: 새 post.json의 옷에 「손수건」이 없으면 끝난 것 — launchd 잡을 스스로 내린다.
# ⚠️ 원격 API(CF)만 쓰므로 업무 시간 가드는 걸지 않는다(_worktime.sh 주석 참고).
set -u

ROOT=/Users/seojeonghwa/project/CardNews
LOG="$ROOT/out/vlog-redo.log"
ID=vlog-20260904-evening
SCHEDULE=out/schedule/20260904.json
LABEL=com.cardnews.vlogredo

say() { echo "[redo] $(date '+%F %T') $*" >> "$LOG"; }
bye() { say "$1 → launchd 잡 해제"; launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; exit 0; }

cd "$ROOT" || exit 1
# 사용자 결정: 「내일(09-05) 아침」. 오늘 남은 회차(10:10·11:10)는 두 계정 다 429라 돌아봤자
# 실패 알림만 또 간다(실측 10:03) — 날짜가 되기 전엔 아무것도 하지 않는다.
if [ "$(date +%Y%m%d)" -lt 20260905 ]; then
  say "아직 09-05 전 — 대기"
  exit 0
fi
# 아직 수건 차림인가? 아니면 이미 다시 뽑은 것이다.
OUTFIT=$(/opt/homebrew/bin/node -e "try{console.log('O>'+require('./out/$ID/post.json').outfit)}catch(e){console.log('O>')}" 2>/dev/null | grep -oE '^O>.*' | cut -c3-)
case "$OUTFIT" in
  *손수건*) ;;
  *) bye "이미 다시 뽑음(옷: ${OUTFIT:-없음})" ;;
esac

# 뉴런이 모자라면 시작하지 않는다 — 글값(claude 호출)만 버리는 걸 막는다.
# ⚠️ 장부만 믿지 않는다 — 09-04 실측: 장부는 12,794 남았다는데 두 계정 다 429였다.
#    계정마다 40뉴런짜리 탐침(probeCloudflare)으로 살아 있는지 확인한 뒤 계획한다.
AFFORD=$(/opt/homebrew/bin/node --input-type=module -e "
  const b = await import('./src/persona/budget.js');
  const { probeCloudflare } = await import('./src/persona/image.js');
  const { cloudflare } = await import('./src/config.js');
  const n = cloudflare.accounts.length || 1;
  await probeCloudflare({ log: () => {} });
  console.log('A>' + b.planPhotos(cloudflare.imageModel, 5, { accountCount: n, refs: 2 }).affordable + ' ' + b.summary(n));
" 2>/dev/null | grep -oE '^A>.*' | cut -c3-)
case "${AFFORD%% *}" in
  ''|*[!0-9]*) say "보류 — 예산 확인 실패(${AFFORD:-출력 없음}). 다음 회차에 재시도."; exit 0 ;;
esac
if [ "${AFFORD%% *}" -lt 5 ]; then
  say "보류 — 뉴런 부족(가능 ${AFFORD%% *}장 · ${AFFORD#* }). 다음 회차에 재시도."
  exit 0
fi
say "예산 확인: ${AFFORD#* }"

say "시작"
# VLOG_SCHEDULE을 명시하면 「검토 대기 중」 건너뛰기를 통과해 같은 id를 덮어쓴다(의도된 재생성).
VLOG_DATE=20260904 VLOG_SLOT=evening VLOG_SCHEDULE="$SCHEDULE" \
  /opt/homebrew/bin/node src/jobs/vlog-cycle.js >> "$LOG" 2>&1
RC=$?
say "종료 rc=$RC"

OUTFIT=$(/opt/homebrew/bin/node -e "try{console.log('O>'+require('./out/$ID/post.json').outfit)}catch(e){console.log('O>')}" 2>/dev/null | grep -oE '^O>.*' | cut -c3-)
case "$OUTFIT" in
  *손수건*) say "아직 수건 차림 — 다음 회차에 재시도" ;;
  *) bye "완료(옷: $OUTFIT)" ;;
esac
