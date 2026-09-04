#!/bin/bash
# 브이로그 릴스 = ZeroGPU 실사 클립(앞부분) + ffmpeg 2.5D 릴스(나머지).
#
# 사용자 결정(2026-09-02): "하루 한 편만 H3로 만들자".
#   → 하루 두 편 중 한 편만 실사 클립을 붙이고, 나머지 한 편은 ffmpeg만 쓴다.
#     이유는 산수다. 3초 클립 하나가 GPU 62초를 먹는데 무료 할당은 300초/일이라,
#     20초짜리를 통째로 실사로 채우려면 하루 868초가 필요하다(2.9배 부족).
#
# ⚠️ 남는 할당량을 0까지 긁지 않는다. 재시도 한 번 분량(70초)은 남긴다.
# ⚠️ 이건 원격 API라 업무 시간에도 돌아간다 — _worktime.sh 가드를 걸지 않는다.
#    (가드는 로컬 GPU를 먹는 작업 전용이다)
set -u
# ⚠️ launchd(텔레그램 봇)에서 호출되면 PATH가 /usr/bin:/bin 뿐이다. 그러면 ffprobe를
#    못 찾고, python3는 Apple 시스템 파이썬으로 잡혀 이 맥에서 MTE 크래시가 난다(CLAUDE.md).
#    실측 2026-09-03: 터미널에선 되는데 봇에서 누르면 "body.mp4: No such file"로 실패.
export PATH=/opt/homebrew/bin:/opt/homebrew/share/google-cloud-sdk/bin:/usr/local/bin:$PATH
ROOT=/Users/seojeonghwa/project/CardNews
DIR=${1:?사용: vlog-reel.sh <out/vlog-YYYYMMDD-slot> [out.mp4]}
OUT=${2:-$DIR/reel.mp4}
KIND=${KIND:-h3,wan}      # 폴백 사슬: h3 먼저, 붐비면 wan (실측: H3가 자주 붐빔)
HERO_SLOT=${HERO_SLOT:-evening}   # 실사 클립을 붙일 슬롯
PY=$HOME/models/localgen/.venv/bin/python
FF=/opt/homebrew/bin/ffmpeg

# ⚠️ 슬롯을 폴더 이름에서 읽으면 안 된다. 봇이 선택한 사진만 임시 폴더(reel-XXXXXX)에
#    모아 넘기므로 "XXXXXX"가 슬롯이 되어 실사 클립이 영영 안 붙는다(실측). post.json이 정답이다.
SLOT=$(/opt/homebrew/bin/node -e "
  try{console.log('S>'+(require('$DIR/post.json').slot||''))}catch(e){console.log('S>')}" 2>/dev/null | grep -oE '^S>.*' | cut -c3-)
[ -z "$SLOT" ] && SLOT=$(basename "$DIR" | sed 's/.*-//')

# 0) 릴스 자격 — 점 빼기 전 시기(단계 3 미만) 사진은 릴스로 만들지 않는다(2026-09-03 사용자 결정).
# ⚠️ 호출하는 쪽(vlog-reel-auto.sh, 봇)에서도 거르지만 여기서 한 번 더 막는다. 실측 2026-09-03:
#    가드를 넣던 그 시각에 이미 돌고 있던 launchd 루프가 옛 본문 그대로 이 스크립트를 계속 불러
#    옛 얼굴 릴스 8편을 다시 만들고 텔레그램으로 보냈다. 이 스크립트는 매번 새로 읽히므로
#    여기서 막았으면 그 자리에서 멈췄다. 봇이 넘기는 임시 폴더에도 post.json이 복사돼 있다.
ELIG=$(cd "$ROOT" && D="$DIR" /opt/homebrew/bin/node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const { reelEligible, postStage } = await import('./src/vlog/review.js');
  try {
    const p = JSON.parse(readFileSync(process.env.D + '/post.json', 'utf8'));
    console.log('E>' + (reelEligible(p) ? 1 : 0) + ':' + postStage(p));
  } catch { console.log('E>0:?'); }" 2>/dev/null | grep -oE '^E>.*' | cut -c3-)
case "$ELIG" in
  1:*) ;;
  *) echo "[reel] 릴스 자격 없음 — 점 빼기 전 시기(단계 ${ELIG#*:}) $DIR" >&2; exit 4 ;;
