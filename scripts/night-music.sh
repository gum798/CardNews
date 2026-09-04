#!/bin/bash
# 뉴스용 BGM 2차 — 1차가 "너무 늘어진다"는 피드백이라 템포를 올리고 비장하게 다시 뽑는다.
#
# ⚠️ 반드시 업무 시간(09~18시) 밖에서만 돈다. ACE-Step은 피크 18.7GB를 먹어서
#    낮에 돌리면 업무용 앱까지 같이 느려진다. 규칙은 _worktime.sh가 관리한다.
#
# ⚠️ 저장 경로에 확장자(.wav)가 없으면 soundfile이 포맷을 못 정해 2시간을 통째로 날린다(실측 2회).
set -u

ROOT=/Users/seojeonghwa/project/CardNews
LOCALGEN=$HOME/models/localgen
OUT=$HOME/models/bench/bgm-news2.wav
LOG=$HOME/models/bench/bgm-news2.log

source "$ROOT/scripts/_worktime.sh"
worktime_guard "$LOG" || exit 0

[ -f "$OUT" ] && { echo "[music] $(date '+%F %T') 이미 있음 → 종료" >> "$LOG"; exit 0; }
localgen_busy && { echo "[music] $(date '+%F %T') 다른 로컬 생성 중 → 건너뜀" >> "$LOG"; exit 0; }

echo "[music] $(date '+%F %T') 시작" >> "$LOG"
S0=$(date +%s)
cd "$LOCALGEN" || exit 1
KIND=news2 SEED=7 OUT="$OUT" \
HF_HUB_DISABLE_XET=1 SSL_CERT_FILE="$LOCALGEN/ca-bundle.pem" \
  ./.venv/bin/python ace_kind.py >> "$LOG" 2>&1
RC=$?
echo "[music] $(date '+%F %T') 종료 rc=$RC $(( $(date +%s)-S0 ))초" >> "$LOG"

# 다 됐으면 텔레그램으로 보내고 이 일회성 잡을 내린다.
if [ $RC -eq 0 ] && [ -f "$OUT" ]; then
  cd "$ROOT" && /opt/homebrew/bin/node -e "
    import('grammy').then(async ({ Bot, InputFile }) => {
      const { telegram } = await import('./src/config.js');
      const bot = new Bot(telegram.botToken);
      await bot.api.sendAudio(telegram.chatId, new InputFile('$OUT'),
        { caption: '뉴스용 BGM 2차 — 128bpm, 저음 오스티나토 + 타이코. 1차(늘어짐)와 비교해보세요.' });
    });
  " >> "$LOG" 2>&1
  launchctl bootout "gui/$(id -u)/com.cardnews.nightmusic" 2>/dev/null
fi
