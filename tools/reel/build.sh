#!/bin/bash
# build.sh <vlog-dir> <out.mp4> — 5 stills -> a ~23s vertical vlog cut.
# The trick that matters most: 5 stills do NOT become 5 shots. Each still yields a
# wide AND a face-anchored punch-in, so the edit cuts every 1.5-3.4s like real footage.
set -euo pipefail
# ⚠️ launchd(텔레그램 봇)에서 호출되면 PATH가 /usr/bin:/bin 뿐이다. 그러면 ffprobe를
#    못 찾고, python3는 Apple 시스템 파이썬으로 잡혀 이 맥에서 MTE 크래시가 난다(CLAUDE.md).
#    실측 2026-09-03: 터미널에선 되는데 봇에서 누르면 "body.mp4: No such file"로 실패.
export PATH=/opt/homebrew/bin:/opt/homebrew/share/google-cloud-sdk/bin:/usr/local/bin:$PATH
D=$1; OUT=$2
HERE=$(cd "$(dirname "$0")" && pwd)
MATTE=/Users/seojeonghwa/project/CardNews/tools/matte
W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$D/photo-1.png")
S=$(python3 -c "print(1350/$W)")

anchor(){ # -> "X,Y" on the 1350x2400 plate, from matte's face= (else mask bbox centre)
  local out; out=$($MATTE "$1" /dev/null 2>/dev/null || true)
  local f; f=$(echo "$out" | grep -o 'face=[0-9,]*' | cut -d= -f2 || true)
  if [ -n "$f" ]; then IFS=, read -r x y w h <<< "$f"
  else local b; b=$(echo "$out"|grep -o 'bbox=[0-9,]*'|cut -d= -f2); IFS=, read -r x y w h <<< "$b"; h=$((h/3)); fi
  python3 -c "print(f'{round(($x+$w/2)*$S)},{round(($y+$h/2)*$S)}')"
}

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# shot list: photo, dur, style   (wide / punch alternation)
# ⚠️ 예전엔 사진 5장을 전제로 PLAN을 고정해뒀다. 그런데 텔레그램에서 사람이 3장만
#    고르면 4·5번 파일이 없어 통째로 실패했다(실측 2026-09-03: 1장 선택 → 빈 결과).
#    있는 장수를 세어 계획을 만든다. 한 장에서 와이드+펀치인 두 컷을 뽑는 원칙은 그대로다.
N=$(ls "$D"/photo-*.png 2>/dev/null | grep -vc mask || echo 0)
[ "$N" -lt 1 ] && { echo "사진이 없습니다: $D" >&2; exit 1; }
STYLES=(dolly push pull dolly push)
PLAN=""
i=0
while [ $i -lt "$N" ]; do
  n=$((i+1)); st=${STYLES[$((i % 5))]}
  # 와이드 한 컷 + 펀치인 한 컷. 장수가 적으면 컷을 길게 잡아 총 길이를 지킨다.
  if [ "$N" -le 2 ]; then wide=4.0; punch=2.4; else wide=3.2; punch=1.6; fi
  PLAN="$PLAN $n:$wide:$st $n:$punch:punch"
  i=$n
done
PLAN=$(echo "$PLAN" | sed 's/^ //')
SHOTS=(); i=0
for spec in $PLAN; do
  IFS=: read -r n dur style <<< "$spec"; i=$((i+1))
  A=""; [ "$style" = punch ] && A=$(anchor "$D/photo-$n.png")
  "$HERE/shot.sh" "$D/photo-$n.png" "$D/photo-$n.mask.png" "$T/s$i.mp4" "$dur" "$style" "$i" "$A"
  SHOTS+=("$T/s$i.mp4")
done
# EDIT: vlog rhythm = mostly hard CUTS, whips for energy, one dip-to-black beat,
# one slow dissolve to close. A dissolve between two shots of the same face
# double-exposes it and instantly reads "slideshow" - so almost none are used.
"$HERE/assemble.sh" "$OUT" "whip:0.30:l,cut,whip:0.28:r,cut,cut,whip:0.26:u,cut,diss:0.45" "${SHOTS[@]}"
