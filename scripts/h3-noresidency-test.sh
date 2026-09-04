#!/bin/bash
# ① 버퍼 고정(MTLResidencySet)을 끄면 wired 한도를 넘을 수 있는가?
#
# 근거: 이 맥의 recommendedMaxWorkingSetSize는 17.76 GiB인데, sd.cpp가 모든 가중치를
#       MTLResidencySet에 고정해 축출 불가로 만든다. Q2_K 조합 17.04 GiB가 여기 걸려
#       로드는 되고 2스텝에서 죽었다(실측 5회).
#       GGML_METAL_NO_RESIDENCY=1이면 고정하지 않으므로 macOS가 페이징할 수 있다.
#
# ⚠️ 이게 성공하면 h3.c용 134GB 다운로드가 통째로 불필요해진다. 그래서 제일 먼저 한다.
set -u
ROOT=/Users/seojeonghwa/project/CardNews
M=$HOME/models/h3-gguf
LOG=$M/noresidency.log

source "$ROOT/scripts/_worktime.sh"
worktime_guard "$LOG" || exit 0
localgen_busy && { echo "[nores] 다른 로컬 생성 중 → 종료" >> "$LOG"; exit 0; }

echo "[nores] $(date '+%F %T') 시작 (GGML_METAL_NO_RESIDENCY=1)" >> "$LOG"
S0=$(date +%s)
GGML_METAL_NO_RESIDENCY=1 \
DIFF_MODEL=$M/minimax_h3_fl2va_pruned-Q2_K.gguf \
W=512 H=512 FR=17 ST=4 MIN_FREE_PCT=50 \
  bash "$M/run.sh" >> "$LOG" 2>&1
RC=$?
ELAPSED=$(( $(date +%s)-S0 ))

if [ -f "$M/first-clip.mp4" ]; then
  MSG="✅ ① NO_RESIDENCY 성공 (${ELAPSED}초) — wired 한도가 벽이 아니었다. 134GB 다운로드 불필요."
else
  MSG="❌ ① NO_RESIDENCY 실패 rc=$RC (${ELAPSED}초) → ② h3.c(134GB) 경로로 간다"$'\n'"$(tail -4 "$LOG" | tr -d '\r')"
fi
echo "[nores] $(date '+%F %T') $MSG" >> "$LOG"

cd "$ROOT" && MSG="$MSG" /opt/homebrew/bin/node -e "
import('grammy').then(async ({ Bot, InputFile }) => {
  const fs = await import('node:fs');
  const { telegram } = await import('./src/config.js');
  const bot = new Bot(telegram.botToken);
  const clip = process.env.HOME + '/models/h3-gguf/first-clip.mp4';
  if (fs.existsSync(clip)) await bot.api.sendVideo(telegram.chatId, new InputFile(clip), { caption: process.env.MSG.slice(0,1000) });
  else await bot.api.sendMessage(telegram.chatId, process.env.MSG.slice(0, 3500));
});" >> "$LOG" 2>&1
