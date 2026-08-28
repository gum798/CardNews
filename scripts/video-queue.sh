#!/bin/bash
# 영상 검증 큐 — 소재 4종을 H3로 만들어 본다.
#
# 실행 조건: bench-queue.sh의 H3 테스트가 끝난 뒤. 결과가 쓸 만하면 이 큐가 이어받는다.
#
# ⚠️ 반드시 순차. 24GB에서 두 모델을 같이 올리면 스왑으로 PC가 멈춘다(오늘 2회 실측).
# ⚠️ H3는 영상+오디오 모델이라 단독 이미지 출력이 없다. 「이미지 품질」은 클립의
#    첫 프레임으로 판단한다.
# ⚠️ i2v(--image)로 기존 하나 사진을 첫 프레임에 넣으면 신원이 유지된다.
#    t2v(프롬프트만)는 하나가 아닌 사람이 나온다 — 소재 검증용으로만 쓴다.
set -u
ROOT=/Users/seojeonghwa/project/CardNews
H3=~/models/minimax-h3-mlx
MODEL=~/models/MiniMax-H3-MLX-4bit
OUT=~/models/bench/video
LOG=~/models/bench/video-queue.log
mkdir -p "$OUT"

say() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
busy() { pgrep -f "mflux-generate|ace4.py|ace_kind|generate.py" > /dev/null; }
waitfree() { while busy; do sleep 30; done; }

[ -d "$MODEL" ] || { say "H3 모델 없음 → 종료"; exit 1; }

# 신원이 살아 있는 시드. i2v로 첫 프레임에 넣는다.
SEED="$ROOT/out/vlog-20260827-evening/photo-3.png"   # faceDist 0.44

# 소재: 이름|프롬프트|시드사용여부
run() {
  local name="$1" prompt="$2" use_seed="$3"
  local tgt="$OUT/$name.mp4"
  [ -f "$tgt" ] && { say "$name 이미 있음 → 건너뜀"; return; }
  waitfree
  say "$name 시작 (seed=$use_seed)"
  local s0=$(date +%s)
  cd "$H3" || return
  if [ "$use_seed" = "yes" ] && [ -f "$SEED" ]; then
    ./.venv/bin/python scripts/generate.py "$prompt" \
      --image "$SEED" --anchor first \
      --checkpoint "$MODEL" --duration 5 --steps 4 \
      -o "$tgt" >> "$OUT/$name.log" 2>&1
  else
    ./.venv/bin/python scripts/generate.py "$prompt" \
      --checkpoint "$MODEL" --duration 5 --steps 4 \
      -o "$tgt" >> "$OUT/$name.log" 2>&1
  fi
  say "$name 종료 rc=$? $(( $(date +%s)-s0 ))초"
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
