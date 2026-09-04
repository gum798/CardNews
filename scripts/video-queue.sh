#!/bin/bash
# 영상 검증 큐 — 소재 4종을 H3로 만들어 본다.
#
# 실행 경로는 h3-night.sh와 같은 stable-diffusion.cpp + GGUF($HOME/models/h3-gguf/run.sh).
# MLX 포팅판은 24GB에서 불가능해 폐기했다(h3-night.sh 참고) — 예전 이 큐는 그 경로를
# 그대로 실행해 매번 죽었다.
#
# ⚠️ 반드시 순차. 24GB에서 두 모델을 같이 올리면 스왑으로 PC가 멈춘다(오늘 2회 실측).
# ⚠️ H3는 영상+오디오 모델이라 단독 이미지 출력이 없다. 「이미지 품질」은 클립의
#    첫 프레임으로 판단한다.
# ⚠️ run.sh는 i2v 전용이다 — 기존 하나 사진을 첫 프레임에 넣어 신원을 유지한다.
#    t2v(프롬프트만)는 하나가 아닌 사람이 나오므로 여기서는 쓰지 않는다.
set -u
ROOT=/Users/seojeonghwa/project/CardNews
RUN="$HOME/models/h3-gguf/run.sh"
OUT=~/models/bench/video
LOG=~/models/bench/video-queue.log
mkdir -p "$OUT"

say() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
source "$ROOT/scripts/_worktime.sh"
# ⚠️ 가드는 다른 어떤 검사보다 앞이다 — 뒤에 두면 그 검사가 먼저 exit 1로 죽여
#    평일 낮에 「건너뜀」이 아니라 「실패」로 남는다.
worktime_guard "$LOG" || exit 0
waitfree() { while localgen_busy; do sleep 30; done; }

[ -f "$RUN" ] || { say "H3 실행기 없음: $RUN → 종료"; exit 1; }

# 신원이 살아 있는 시드. i2v로 첫 프레임에 넣는다.
SEED="$ROOT/out/vlog-20260827-evening/photo-3.png"   # faceDist 0.44

[ -f "$SEED" ] || { say "시드 사진 없음: $SEED → 종료"; exit 1; }

# 소재: 이름|프롬프트|시드사용여부(run.sh가 i2v 전용이라 yes만 받는다)
# 해상도·프레임·스텝은 run.sh 기본값(384x384 · 9프레임 · 1스텝 — 24GB에서 완주가
# 확인된 조합). 바꾸려면 W/H/FRAMES/STEPS 환경변수로 넘긴다.
run() {
  local name="$1" prompt="$2" use_seed="$3"
  local tgt="$OUT/$name.mp4"
  [ -f "$tgt" ] && { say "$name 이미 있음 → 건너뜀"; return; }
  [ "$use_seed" = "yes" ] || { say "$name: run.sh는 i2v 전용 → 건너뜀"; return; }
  waitfree
  say "$name 시작 (seed=$(basename "$SEED"))"
  local s0=$(date +%s)
  PROMPT="$prompt" SEED_IMG="$SEED" OUT="$tgt" bash "$RUN" >> "$OUT/$name.log" 2>&1
  local rc=$?
  if [ -f "$tgt" ]; then
    say "$name 종료 rc=$rc $(( $(date +%s)-s0 ))초 → $tgt"
  elif [ "$rc" = 2 ]; then
    # run.sh가 일부러 건너뛴 것(업무 시간 진입·다른 생성 중·메모리 부족). 남은 소재도 같은
    # 이유로 즉시 2가 나오므로 여기서 큐를 멈춘다 — 있는 파일은 건너뛰니 나중에 다시 돌리면 이어진다.
    say "$name 건너뜀 → 큐 중단 ($(h3_runlog_tail 1))"
    exit 0
  else
    say "$name 실패 rc=$rc $(( $(date +%s)-s0 ))초 ($(h3_runlog_tail 1))"
  fi
}

say "=== 영상 큐 시작 ==="

# 1) 바닷가 — 파도·바람에 날리는 머리처럼 움직임이 분명한 소재
run "beach" \
  "A young Korean woman standing on a sandy beach at the East Sea, wind moving her hair and t-shirt, \
small waves breaking behind her, overcast soft daylight, she looks toward the sea then back to the camera, \
handheld iPhone footage, realistic" yes

# 2) 카페 — 실내 자연광, 미세한 움직임
run "cafe" \
  "A young Korean woman sitting at a wooden table in a small neighbourhood cafe, afternoon daylight from \
a window beside her, she lifts an iced americano and takes a sip, other customers blurred behind her, \
handheld iPhone footage, realistic" yes

# 3) 바람부는 언덕 — 옷과 풀이 함께 흔들리는 큰 움직임
run "hill" \
  "A young Korean woman standing on a grassy hilltop, strong wind blowing her hair and clothes, \
tall grass bending around her, wide open sky with moving clouds, late afternoon light, \
she holds her hair back with one hand, handheld iPhone footage, realistic" yes

# 4) 서울 맛집 탐방 — 사람·간판이 많은 복잡한 장면
run "food" \
  "A young Korean woman at a small Korean restaurant in Seoul, steam rising from a hot dish in front of her, \
she picks up chopsticks and smiles at the camera, warm indoor lighting, other diners blurred behind her, \
handheld iPhone footage, realistic" yes

say "=== 영상 큐 완료 ==="
