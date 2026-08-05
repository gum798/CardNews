// 릴스 프레임(JPEG) → reel.mp4. ffmpeg로 카드 간 크로스페이드 + BGM 합성, ffprobe 검증.
// import만으로는 아무것도 실행하지 않는다 (launchd env 미상속 대응해 바이너리 절대경로 고정).
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { paths, pipeline, reel as reelCfg } from '../config.js';
import { getMeta, setMeta } from '../db/index.js';
import { foregroundMatte, personaPlacement } from './matte.js';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';

const SECONDS_PER_CARD = pipeline.secondsPerCard; // 3.5
const XFADE_DURATION = 0.5; // 카드 간 크로스페이드 길이 (< SECONDS_PER_CARD)
const FPS = 30;
const REEL_MIN = 5; // IG 릴스 자격 하한
const REEL_MAX = 90; // IG 릴스 자격 상한

// execFile을 Promise로. 실패 시 stderr를 에러 메시지에 포함.
function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${path.basename(bin)} 실패: ${err.message}\n${stderr}`;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// assets/bgm에서 .mp3 선택. 셔플백: 모든 트랙을 한 바퀴 돌 때까지 반복 안 하고,
// 같은 곡이 연달아 나오지 않게. 최근 사용 이력은 meta('bgm_recent')에 저장.
function pickBgm() {
  const files = readdirSync(paths.bgm).filter((f) => f.toLowerCase().endsWith('.mp3'));
  if (files.length === 0) throw new Error(`BGM 없음: ${paths.bgm}에 .mp3 파일을 넣어라`);
  if (files.length === 1) return path.join(paths.bgm, files[0]);

  let recent = [];
  try {
    recent = JSON.parse(getMeta('bgm_recent') || '[]').filter((f) => files.includes(f));
  } catch {
    recent = [];
  }

  let pool = files.filter((f) => !recent.includes(f));
  if (pool.length === 0) {
    // 한 바퀴 다 돌았음 → 리셋하되 직전 곡만 제외해 즉시 반복 방지.
    const last = recent[recent.length - 1];
    pool = files.filter((f) => f !== last);
    recent = last ? [last] : [];
  }

  const chosen = pool[Math.floor(Math.random() * pool.length)];
  recent.push(chosen);
  while (recent.length > files.length - 1) recent.shift();
  setMeta('bgm_recent', JSON.stringify(recent));

  return path.join(paths.bgm, chosen);
}

// 각 프레임을 1080×1920로 정규화하는 필터 조각.
function normFilter(i) {
  return (
    `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease:in_range=full:out_range=tv,` +
    `pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${i}]`
  );
}

// xfade 체인 filter_complex 그래프. 최종 라벨은 [vout].
function buildXfadeGraph(n) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(normFilter(i));

  if (n === 1) {
    parts.push('[v0]copy[vout]');
    return parts.join(';');
  }

  let prev = '[v0]';
  for (let i = 1; i < n; i++) {
    const out = i === n - 1 ? '[vout]' : `[x${i}]`;
    const offset = (i * (SECONDS_PER_CARD - XFADE_DURATION)).toFixed(3);
    parts.push(`${prev}[v${i}]xfade=transition=fade:duration=${XFADE_DURATION}:offset=${offset}${out}`);
    prev = out;
  }
  return parts.join(';');
}

// 공통 인코딩 인자 (video/audio 매핑 이후에 붙는다).
function encodeArgs() {
  return [
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-b:v', pipeline.reelBitrate.target, '-maxrate', pipeline.reelBitrate.max, '-bufsize', '16M',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', '-shortest', '-y',
  ];
}

// xfade 방식 ffmpeg 인자. 이미지 입력 n개 + BGM 1개.
function buildXfadeFfmpegArgs(frames, bgm, outPath) {
  const args = [];
  for (const f of frames) {
    args.push('-loop', '1', '-framerate', String(FPS), '-t', String(SECONDS_PER_CARD), '-i', f);
  }
  args.push('-stream_loop', '-1', '-i', bgm); // BGM은 마지막 입력 = index frames.length
  args.push('-filter_complex', buildXfadeGraph(frames.length));
  args.push('-map', '[vout]', '-map', `${frames.length}:a`);
  args.push(...encodeArgs(), outPath);
  return args;
}

// concat demuxer 폴백. 마지막 file 줄을 한 번 더 반복해 "마지막 duration 무시" 버그 회피.
function buildConcatFfmpegArgs(frames, bgm, outPath, listPath) {
  const lines = [];
  for (const f of frames) {
    lines.push(`file '${f.replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${SECONDS_PER_CARD}`);
  }
  // 마지막 프레임의 duration은 concat이 무시하므로 마지막 file을 반복.
  lines.push(`file '${frames[frames.length - 1].replace(/'/g, "'\\''")}'`);
  writeFileSync(listPath, lines.join('\n') + '\n');

  return [
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-stream_loop', '-1', '-i', bgm,
    '-vf', `scale=1080:1920:force_original_aspect_ratio=decrease:in_range=full:out_range=tv,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`,
    '-map', '0:v', '-map', '1:a',
    ...encodeArgs(), outPath,
  ];
}

