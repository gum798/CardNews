#!/bin/bash
# H3 타임: 저녁 18시 ~ 다음날 09시에만 도는 인트로 클립 사전 생성기.
#
# 왜 밤에만 도는가:
#   MLX 포팅판은 M3 Ultra에서 스텝당 약 8.8분이다(공식 README). M5는 더 느리다.
#   낮에 돌리면 맥이 점유돼 이미지 생성(장당 3~14분)과 발행이 같이 멈춘다.
#   그래서 사람이 안 쓰는 시간대에만 미리 만들어 둔다.
#
# ⚠️ 라이선스: MiniMax H3는 지역 제한 모델이고, 2026-08-28에 개인(sole operator)
#    자격으로 자체 배포 인가를 받았다(승인 메일 보관). 인가 조건은 라이선스·AUP 준수,
#    안전장치 유지, 재배포 시 조건 전달, 요청 내용 비밀유지다.
#    ⚠️ 남에게 서비스로 제공하려면 그 사용자에게도 같은 제한을 걸어야 한다.
set -u

ROOT=/Users/seojeonghwa/project/CardNews
H3=~/models/minimax-h3-mlx
MODEL=~/models/MiniMax-H3-MLX-4bit
OUT="$ROOT/out/h3-clips"
LOG="$ROOT/out/h3-night.log"

HOUR=$(date +%-H)
# 18~23시 또는 0~8시에만 실행. 09시 이후에는 즉시 종료해 낮 작업을 방해하지 않는다.
if [ "$HOUR" -lt 18 ] && [ "$HOUR" -ge 9 ]; then
  echo "[h3] $(date '+%F %T') H3 타임 아님(${HOUR}시) → 종료" >> "$LOG"
  exit 0
fi

# 이미지 생성이 돌고 있으면 비켜준다 — 둘을 같이 돌리면 스왑이 걸린다(실측).
if pgrep -f "mflux-generate" > /dev/null; then
  echo "[h3] $(date '+%F %T') 이미지 생성 중 → 이번 회차 건너뜀" >> "$LOG"
  exit 0
fi

mkdir -p "$OUT"
STAMP=$(date +%Y%m%d)
TARGET="$OUT/intro-$STAMP.mp4"
if [ -f "$TARGET" ]; then
  echo "[h3] $(date '+%F %T') 오늘 클립 이미 있음 → 종료" >> "$LOG"
  exit 0
fi

# 인트로에 쓸 하나 키프레임. 없으면 앵커를 쓴다.
SEED_IMG=$(ls -t "$ROOT"/assets/persona/cache/intro-*.png 2>/dev/null | head -1)
[ -z "$SEED_IMG" ] && SEED_IMG="$ROOT/assets/persona/hana/healing/anchor-news-front.png"
[ -f "$SEED_IMG" ] || { echo "[h3] 시드 이미지 없음 → 종료" >> "$LOG"; exit 1; }

echo "[h3] $(date '+%F %T') 시작 · seed=$(basename "$SEED_IMG")" >> "$LOG"
START=$(date +%s)

cd "$H3" || exit 1
"$H3/.venv/bin/python" scripts/generate.py \
  "A young Korean woman sitting at a desk, speaking to the camera, natural daylight, subtle head movement" \
  --image "$SEED_IMG" --anchor first \
  --checkpoint "$MODEL" \
  --duration 5 --steps 4 \
  -o "$TARGET" >> "$LOG" 2>&1

RC=$?
ELAPSED=$(( $(date +%s) - START ))
if [ $RC -eq 0 ] && [ -f "$TARGET" ]; then
  echo "[h3] $(date '+%F %T') 완료 ${ELAPSED}초 → $TARGET" >> "$LOG"
else
  echo "[h3] $(date '+%F %T') 실패 rc=$RC ${ELAPSED}초" >> "$LOG"
fi
