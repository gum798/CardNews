#!/bin/bash
# 로컬 모델 검증 큐 — 반드시 하나씩 순차 실행한다.
#
# ⚠️ 동시에 돌리면 안 된다. 24GB 기기에서 두 모델을 같이 올리면 스왑이 걸려
#    PC가 사실상 멈춘다(실측: 여유 메모리 6%, Swapouts 5.8억). 오늘 두 번 겪었다.
#
# ⚠️ 무거운 생성을 돌리기 전에 저장 경로부터 검증한다. ACE-Step에서 2시간짜리 생성을
#    두 번 날렸다 — 한 번은 출력 파일에 확장자가 없어서(soundfile이 포맷을 못 정함).
set -u
# ⚠️ 예전엔 이 경로가 세션 스크래치패드(/private/tmp/...)였다. macOS가 /private/tmp를
#    주기적으로 청소하면서 venv 안의 __init__.py들을 지워버려 torch가 통째로 사라졌다
#    (8/31 실측: "No module named torch", 디렉터리는 남고 파일만 없어짐).
#    무거운 venv는 반드시 홈 아래 영구 경로에 둔다.
LOCALGEN=$HOME/models/localgen
OUT=~/models/bench
LOG="$OUT/queue.log"
mkdir -p "$OUT"

say() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
waitfree() { while localgen_busy; do sleep 30; done; }

source "$HOME/project/CardNews/scripts/_worktime.sh"
worktime_guard "$LOG" || exit 0

say "=== 큐 시작 ==="

# ── 1. SenseNova 이미지 ────────────────────────────────────────
if [ -d ~/models/SenseNova-U1.5-4bit ] && [ ! -f "$OUT/sense.png" ]; then
  waitfree
  say "1/4 SenseNova 이미지 생성 시작"
  S0=$(date +%s)
  "$LOCALGEN/.venv/bin/python" "$LOCALGEN/sense_gen.py" \
    > "$OUT/sense.log" 2>&1
  say "1/4 SenseNova 종료 rc=$? $(( $(date +%s)-S0 ))초"
fi

# ⚠️ H3는 MLX 포팅판이 아니라 stable-diffusion.cpp + GGUF(run.sh)로 돌린다.
#    MLX판은 텍스트 인코더를 48GB로 불러 24GB에서 불가능하다(h3-night.sh 참고).
#    run.sh는 i2v 전용이라 시드 사진(run.sh 기본값)을 첫 프레임으로 쓴다.
#    해상도·프레임·스텝은 run.sh 기본값(384x384 · 9프레임 · 1스텝) — 완주가 확인된 조합.
H3RUN=$HOME/models/h3-gguf/run.sh

# ── 2. H3 이미지(첫 프레임으로 판단) ─────────────────────────────
if [ -f "$H3RUN" ] && [ ! -f "$OUT/h3-still.mp4" ]; then
  waitfree
  say "2/4 H3 최소 길이 클립 시작 (이미지 대용)"
  S0=$(date +%s)
  PROMPT="A young Korean woman sitting at a desk in a small room, natural daylight, looking at the camera" \
    OUT="$OUT/h3-still.mp4" bash "$H3RUN" > "$OUT/h3-still.log" 2>&1
  RC=$?
  # rc=2 = run.sh가 일부러 건너뜀(업무 시간 진입·다른 생성 중·메모리 부족) → 뒤 항목도 같은
  # 처지이므로 큐를 멈춘다. 다시 돌리면 있는 파일은 건너뛰고 이어진다.
  [ "$RC" = 2 ] && { say "2/4 H3 건너뜀 → 큐 중단 ($(h3_runlog_tail 1))"; exit 0; }
  say "2/4 H3 이미지 종료 rc=$RC $(( $(date +%s)-S0 ))초 $([ -f "$OUT/h3-still.mp4" ] && echo 생성 || echo "실패: $(h3_runlog_tail 1)")"
fi

# ── 3. H3 동영상 ───────────────────────────────────────────────
if [ -f "$H3RUN" ] && [ ! -f "$OUT/h3-video.mp4" ]; then
  waitfree
  say "3/4 H3 동영상 시작"
  S0=$(date +%s)
  PROMPT="A young Korean woman at a desk speaking to the camera, subtle head movement, natural daylight" \
    OUT="$OUT/h3-video.mp4" bash "$H3RUN" > "$OUT/h3-video.log" 2>&1
  RC=$?
  # rc=2 = run.sh가 일부러 건너뜀(업무 시간 진입·다른 생성 중·메모리 부족) → 뒤 항목도 같은
  # 처지이므로 큐를 멈춘다. 다시 돌리면 있는 파일은 건너뛰고 이어진다.
  [ "$RC" = 2 ] && { say "3/4 H3 건너뜀 → 큐 중단 ($(h3_runlog_tail 1))"; exit 0; }
  say "3/4 H3 동영상 종료 rc=$RC $(( $(date +%s)-S0 ))초 $([ -f "$OUT/h3-video.mp4" ] && echo 생성 || echo "실패: $(h3_runlog_tail 1)")"
fi

# ── 4. 음악 2곡 (뉴스용 / 브이로그용) ──────────────────────────
for KIND in news vlog; do
  TGT="$OUT/bgm-$KIND.wav"   # ⚠️ 확장자 필수 — 없으면 soundfile이 포맷을 못 정한다
  [ -f "$TGT" ] && continue
  waitfree
  say "4/4 음악($KIND) 시작"
  S0=$(date +%s)
  KIND="$KIND" OUT="$TGT" "$LOCALGEN/.venv/bin/python" \
    "$LOCALGEN/ace_kind.py" > "$OUT/bgm-$KIND.log" 2>&1
  say "4/4 음악($KIND) 종료 rc=$? $(( $(date +%s)-S0 ))초"
done

say "=== 큐 완료 ==="
