#!/bin/bash
# shot.sh — one still -> one moving SHOT (1080x1920 @30fps, no audio).
#   shot.sh <img> <mask|-> <out.mp4> <dur> <style> [seed] [anchorX,anchorY]
#
# styles
#   dolly  2.5D parallax, RIGID LAYER: subject cut out with tools/matte and
#          translated as a whole over a hole-filled, depth-displaced background.
#          Zero silhouette warping - use this whenever a face is in frame.
#   drift  2.5D parallax, DISPLACE field: continuous depth warp, one pass, no
#          cut-out. Cheaper and smoother, but it rubber-sheets across every depth
#          edge. Amplitude is capped low here; only safe with no face at the edge.
#   push / pull   Ken Burns in / out, eased.
#   punch  tight face-anchored cutaway from the SAME still (a second "angle").
set -euo pipefail
# ⚠️ launchd(텔레그램 봇)에서 호출되면 PATH가 /usr/bin:/bin 뿐이다. 그러면 ffprobe를
#    못 찾고, python3는 Apple 시스템 파이썬으로 잡혀 이 맥에서 MTE 크래시가 난다(CLAUDE.md).
#    실측 2026-09-03: 터미널에선 되는데 봇에서 누르면 "body.mp4: No such file"로 실패.
export PATH=/opt/homebrew/bin:/opt/homebrew/share/google-cloud-sdk/bin:/usr/local/bin:$PATH
FF=/opt/homebrew/bin/ffmpeg
IMG=$1; MASK=$2; OUT=$3; DUR=$4; STYLE=$5; SEED=${6:-0}; ANCHOR=${7:-}
W=1080; H=1920; FPS=30; OVW=1350; OVH=2400
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
MW=$((OVW/4)); MH=$((OVH/4))          # 1/4-res displacement maps: 4x faster, 45 dB

$FF -v error -i "$IMG" -vf \
 "scale=${OVW}:${OVH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OVW}:${OVH},setsar=1" \
 -frames:v 1 -y "$T/plate.png"
HAVE_MASK=0
if [ "$MASK" != "-" ] && [ -f "$MASK" ]; then
  HAVE_MASK=1
  $FF -v error -i "$MASK" -vf \
   "scale=${OVW}:${OVH}:force_original_aspect_ratio=increase,crop=${OVW}:${OVH},format=gray" \
   -frames:v 1 -y "$T/mask.png"
fi

# handheld: two incommensurate sines per axis + a sub-degree roll.
# One sine is a metronome - the eye locks onto it inside two seconds.
P=$(python3 -c "print(1+($SEED%3)*0.37)")
SX="5.5*sin(2*PI*t/(2.3*$P))+2.2*sin(2*PI*t/(0.71*$P))"
SY="4.5*sin(2*PI*t/(3.1*$P))+1.8*sin(2*PI*t/(0.53*$P))"
ROLL="0.0035*sin(2*PI*t/5.7)+0.0015*sin(2*PI*t/1.9)"
E="(6*pow(min(t/$DUR,1),5)-15*pow(min(t/$DUR,1),4)+10*pow(min(t/$DUR,1),3))"  # smootherstep

case "$STYLE" in
  dolly) Z0=1.02; Z1=1.02 ;;
  drift) Z0=1.02; Z1=1.02 ;;
  push)  Z0=1.00; Z1=1.14 ;;
  pull)  Z0=1.14; Z1=1.00 ;;
  punch) Z0=1.55; Z1=1.66 ;;
  *) echo "unknown style $STYLE" >&2; exit 2 ;;
