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

# 업무 시간(09~18시) 금지 규칙은 _worktime.sh가 한 곳에서 관리한다.
source /Users/seojeonghwa/project/CardNews/scripts/_worktime.sh
worktime_guard "$LOG" || exit 0

# 다른 로컬 생성이 돌고 있으면 비켜준다 — 둘을 같이 올리면 스왑이 걸린다(실측).
if localgen_busy; then
  echo "[h3] $(date '+%F %T') 다른 로컬 생성 중 → 이번 회차 건너뜀" >> "$LOG"
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

# ⚠️ MLX 포팅판(minimax-h3-mlx)은 폐기했다. 트랜스포머만 담겨 있고 텍스트 인코더로
#    Qwen3-VL-32B를 원본 정밀도(48GB)로 부르기 때문에 24GB에서 불가능하다.
#    2026-09-01까지 이 잡이 이틀간 2시간마다 깨어나 매번 PIL 에러로 죽고 있었다.
#    지금은 stable-diffusion.cpp(Metal) + GGUF 경로를 쓴다.
bash "$HOME/models/h3-gguf/run.sh"
RC=$?
ELAPSED=$(( $(date +%s) - START ))
if [ -f "$HOME/models/h3-gguf/first-clip.mp4" ]; then
  echo "[h3] $(date '+%F %T') 완료 ${ELAPSED}초" >> "$LOG"
  RESULT="✅ H3 클립 생성 (${ELAPSED}초)"
else
  echo "[h3] $(date '+%F %T') 클립 없음 rc=$RC ${ELAPSED}초" >> "$LOG"
  RESULT="❌ H3 실패 rc=$RC (${ELAPSED}초)"$'\n'"$(tail -3 "$LOG" | tr -d '\r')"
fi

# ⚠️ 결과를 반드시 사람에게 보낸다. 밤에 돌린 게 성공했는지 실패했는지 아침에
#    사람이 물어봐야 알 수 있으면, 안 돌아도 아무도 모른다 — 실제로 이틀간 그랬다.
cd "$ROOT" && /opt/homebrew/bin/node -e "
import('grammy').then(async ({ Bot, InputFile }) => {
  const fs = await import('node:fs');
  const { telegram } = await import('./src/config.js');
  const bot = new Bot(telegram.botToken);
  const clip = process.env.HOME + '/models/h3-gguf/first-clip.mp4';
  if (fs.existsSync(clip)) {
    await bot.api.sendVideo(telegram.chatId, new InputFile(clip),
      { caption: process.env.RESULT || 'H3 클립' });
  } else {
    await bot.api.sendMessage(telegram.chatId, (process.env.RESULT || 'H3 결과 없음').slice(0, 3500));
  }
});" >> "$LOG" 2>&1
export RESULT