esac
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# 1) 이 슬롯이 실사 담당인가? 그리고 할당량이 되는가?
CLIPS=0
if [ "$SLOT" = "$HERO_SLOT" ]; then
  # ⚠️ node 출력에 .env 로더 배너가 섞여 나온다. 숫자만 남기지 않으면
  #    "CLIPS◇: unbound variable" 같은 엉뚱한 에러가 난다(실측).
  CLIPS=$(cd "$ROOT" && /opt/homebrew/bin/node -e "
    import('./src/persona/zerogpu-budget.js').then(b => {
      const p = b.planClips('$KIND', 3, { durationSec: 3 });
      console.log('CLIPS=' + Math.min(p.affordable, 3));
    });" 2>/dev/null | grep -oE '^CLIPS=[0-9]+' | tail -1 | cut -d= -f2)
  CLIPS=${CLIPS:-0}
  echo "[reel] $SLOT = 실사 슬롯 · 만들 클립 ${CLIPS}개"
else
  echo "[reel] $SLOT = ffmpeg 전용 슬롯"
fi

# 2) 실사 클립 생성 (사진 1번부터). 실패하면 그 장은 건너뛰고 계속한다.
HERO=()
# ⚠️ macOS(BSD)의 `seq 1 0`은 빈 출력이 아니라 "1\n0"을 낸다(GNU seq와 다르다).
#    그대로 쓰면 할당량이 0일 때도 루프가 돌아 가드가 통째로 뚫린다(실측 2026-09-02).
#    산술 for로 바꿔 0이면 확실히 건너뛴다.
for ((i=1; i<=CLIPS; i++)); do
  IMG="$DIR/photo-$i.png"
  [ -f "$IMG" ] || continue
  PROMPT=$(cd "$ROOT" && /opt/homebrew/bin/node -e "
    const p=require('./$DIR/post.json');
    const a=(p.photos&&p.photos[$i-1]&&p.photos[$i-1].action)||'';
    console.log('P>' + (a || 'A young Korean woman, handheld phone footage, natural light, realistic'));" 2>/dev/null | grep -oE '^P>.*' | tail -1 | cut -c3-)
  echo "[reel] 클립 $i 생성..."
  # ⚠️ 출력을 `tail -2`로만 남기면 폴백 사슬(h3 → wan)에서 앞 kind가 왜 실패했는지가 사라진다
  #    (실측 2026-09-04: WAN 트레이스백 2줄만 남고 H3 사유는 유실). 파일로 받아 [zerogpu] 줄만 남긴다.
  if "$PY" "$ROOT/scripts/zerogpu-clip.py" --kind "$KIND" --image "$IMG" \
       --prompt "$PROMPT, handheld phone footage, natural light, realistic" \
       --duration 3 --out "$TMP/hero$i.mp4" > "$TMP/zg$i.log" 2>&1; then
    grep -a '^\[zerogpu\]' "$TMP/zg$i.log" | tail -2
    [ -f "$TMP/hero$i.mp4" ] && { HERO+=("$TMP/hero$i.mp4")
      (cd "$ROOT" && /opt/homebrew/bin/node -e "
        import('./src/persona/zerogpu-budget.js').then(b=>b.record(62));" 2>/dev/null); }
  else
    grep -a '^\[zerogpu\]\|Error' "$TMP/zg$i.log" | grep -v '접속\|대기' | tail -6 | cut -c1-240
    echo "[reel] 클립 $i 실패 → 건너뜀"
  fi
done

# 3) ffmpeg 릴스 (항상 만든다 — 실사가 0개여도 이것만으로 완성품이 된다)
echo "[reel] ffmpeg 릴스 생성..."
bash "$ROOT/tools/reel/build.sh" "$DIR" "$TMP/body.mp4" >/dev/null 2>&1

# 4) 이어붙이기. 실사 클립을 앞에 두어 피드에서 첫 3초에 진짜 움직임이 보이게 한다.
if [ ${#HERO[@]} -eq 0 ]; then
  cp "$TMP/body.mp4" "$OUT"
else
  # 해상도·fps를 body에 맞춰 정규화한 뒤 concat한다(그냥 붙이면 코덱이 안 맞는다).
  : > "$TMP/list.txt"
  n=0
  for f in "${HERO[@]}" "$TMP/body.mp4"; do
    n=$((n+1))
    # 원본 프레임레이트에 따라 보간 여부를 정한다.
    # ⚠️ 보간은 공짜가 아니다. minterpolate는 움직임을 추정해 없는 프레임을 만드는데,
    #    배경이 빠르게 바뀌는 구간에서 추정이 틀리면 화면이 깨진다(실측: H3 24fps를
    #    30fps로 올렸더니 사용자가 바로 알아챘다).
    #    그래서 「끊김이 보이는 낮은 fps」에만 쓴다:
    #      16fps(WAN Lightning) → 보간해야 한다. 안 하면 눈에 띄게 끊긴다.
    #      24fps(H3)            → 그냥 둔다. 30fps로 복제될 때의 미세한 저더가
    #                             보간 아티팩트보다 훨씬 낫다.
    SRC_FPS=$(/opt/homebrew/bin/ffprobe -v error -select_streams v:0 \
      -show_entries stream=r_frame_rate -of csv=p=0 "$f" 2>/dev/null | awk -F/ '{if($2)print int($1/$2); else print int($1)}')
    SRC_FPS=${SRC_FPS:-30}
    BASE="scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1"
    if [ "$f" != "$TMP/body.mp4" ] && [ "$SRC_FPS" -lt 20 ]; then
      VF="$BASE,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1"
      echo "[reel] $(basename "$f") ${SRC_FPS}fps → 보간 30fps"
    else
      VF="$BASE,fps=30"
      [ "$f" != "$TMP/body.mp4" ] && echo "[reel] $(basename "$f") ${SRC_FPS}fps → 보간 없이 유지"
    fi
    $FF -v error -i "$f" -vf "$VF" \
        -c:v libx264 -preset veryfast -crf 18 -an -y "$TMP/n$n.mp4"
    echo "file '$TMP/n$n.mp4'" >> "$TMP/list.txt"
  done
  $FF -v error -f concat -safe 0 -i "$TMP/list.txt" -c:v libx264 -preset medium -crf 20 \
      -pix_fmt yuv420p -movflags +faststart -y "$OUT"
fi

D=$(/opt/homebrew/bin/ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null)
echo "[reel] 완료 → $OUT (${D%.*}초, 실사 ${#HERO[@]}컷)"