esac
Z="$Z0+($Z1-$Z0)*$E"
CX="(iw-ow)/2"; CY="(ih-oh)/2"
if [ -n "$ANCHOR" ]; then AX=${ANCHOR%,*}; AY=${ANCHOR#*,}
  CX="clip($AX-ow/2,0,iw-ow)"; CY="clip($AY-oh/2,0,ih-oh)"; fi
FINISH="crop='${W}/(${Z})':'${H}/(${Z})':'${CX}+${SX}':'${CY}+${SY}',\
scale=${W}:${H}:flags=lanczos,setsar=1,vignette=PI/5,noise=c0s=3:c0f=t+u,format=yuv420p"

# ground-plane pseudo-depth: 0 far (top) -> 255 near (bottom of frame)
GROUND="color=c=black:s=${MW}x${MH},format=gray,geq=lum='clip(40+215*pow(Y/H,1.6),0,255)',gblur=sigma=3"

if [ "$STYLE" = dolly ] && [ $HAVE_MASK = 1 ]; then
  # background plate with the subject hole filled. Only a ~30px sliver at the
  # silhouette is ever revealed, so a dilated blur fill is invisible in motion.
  $FF -v error -i "$T/plate.png" -i "$T/mask.png" -filter_complex \
   "[1:v]format=gray,dilation=coordinates=255,dilation=coordinates=255,dilation=coordinates=255,gblur=sigma=25[m];\
    [0:v]gblur=sigma=45[fill];[0:v][fill][m]maskedmerge,format=rgb24" -frames:v 1 -y "$T/bg.png"
  $FF -v error -loop 1 -t "$DUR" -i "$T/bg.png" -loop 1 -t "$DUR" -i "$T/plate.png" \
      -loop 1 -t "$DUR" -i "$T/mask.png" -filter_complex "\
${GROUND},fps=${FPS},split=2[g1][g2];\
[g1]geq=lum='128+9*sin(2*PI*T/6.0)*(p(X,Y)/255)',scale=${OVW}:${OVH}:flags=bicubic,format=gbrp[xm];\
[g2]geq=lum='128+4*sin(2*PI*T/7.3+1.1)*(p(X,Y)/255)',scale=${OVW}:${OVH}:flags=bicubic,format=gbrp[ym];\
[0:v]fps=${FPS},setsar=1,format=gbrp[bg];[bg][xm][ym]displace=edge=smear,format=rgba[bgp];\
[2:v]fps=${FPS},format=gray,gblur=sigma=2.5[mk];\
[1:v]fps=${FPS},setsar=1,format=rgba[fgc];[fgc][mk]alphamerge[fg];\
[bgp][fg]overlay=x='-22*sin(2*PI*t/6.0)':y='-9*sin(2*PI*t/7.3+1.1)'[comp];\
[comp]rotate='${ROLL}':c=none:ow=iw:oh=ih,${FINISH}[v]" \
   -map "[v]" -r $FPS -c:v libx264 -crf 19 -preset medium -y "$OUT"
  exit 0
fi

# displace path (drift / push / pull / punch, or dolly with no matte)
if [ $HAVE_MASK = 1 ]; then
  $FF -v error -i "$T/mask.png" -filter_complex \
   "[0:v]format=gray,gblur=sigma=12[pm];color=c=black:s=${OVW}x${OVH},format=gray,\
    geq=lum='clip(40+215*pow(Y/H,1.6),0,255)'[gr];[pm][gr]blend=all_mode=lighten,gblur=sigma=9,format=gray" \
   -frames:v 1 -y "$T/depth.png"
else
  $FF -v error -f lavfi -i "color=c=black:s=${OVW}x${OVH}" \
   -vf "format=gray,geq=lum='clip(40+215*pow(Y/H,1.6),0,255)',gblur=sigma=9" -frames:v 1 -y "$T/depth.png"
fi
# local stretch = amplitude / depth-ramp-width. This map's ramp is ~60px, so
# 8px stays under ~13% distortion; 26px hits +43% and reads as rubber.
case "$STYLE" in drift) PAX=10; PAY=4 ;; punch) PAX=5; PAY=2 ;; *) PAX=8; PAY=4 ;; esac
$FF -v error -loop 1 -t "$DUR" -i "$T/plate.png" -loop 1 -t "$DUR" -i "$T/depth.png" -filter_complex "\
[0:v]fps=${FPS},setsar=1,format=gbrp[src];\
[1:v]fps=${FPS},format=gray,scale=${MW}:${MH},split=2[d1][d2];\
[d1]geq=lum='128+${PAX}*sin(2*PI*T/6.0)*(p(X,Y)/255)',scale=${OVW}:${OVH}:flags=bicubic,format=gbrp[xm];\
[d2]geq=lum='128+${PAY}*sin(2*PI*T/7.3+1.1)*(p(X,Y)/255)',scale=${OVW}:${OVH}:flags=bicubic,format=gbrp[ym];\
[src][xm][ym]displace=edge=smear[par];\
[par]rotate='${ROLL}':c=none:ow=iw:oh=ih,${FINISH}[v]" \
 -map "[v]" -r $FPS -c:v libx264 -crf 19 -preset medium -y "$OUT"