// ffprobe로 코덱/픽셀포맷/오디오/길이 검증. 실패 시 throw.
async function validate(outPath) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', outPath,
  ]);
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (!video || video.codec_name !== 'h264') throw new Error(`검증 실패: 비디오 코덱이 h264 아님 (${video?.codec_name})`);
  if (video.pix_fmt !== 'yuv420p') throw new Error(`검증 실패: pix_fmt가 yuv420p 아님 (${video.pix_fmt})`);
  if (!audio) throw new Error('검증 실패: 오디오 트랙 없음');

  const duration = Number(info.format?.duration);
  if (!(duration >= REEL_MIN && duration <= REEL_MAX)) {
    throw new Error(`검증 실패: 길이 ${duration}s가 IG 릴스 범위(${REEL_MIN}~${REEL_MAX}s) 밖`);
  }
  return duration;
}

// ── 나레이션 릴스 ──────────────────────────────────────────────────────────
// 프레임 i는 오디오 세그먼트 i가 재생되는 동안만 보인다(자막·음성 자동 싱크).
// 정지 이미지는 쇼츠에서 1초 안에 스와이프되므로 zoompan(켄번즈)으로 상시 모션을 준다.
//
// 훅도 나레이션에 포함한다(과거엔 1.1초 무음 정지 프레임을 앞에 뒀다).
// 판정이 갈리는 첫 1초를 무음 정지화면으로 쓰는 건 이득이 없고, 프레임과 오디오가
// 1:1로 대응하지 않아 정렬 코드도 복잡해졌다.
const HOOK_SEC = 0;

// 켄번즈: 짝수는 줌인, 홀수는 줌아웃으로 번갈아 단조로움을 피한다.
// 입력을 먼저 크게 확대(scale→crop)해야 zoompan 결과가 뭉개지지 않는다.
//
// ⚠️ zoompan의 d는 "입력 이미지 1장당 출력할 프레임 수"다.
// `-loop 1 -t T`는 이미 T*FPS장의 입력 프레임을 만들므로, 여기에 d=T*FPS를 주면
// 출력이 (T*FPS)^2 프레임으로 폭증해 첫 장면만 재생되다 잘린다(실제로 그 버그를 겪었다).
// 루프 입력에는 반드시 d=1을 쓰고, 줌은 출력 프레임 번호(on)로 직접 계산한다.
const ZOOM_AMP = 0.16;
const PAN_AMP = 0.06; // 화면 대비 이동량. 줌만 하면 단조로워서 방향도 섞는다.

// 구간마다 다른 움직임을 준다(줌인/줌아웃 × 상하좌우 드리프트).
const MOVES = [
  { zoomIn: true, dx: 1, dy: 0 },
  { zoomIn: false, dx: -1, dy: 0 },
  { zoomIn: true, dx: 0, dy: 1 },
  { zoomIn: false, dx: 1, dy: -1 },
  { zoomIn: true, dx: -1, dy: 1 },
  { zoomIn: false, dx: 0, dy: -1 },
];

// 손떨림 진폭(px). 이보다 키우면 오버스캔 여유를 넘어 가장자리가 튄다.
const SHAKE_AMP = 6;

