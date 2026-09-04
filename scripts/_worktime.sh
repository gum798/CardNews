# 업무 시간 가드. 무거운 로컬 생성 스크립트가 모두 이걸 먼저 부른다.
#
# 사용자가 평일 09~18시에 이 맥으로 일한다. 그 시간에 로컬 모델을 올리면
# (ACE-Step 18.7GB, mflux, H3) 스왑이 걸려 업무용 앱까지 같이 느려진다.
# 실측: 두 모델 동시 실행 때 여유 메모리 6%, Swapouts 5.8억 → PC 사실상 정지.
#
# ⚠️ 약속이 아니라 코드로 막는다. 사람이 기억해서 지키는 규칙은 언젠가 깨진다.
#
# ⚠️ 단, 「평일」에만 막는다. 주말·공휴일·연차에는 업무 시간이 없으므로 종일 허용한다.
#    이걸 안 나누면 토요일 낮 15시간을 통째로 날린다(H3 클립 하나가 1.5~3시간이다).
#
# 사용법:
#   source /Users/seojeonghwa/project/CardNews/scripts/_worktime.sh
#   worktime_guard "로그파일경로" || exit 0
#
# ⚠️ 이 가드는 「로컬 PC에 부하가 걸리는 작업」에만 건다. 막는 이유가 성능이지
#    시간대 자체가 아니기 때문이다(사용자 확인, 2026-09-01).
#      막는다  : ACE-Step / H3(sd-cli) / mflux / SenseNova — 로컬 GPU·메모리를 먹는다
#      안 막는다: Cloudflare·Gemini 이미지 생성, 발행, 텔레그램 — 원격이라 맥은 대기만 한다
#    브이로그·뉴스 발행에 이걸 걸면 낮 일정이 통째로 저녁으로 밀린다. 걸지 마라.

WORK_START=9    # 이 시각부터
WORK_END=18     # 이 시각 전까지 로컬 모델 금지 (평일만)

# 점심시간은 예외 — 자리를 비우므로 돌려도 된다. 분 단위로 본다.
LUNCH_START=1130   # 11:30
LUNCH_END=1300     # 13:00

# 공휴일·연차 목록. 하루 쉬기로 했으면 여기에 날짜만 추가하면 그날은 종일 돈다.
WORKTIME_HOLIDAYS="${WORKTIME_HOLIDAYS:-/Users/seojeonghwa/project/CardNews/scripts/holidays.txt}"

# 오늘이 일 안 하는 날인가?
is_offday() {
  # 수동 해제: FORCE_LOCALGEN=1 로 한 번만 강제로 돌릴 수 있다.
  [ "${FORCE_LOCALGEN:-0}" = "1" ] && return 0

  # 토(6)·일(7)
  [ "$(date +%u)" -ge 6 ] && return 0

  # 공휴일 / 연차 — "YYYY-MM-DD" 로 시작하는 줄이 있으면 쉬는 날.
  local today
  today=$(date +%F)
  [ -f "$WORKTIME_HOLIDAYS" ] && grep -q "^${today}\b" "$WORKTIME_HOLIDAYS" && return 0

  return 1
}

worktime_guard() {
  local log="${1:-/dev/null}"
  local hour
  hour=$(date +%-H)

  if is_offday; then
    echo "[guard] $(date '+%F %T') 쉬는 날 → 종일 허용" >> "$log"
    return 0
  fi

  if [ "$hour" -ge "$WORK_START" ] && [ "$hour" -lt "$WORK_END" ]; then
    # 점심시간(11:30~13:00)에는 자리를 비우므로 허용한다.
    local hhmm
    hhmm=$(date +%H%M)
    hhmm=$((10#$hhmm))
    if [ "$hhmm" -ge "$LUNCH_START" ] && [ "$hhmm" -lt "$LUNCH_END" ]; then
      echo "[guard] $(date '+%F %T') 점심시간 → 허용" >> "$log"
      return 0
    fi
    echo "[guard] $(date '+%F %T') 평일 업무 시간(${hour}시) — 로컬 모델 금지 → 종료" >> "$log"
    return 1
  fi
  return 0
}

# 다른 로컬 생성이 이미 돌고 있으면 비켜준다. 두 개를 같이 올리면 스왑이다.
# ⚠️ 패턴은 「실행 중인 모델」만 잡아야 한다. 예전엔 sd-cli를 맨이름으로 찾았는데,
#    stable-diffusion.cpp를 빌드할 때 링커 명령줄에 sd-cli가 들어가 빌드를 「모델 실행」으로
#    오인했다. 그 바람에 18:10 음악 회차가 통째로 건너뛰어졌다(2026-08-31 실측).
#    실행 파일 경로(bin/sd-cli)로 좁힌다.
localgen_busy() {
  pgrep -f "mflux-generate|ace_kind\.py|ace4\.py|sense_gen\.py|bin/sd-cli|scripts/generate\.py" > /dev/null
}

# run.sh(sd-cli) 로그에서 스크립트 진단 줄만 마지막 N줄 뽑는다.
# ⚠️ sd-cli 진행 막대는 \r로만 이어지고 줄바꿈이 없어서, 그 위에 [h3] 진단이 줄 한가운데
#    붙는다(실측: 36줄 중 4줄 — 하필 폭주 감지·종료 rc=143 같은 원인 줄). `grep '^\[h3\]'`로는
#    그 줄들이 빠지고 이전 회차 줄이 대신 올라온다. → \r을 줄바꿈으로 바꾸고 [h3]/[guard]
#    앞을 잘라낸 뒤 고른다. 자르기는 바이트 단위(cut -b): ANSI 시퀀스 섞인 줄에 cut -c를
#    쓰면 macOS에서 「Illegal byte sequence」로 죽는다.
h3_runlog_tail() {
  local n="${1:-3}" f="${2:-$HOME/models/h3-gguf/run.log}"
  [ -f "$f" ] || return 0
  LC_ALL=C tr '\r' '\n' < "$f" | LC_ALL=C sed -E -n 's/.*(\[(h3|guard)\] )/\1/p' | tail -n "$n" | cut -b1-300
}
