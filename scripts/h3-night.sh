#!/bin/bash
# H3 타임: 인트로 클립 사전 생성기. launchd가 2시간마다 깨우고, 평일 업무 시간
# (09~18시)에는 _worktime.sh 가드가 즉시 끝낸다 — 낮에 돌리면 맥이 점유돼
# 이미지 생성(장당 3~14분)과 발행이 같이 멈추기 때문이다.
#
# 실행 경로는 stable-diffusion.cpp(Metal) + GGUF ($HOME/models/h3-gguf/run.sh).
# MLX 포팅판은 폐기했다(아래 참고). 하루에 한 클립만 만든다(out/h3-clips/intro-날짜.mp4).
#
# ⚠️ 라이선스: MiniMax H3는 지역 제한 모델이고, 2026-08-28에 개인(sole operator)
#    자격으로 자체 배포 인가를 받았다(승인 메일 보관). 인가 조건은 라이선스·AUP 준수,
#    안전장치 유지, 재배포 시 조건 전달, 요청 내용 비밀유지다.
#    ⚠️ 남에게 서비스로 제공하려면 그 사용자에게도 같은 제한을 걸어야 한다.
set -u

ROOT=/Users/seojeonghwa/project/CardNews
RUN="$HOME/models/h3-gguf/run.sh"
OUT="$ROOT/out/h3-clips"
LOG="$ROOT/out/h3-night.log"

# 업무 시간(09~18시) 금지 규칙은 _worktime.sh가 한 곳에서 관리한다.
source "$ROOT/scripts/_worktime.sh"
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
# ⚠️ 같은 폴더에 오려내기용 알파 마스크(*.mask.png, 흑백 실루엣)가 사진 직후에 쓰여
#    늘 더 새 파일이다 — 거르지 않으면 실루엣이 첫 프레임으로 들어가 신원이 사라진다.
SEED_IMG=$(ls -t "$ROOT"/assets/persona/cache/intro-*.png 2>/dev/null | grep -v '\.mask\.png$' | head -1)
[ -z "$SEED_IMG" ] && SEED_IMG="$ROOT/assets/persona/hana/healing/anchor-news-front.png"
[ -f "$SEED_IMG" ] || { echo "[h3] 시드 이미지 없음 → 종료" >> "$LOG"; exit 1; }
[ -f "$RUN" ] || { echo "[h3] 실행기 없음: $RUN → 종료" >> "$LOG"; exit 1; }

echo "[h3] $(date '+%F %T') 시작 · seed=$(basename "$SEED_IMG")" >> "$LOG"
START=$(date +%s)

# ⚠️ MLX 포팅판(minimax-h3-mlx)은 폐기했다. 트랜스포머만 담겨 있고 텍스트 인코더로
#    Qwen3-VL-32B를 원본 정밀도(48GB)로 부르기 때문에 24GB에서 불가능하다.
#    2026-09-01까지 이 잡이 이틀간 2시간마다 깨어나 매번 PIL 에러로 죽고 있었다.
#    지금은 stable-diffusion.cpp(Metal) + GGUF 경로를 쓴다.
# ⚠️ 출력은 오늘 날짜 파일(TARGET)로 받는다. 예전엔 run.sh 기본값(first-clip.mp4)에
#    쓰고 그 파일로 성공을 판정해서, 전날 클립이 남아 있으면 안 돌아도 「완료」로
#    보고됐고 위의 「오늘 클립 이미 있음」 검사는 한 번도 맞은 적이 없었다.
# ⚠️ run.sh 종료 코드: 0=생성, 2=의도한 건너뜀(업무 시간·다른 생성 중·메모리 부족·이미 있음),
#    1=파일 없음, 그 외=sd-cli 종료 코드(143=감시견이 죽임). 건너뜀은 밤새 최대 12번
#    반복될 수 있으니 로그만 남기고 텔레그램은 보내지 않는다 — 실패로 보고하면 알림이 무의미해진다.
OUT="$TARGET" SEED_IMG="$SEED_IMG" bash "$RUN"
RC=$?
ELAPSED=$(( $(date +%s) - START ))
if [ -f "$TARGET" ]; then
  echo "[h3] $(date '+%F %T') 완료 ${ELAPSED}초 → $(basename "$TARGET")" >> "$LOG"
  RESULT="✅ H3 클립 생성 (${ELAPSED}초)"
elif [ "$RC" = 2 ]; then
  echo "[h3] $(date '+%F %T') run.sh 건너뜀: $(h3_runlog_tail 1)" >> "$LOG"
  exit 0
else
  echo "[h3] $(date '+%F %T') 클립 없음 rc=$RC ${ELAPSED}초" >> "$LOG"
  # run.log에는 sd-cli 진행 막대(수십만 자)도 쌓인다. 스크립트 진단 줄만 골라야
  # 원인(메모리 부족·감시견 중단 등)이 3500자 안에 들어온다 — h3_runlog_tail(_worktime.sh).
  RESULT="❌ H3 실패 rc=$RC (${ELAPSED}초)"$'\n'"$(h3_runlog_tail 3)"
fi

# ⚠️ 결과를 반드시 사람에게 보낸다. 밤에 돌린 게 성공했는지 실패했는지 아침에
#    사람이 물어봐야 알 수 있으면, 안 돌아도 아무도 모른다 — 실제로 이틀간 그랬다.
# ⚠️ RESULT·CLIP은 node 앞에서 넘긴다. 예전엔 `export RESULT`가 node 호출 *뒤*에
#    있어서 텔레그램에는 늘 폴백 문구('H3 클립'/'H3 결과 없음')만 갔다.
cd "$ROOT" && RESULT="$RESULT" CLIP="$TARGET" /opt/homebrew/bin/node -e "
import('grammy').then(async ({ Bot, InputFile }) => {
  const fs = await import('node:fs');
  const { telegram } = await import('./src/config.js');
  const bot = new Bot(telegram.botToken);
  const clip = process.env.CLIP;
  if (clip && fs.existsSync(clip)) {
    await bot.api.sendVideo(telegram.chatId, new InputFile(clip),
      { caption: process.env.RESULT || 'H3 클립' });
  } else {
    await bot.api.sendMessage(telegram.chatId, (process.env.RESULT || 'H3 결과 없음').slice(0, 3500));
  }
});" >> "$LOG" 2>&1