function kenBurns(inIdx, outLabel, durSec, i) {
  const n = Math.max(2, Math.round(durSec * FPS)); // 이 구간의 출력 프레임 수
  const m = MOVES[i % MOVES.length];
  // ⚠️ zoompan 필터 안에는 변수 t가 없다. 시간은 출력 프레임 번호 on으로 만든다.
  const T = `(on/${FPS})`;
  // 줌 바닥을 1.0이 아니라 1.02로 올린다. 1.0이면 첫 프레임의 오버스캔 여유가 0이라
  // 손떨림이 클램프되어 죽거나 가장자리가 드러난다.
  const z = m.zoomIn
    ? `1.02+${ZOOM_AMP}*on/${n}`
    : `${(1.02 + ZOOM_AMP).toFixed(3)}-${ZOOM_AMP}*on/${n}`;
  // 중앙 기준 + 진행도(on/n)에 비례한 드리프트. 확대된 영역 안에서만 움직이므로 검은 여백이 안 생긴다.
  const px = m.dx ? `+(${m.dx})*(iw-iw/zoom)*${PAN_AMP}*on/${n}` : '';
  const py = m.dy ? `+(${m.dy})*(ih-ih/zoom)*${PAN_AMP}*on/${n}` : '';
  // 서로 나누어떨어지지 않는 두 주기를 겹쳐 "사람이 든 카메라"처럼 보이게 한다.
  const sx = `+${SHAKE_AMP}*sin(2*PI*${T}/2.3)+${(SHAKE_AMP / 2).toFixed(1)}*sin(2*PI*${T}/0.71)`;
  const sy = `+${SHAKE_AMP - 1}*sin(2*PI*${T}/3.1)+${(SHAKE_AMP / 3).toFixed(1)}*sin(2*PI*${T}/0.53)`;
  return (
    `[${inIdx}:v]scale=1350:2400:force_original_aspect_ratio=increase:in_range=full:out_range=tv,` +
    `crop=1350:2400,` +
    `zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)${px}${sx}':y='ih/2-(ih/zoom/2)${py}${sy}':` +
    `s=1080x1920:fps=${FPS},` +
    `setsar=1,format=yuv420p[${outLabel}]`
  );
}

// ── 2.5D 패럴랙스 ──────────────────────────────────────────────────────────
// 배경 영상과 하나를 서로 반대 방향으로, 다른 속도로 움직인다.
// 깊이가 다른 두 레이어가 어긋나게 움직이면 뇌가 "카메라 앞에 사람이 서 있다"로 읽는다.
// 주기를 서로 나누어떨어지지 않는 값으로 잡아야 패턴이 눈에 띄지 않는다.
const BG_OVERSCAN_W = 1160; // 1080 + 흔들림 여유
const BG_OVERSCAN_H = 2062; // 1920 + 흔들림 여유

// 배경: 느리고 작게. 손으로 든 카메라가 가만히 있으려 애쓰는 정도.
const bgDriftX = `14*sin(2*PI*t/8.7)`;
const bgDriftY = `11*sin(2*PI*t/11.3)`;
// 하나: 배경 반대 방향으로 더 크게(시차) + 미세 손떨림(고주파 소진폭).
const personaDriftX = `-16*sin(2*PI*t/5.9)-4*sin(2*PI*t/0.83)`;
const personaDriftY = `12*sin(2*PI*t/7.1)+3*sin(2*PI*t/0.67)`;

// 하나 키프레임 → 오려낸 레이어 정보. 인트로는 첫 구간, 아웃트로는 마지막 구간에만 보인다.
// 매트가 실패하거나 못 믿을 수준이면 그 컷은 조용히 빠진다(영상은 그대로 나간다).
export async function personaLayersFor(persona, durations) {
  if (!persona) return [];
  const total = durations.reduce((a, b) => a + b, 0);
  const lastStart = total - durations[durations.length - 1];

  const wanted = [
    { image: persona.intro, start: 0, end: durations[0] },
    { image: persona.outro, start: lastStart, end: total },
  ].filter((w) => w.image);

  const layers = [];
  for (const w of wanted) {
    const info = await foregroundMatte(w.image);
    if (!info) continue;
    layers.push({
      image: w.image,
      mask: info.maskPath,
      place: personaPlacement(info),
      start: w.start,
      end: w.end,
    });
  }
  return layers;
}

