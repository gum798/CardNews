// 릴스 프레임(JPEG) → reel.mp4. ffmpeg로 카드 간 크로스페이드 + BGM 합성, ffprobe 검증.
// import만으로는 아무것도 실행하지 않는다 (launchd env 미상속 대응해 바이너리 절대경로 고정).
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { paths, pipeline } from '../config.js';

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

// assets/bgm에서 .mp3 랜덤 선택.
function pickBgm() {
  const files = readdirSync(paths.bgm).filter((f) => f.toLowerCase().endsWith('.mp3'));
  if (files.length === 0) throw new Error(`BGM 없음: ${paths.bgm}에 .mp3 파일을 넣어라`);
  return path.join(paths.bgm, files[Math.floor(Math.random() * files.length)]);
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
