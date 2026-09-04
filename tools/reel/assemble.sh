#!/bin/bash
# assemble.sh — join pre-rendered shots with a MIX of transitions.
# Every join becomes its own short clip built from real frames of A and B, so the
# final timeline is a plain concat: A' | trans | B' | trans | C' ...
# EDIT is the join list, one per gap: whip:DUR:DIR | diss:DUR | cut
set -euo pipefail
# ⚠️ launchd(텔레그램 봇)에서 호출되면 PATH가 /usr/bin:/bin 뿐이다. 그러면 ffprobe를
#    못 찾고, python3는 Apple 시스템 파이썬으로 잡혀 이 맥에서 MTE 크래시가 난다(CLAUDE.md).
#    실측 2026-09-03: 터미널에선 되는데 봇에서 누르면 "body.mp4: No such file"로 실패.
export PATH=/opt/homebrew/bin:/opt/homebrew/share/google-cloud-sdk/bin:/usr/local/bin:$PATH
FF=/opt/homebrew/bin/ffmpeg; FP=/opt/homebrew/bin/ffprobe
OUT=$1; shift
EDIT=$1; shift
SHOTS=("$@")
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
IFS=',' read -ra JOINS <<< "$EDIT"
PARTS=()
dur(){ $FP -v error -show_entries format=duration -of csv=p=0 "$1"; }

for i in "${!SHOTS[@]}"; do
  A="${SHOTS[$i]}"; AD=$(dur "$A")
  HEAD=0; TAIL=0
  [ $i -gt 0 ] && { j="${JOINS[$((i-1))]}"; case "$j" in whip:*|diss:*) HEAD=$(echo "$j"|cut -d: -f2);; esac; }
  [ $i -lt $(( ${#SHOTS[@]} - 1 )) ] && { j="${JOINS[$i]}"; case "$j" in whip:*|diss:*) TAIL=$(echo "$j"|cut -d: -f2);; esac; }
  KEEP=$(python3 -c "print(round($AD-$HEAD-$TAIL,3))")
  $FF -v error -ss "$HEAD" -t "$KEEP" -i "$A" -c copy -y "$T/p$i.mp4" 2>/dev/null \
    || $FF -v error -ss "$HEAD" -t "$KEEP" -i "$A" -c:v libx264 -crf 19 -y "$T/p$i.mp4"
  PARTS+=("$T/p$i.mp4")
  # transition clip after shot i
  if [ $i -lt $(( ${#SHOTS[@]} - 1 )) ]; then
    j="${JOINS[$i]}"; B="${SHOTS[$((i+1))]}"
    case "$j" in
      whip:*) D=$(echo "$j"|cut -d: -f2); DIR=$(echo "$j"|cut -d: -f3)
              "$(dirname "$0")/whip.sh" "$A" "$B" "$T/t$i.mp4" "$D" "${DIR:-l}"
              PARTS+=("$T/t$i.mp4") ;;
      diss:*) D=$(echo "$j"|cut -d: -f2)
              # real moving frames on both sides: A's tail xfaded with B's head
              $FF -v error -sseof "-$D" -i "$A" -t "$D" -i "$B" -filter_complex \
                "[0:v]fps=30,setpts=PTS-STARTPTS,setsar=1[a];[1:v]fps=30,setpts=PTS-STARTPTS,setsar=1[b];\
                 [a][b]xfade=transition=fade:duration=${D}:offset=0,format=yuv420p[v]" \
                -map "[v]" -r 30 -t "$D" -c:v libx264 -crf 19 -y "$T/t$i.mp4"
              PARTS+=("$T/t$i.mp4") ;;
      cut) : ;;
    esac
  fi
done
: > "$T/list.txt"; for p in "${PARTS[@]}"; do echo "file '$p'" >> "$T/list.txt"; done
$FF -v error -f concat -safe 0 -i "$T/list.txt" -c:v libx264 -crf 19 -preset medium \
  -pix_fmt yuv420p -movflags +faststart -r 30 -y "$OUT"
