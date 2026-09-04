#!/bin/bash
# whip.sh — motion-blurred whip pan between two clips.
# Grabs A's last frame and B's first frame, slides between them at 240fps and
# tmix-es down to 30 — that IS a 180-degree shutter, so the blur is real
# integration of the movement, not a gblur pretending to be one.
# usage: whip.sh <A.mp4> <B.mp4> <out.mp4> [dur] [dir: l|r|u|d]
set -euo pipefail
# ⚠️ launchd(텔레그램 봇)에서 호출되면 PATH가 /usr/bin:/bin 뿐이다. 그러면 ffprobe를
#    못 찾고, python3는 Apple 시스템 파이썬으로 잡혀 이 맥에서 MTE 크래시가 난다(CLAUDE.md).
#    실측 2026-09-03: 터미널에선 되는데 봇에서 누르면 "body.mp4: No such file"로 실패.
export PATH=/opt/homebrew/bin:/opt/homebrew/share/google-cloud-sdk/bin:/usr/local/bin:$PATH
FF=/opt/homebrew/bin/ffmpeg; FP=/opt/homebrew/bin/ffprobe
A=$1; B=$2; OUT=$3; WD=${4:-0.30}; DIR=${5:-l}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
AD=$($FP -v error -show_entries format=duration -of csv=p=0 "$A")
$FF -v error -sseof -0.05 -i "$A" -frames:v 1 -y "$T/a.png"
$FF -v error -i "$B" -frames:v 1 -y "$T/b.png"
E="(6*pow(min(t/$WD,1),5)-15*pow(min(t/$WD,1),4)+10*pow(min(t/$WD,1),3))"
case "$DIR" in
  l) STACK="hstack=inputs=2"; CROP="crop=1080:1920:x='${E}*1080':y=0" ;;
  r) STACK="hstack=inputs=2"; CROP="crop=1080:1920:x='1080-${E}*1080':y=0"; SWAP=1 ;;
  u) STACK="vstack=inputs=2"; CROP="crop=1080:1920:x=0:y='${E}*1920'" ;;
  d) STACK="vstack=inputs=2"; CROP="crop=1080:1920:x=0:y='1920-${E}*1920'"; SWAP=1 ;;
esac
if [ "${SWAP:-0}" = 1 ]; then IN1="$T/b.png"; IN2="$T/a.png"; else IN1="$T/a.png"; IN2="$T/b.png"; fi
$FF -v error -loop 1 -t "$WD" -i "$IN1" -loop 1 -t "$WD" -i "$IN2" -filter_complex \
 "[0:v]fps=240,setsar=1[x];[1:v]fps=240,setsar=1[y];[x][y]${STACK}[s];\
  [s]${CROP},tmix=frames=8,fps=30,noise=c0s=3:c0f=t+u,format=yuv420p[v]" \
 -map "[v]" -r 30 -c:v libx264 -crf 19 -y "$OUT"