// 실사 영상 배경 + 투명 자막 오버레이. 배경이 실제로 움직여 정지 사진보다 이탈이 적다.
// bgVideo는 대개 가로(16:9)이므로 세로를 채우도록 확대 후 중앙 크롭한다.
//
// personaLayers: [{ image, mask, place, start, end }] — 오려낸 하나를 자막 위에 세운다.
// 자막 안전영역이 이미 위로 비켜나 있어(.safe.with-persona) 겹치지 않는다.
async function buildVideoBgReel(framePaths, segments, bgVideo, bgm, outPath, personaLayers = []) {
  const durations = segments.map((s) => s.duration);
  const total = durations.reduce((a, b) => a + b, 0);

  const args = ['-stream_loop', '-1', '-i', bgVideo]; // 0: 배경 영상(길이 부족분은 루프)
  for (const f of framePaths) args.push('-loop', '1', '-t', total.toFixed(3), '-i', f); // 1..N: 오버레이
  for (const s of segments) args.push('-i', s.audioPath);
  args.push('-stream_loop', '-1', '-i', bgm);
  // 하나 레이어: 이미지 + 마스크를 쌍으로
  for (const p of personaLayers) {
    args.push('-loop', '1', '-t', total.toFixed(3), '-i', p.image);
    args.push('-loop', '1', '-t', total.toFixed(3), '-i', p.mask);
  }

  const nOv = framePaths.length;
  const aStart = 1 + nOv;
  const bgmIdx = aStart + segments.length;
  const pStart = bgmIdx + 1;

  const g = [];
  // 배경: 세로를 채우도록 확대 → 오버스캔 크롭 → 살짝 어둡게(자막 대비 확보)
  //       → 시간가변 크롭으로 느린 드리프트. setpts 뒤에 둬야 t가 0부터 시작한다.
  g.push(
    `[0:v]scale=${BG_OVERSCAN_W}:${BG_OVERSCAN_H}:force_original_aspect_ratio=increase:in_range=full:out_range=tv,` +
      `crop=${BG_OVERSCAN_W}:${BG_OVERSCAN_H},fps=${FPS},eq=brightness=-0.06:saturation=1.05,` +
      `trim=duration=${total.toFixed(3)},setpts=PTS-STARTPTS,` +
      `crop=1080:1920:x='(iw-ow)/2+${bgDriftX}':y='(ih-oh)/2+${bgDriftY}',setsar=1[bgv]`
  );
  // 각 오버레이를 자기 구간에만 표시
  let prev = '[bgv]';
  let t = 0;
  const spans = [];
  for (let i = 0; i < nOv; i++) {
    const start = t;
    const end = t + durations[i];
    spans.push({ start, end });
    t = end;
    const last = i === nOv - 1 && personaLayers.length === 0;
    const out = last ? '[vout]' : `[ov${i}]`;
    g.push(
      `${prev}[${i + 1}:v]overlay=0:0:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'` +
        `${last ? ',format=yuv420p' : ''}${out}`
    );
    prev = out;
  }

  // 하나는 자막 오버레이 **위**에 얹는다. 예전 HTML에서도 진행자가 스크림보다 앞이었고,
  // 아래에 두면 스크림 그라디언트(하단 82%)에 얼굴이 어두워진다.
  for (let k = 0; k < personaLayers.length; k++) {
    const p = personaLayers[k];
    const ii = pStart + k * 2;
    const mi = ii + 1;
    const { canvasW, canvasH, x, y } = p.place;
    // 이미지: 배치 크기로 확대 + 배경 영상 톤에 맞춰 아주 살짝 눌러준다(오려낸 티 완화)
    g.push(
      `[${ii}:v]scale=${canvasW}:${canvasH},setsar=1,eq=brightness=-0.02:saturation=0.97,format=rgba[pi${k}]`
    );
    // 마스크: 같은 크기로 확대 후 가장자리를 부드럽게(칼로 오린 티 제거)
    g.push(`[${mi}:v]scale=${canvasW}:${canvasH},format=gray,gblur=sigma=1.8[pm${k}]`);
    g.push(`[pi${k}][pm${k}]alphamerge[pa${k}]`);

    const last = k === personaLayers.length - 1;
    const out = last ? '[vout]' : `[pv${k}]`;
    g.push(
      `${prev}[pa${k}]overlay=x='${x}${personaDriftX.startsWith('-') ? '' : '+'}${personaDriftX}':` +
        `y='${y}+${personaDriftY}':enable='between(t,${p.start.toFixed(3)},${p.end.toFixed(3)})'` +
        `${last ? ',format=yuv420p' : ''}${out}`
    );
    prev = out;
  }

  g.push(
    `${segments.map((_, i) => `[${aStart + i}:a]`).join('')}concat=n=${segments.length}:v=0:a=1[narr]`
  );
  g.push(`[${bgmIdx}:a]volume=${reelCfg.bgmVolume},aformat=channel_layouts=stereo[bgmq]`);
  g.push(`[narr][bgmq]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);

  args.push('-filter_complex', g.join(';'));
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push(...encodeArgs(), outPath);
  await run(FFMPEG, args);
}

// framePaths[0]=훅, [1..]=자막 라인. segments[i]는 라인 i의 오디오({audioPath,duration}).
// bgVideo를 주면 실사 영상 배경 + 투명 오버레이 방식으로, 없으면 정지 프레임 켄번즈 방식으로.
// 반환: 생성된 mp4 경로.
export async function makeNarratedReel(
  candidateId,
  framePaths,
  segments,
  // personaLayers를 미리 계산해 넘기면 그대로 쓴다(호출부가 렌더 전에 매트 성공 여부를 알아야 하므로).
  { bgVideo = null, persona = null, personaLayers = null } = {}
) {
  if (framePaths.length !== segments.length) {
    throw new Error(`프레임(${framePaths.length})과 오디오 세그먼트(${segments.length}) 수가 같아야 함`);
  }

  const outDir = path.join(paths.out, String(candidateId));
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'reel.mp4');
  const bgm = pickBgm();

  const durations = segments.map((s) => s.duration);
  const total = durations.reduce((a, b) => a + b, 0);

  // 실사 영상 배경이 있으면 오버레이 방식으로.
  if (bgVideo) {
    const layers = personaLayers ?? (await personaLayersFor(persona, durations));
    await buildVideoBgReel(framePaths, segments, bgVideo, bgm, outPath, layers);
    const d = await validate(outPath);
    console.log(
      `[video] 나레이션 릴스(실사배경) ${d.toFixed(1)}초 (라인 ${segments.length}개` +
        `${layers.length ? `, 하나 ${layers.length}컷 오려냄` : ''})`
    );
    return outPath;
  }

  const args = [];
  // 이미지 입력: 각 프레임을 해당 길이만큼
  for (let i = 0; i < framePaths.length; i++) {
    args.push('-loop', '1', '-framerate', String(FPS), '-t', durations[i].toFixed(3), '-i', framePaths[i]);
  }
  // 나레이션 오디오 입력
  for (const s of segments) args.push('-i', s.audioPath);
  // BGM
  args.push('-stream_loop', '-1', '-i', bgm);

  const nImg = framePaths.length;
  const aStart = nImg;
  const bgmIdx = nImg + segments.length;

  const g = [];
  for (let i = 0; i < nImg; i++) g.push(kenBurns(i, `v${i}`, durations[i], i));
  g.push(`${framePaths.map((_, i) => `[v${i}]`).join('')}concat=n=${nImg}:v=1:a=0[vout]`);

  g.push(
    `${segments.map((_, i) => `[${aStart + i}:a]`).join('')}concat=n=${segments.length}:v=0:a=1[narr]`
  );
  g.push(`[${bgmIdx}:a]volume=${reelCfg.bgmVolume},aformat=channel_layouts=stereo[bgmq]`);
  g.push(`[narr][bgmq]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);

  args.push('-filter_complex', g.join(';'));
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push(...encodeArgs(), outPath);

  await run(FFMPEG, args);
  const dur = await validate(outPath);
  console.log(`[video] 나레이션 릴스 ${dur.toFixed(1)}초 (라인 ${segments.length}개, 목표 ${total.toFixed(1)}초)`);
  if (dur < reelCfg.targetSec.min || dur > reelCfg.targetSec.max) {
    console.warn(`[video] 길이 ${dur.toFixed(1)}초가 권장(${reelCfg.targetSec.min}~${reelCfg.targetSec.max}초) 밖 — 대본 길이 조정 필요`);
  }
  return outPath;
}

// 완성된 영상에서 표지(썸네일)용 정지 프레임 1장을 뽑는다. 실패 시 null.
// 실사영상 배경일 때 훅 프레임이 투명 PNG라 표지로 못 쓰는 경우에 사용.
export async function grabPoster(videoPath, outPath, atSec = 1.0) {
  try {
    await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(atSec), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outPath, '-y',
    ]);
    return outPath;
  } catch {
    return null;
  }
}

// 릴스 프레임(JPEG) 배열 → out/<candidateId>/reel.mp4 생성 후 경로 반환.
export async function makeReel(candidateId, reelFramePaths) {
  if (!Array.isArray(reelFramePaths) || reelFramePaths.length === 0) {
    throw new Error('reelFramePaths가 비었다');
  }

  const outDir = path.join(paths.out, String(candidateId));
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'reel.mp4');
  const bgm = pickBgm();

  try {
    // 선호: xfade로 카드 간 크로스페이드 (독창성 페널티 대응 모션).
    await run(FFMPEG, buildXfadeFfmpegArgs(reelFramePaths, bgm, outPath));
  } catch (xfadeErr) {
    // 폴백: concat demuxer (모션 없음, 후속 과제). xfade 그래프 실패 시에만.
    const listPath = path.join(outDir, 'concat.txt');
    try {
      await run(FFMPEG, buildConcatFfmpegArgs(reelFramePaths, bgm, outPath, listPath));
    } catch (concatErr) {
      concatErr.message = `xfade·concat 모두 실패\n[xfade] ${xfadeErr.message}\n[concat] ${concatErr.message}`;
      throw concatErr;
    }
  }

  await validate(outPath);
  return outPath;
}
