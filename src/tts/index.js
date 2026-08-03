// 나레이션 합성. macOS 내장 `say`(한국어 Yuna 등)로 라인별 음성을 만들고 길이를 잰다.
// 라인 = 나레이션 단위 = 자막 한 줄 = 영상 프레임 하나. 이 대응이 자막 싱크를 보장한다.
// (API 키·네트워크 불필요 — 회사망 TLS 검사 환경에서도 안전)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reel } from '../config.js';
import { getMeta, setMeta } from '../db/index.js';
import { synthOne, DEFAULT_VOICE as GOOGLE_DEFAULT_VOICE } from './google.js';

const execFileAsync = promisify(execFile);
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';

// TTS에 넘기기 전 정리: 이모지·해시태그는 읽히면 안 되고, 숫자 뒤 단위는 붙여 읽는 게 자연스럽다.
// 영문 약어는 엔진에 따라 철자대로 읽거나 영어 발음으로 튀어 어색하다 → 한글 음차로 고정.
// (뉴스 카피에 자주 나오는 것만. 긴 것부터 치환해야 부분 일치로 깨지지 않는다)
const ACRONYMS = [
  ['ChatGPT', '챗지피티'], ['GPT', '지피티'], ['LLM', '엘엘엠'], ['API', '에이피아이'],
  ['CEO', '씨이오'], ['GDP', '지디피'], ['ETF', '이티에프'], ['IT', '아이티'],
  ['AI', '에이아이'], ['IoT', '아이오티'], ['5G', '파이브지'], ['6G', '식스지'],
  ['SNS', '에스엔에스'], ['PC', '피씨'], ['TV', '티비'], ['USB', '유에스비'],
  ['CPU', '씨피유'], ['GPU', '지피유'], ['HBM', '에이치비엠'],
];

// TTS 입력 정리. 화면에만 필요한 기호를 걷어내고, 오독이 잦은 표기를 발음대로 바꾼다.
function speakable(text) {
  let s = String(text)
    .replace(/\*/g, '') // 자막 강조 마커(*…*)는 읽지 않는다
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ') // 이모지 제거
    .replace(/#\S+/g, ' ') // 해시태그 제거
    .replace(/[「」『』]/g, ' ');

  for (const [from, to] of ACRONYMS) {
    s = s.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }

  s = s
    .replace(/(\d)\s*%/g, '$1 퍼센트')
    .replace(/(\d)\s*~\s*(\d)/g, '$1에서 $2') // 범위 표기
    .replace(/(\d)\s*℃/g, '$1도')
    .replace(/&/g, ' 그리고 ');

  return s.replace(/\s+/g, ' ').trim();
}

async function durationOf(file) {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]);
  const d = Number(String(stdout).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`오디오 길이 측정 실패: ${file}`);
  return d;
}

// 한국어 음성 선호 순위. macOS 음성은 4단계(super-compact/compact/enhanced/premium)이고
// 기본 설치본은 최하위(super-compact)다. 사용자가 설정에서 상위 음성을 받으면 자동으로 승격되도록
// 식별자(com.apple.voice.*)로 지정한다 — 표시 이름은 시스템 언어에 따라 바뀌어 스크립트에 부적합.
const KO_VOICE_PREFERENCE = [
  'com.apple.voice.premium.ko-KR.Yuna',
  'com.apple.voice.premium.ko-KR.Jina',
  'com.apple.voice.enhanced.ko-KR.Yuna',
  'com.apple.voice.enhanced.ko-KR.Jina',
  'com.apple.voice.enhanced.ko-KR.Minsu', // 유일한 한국어 남성 음성
  'com.apple.voice.enhanced.ko-KR.Nuri',
  'com.apple.voice.compact.ko-KR.Yuna',
  'com.apple.voice.super-compact.ko-KR.Yuna',
  'Yuna',
];

// 설치된 음성 목록(식별자 포함)을 한 번만 읽어 캐시.
let _installed = null;
async function installedVoices() {
  if (_installed) return _installed;
  try {
    const { stdout } = await execFileAsync('say', ['-v', '?']);
    _installed = stdout;
  } catch {
    _installed = '';
  }
  return _installed;
}

// 짧은 문장을 합성해 결과 해시를 얻는다. 설치 여부 판별용.
async function probeHash(voice) {
  const tmp = path.join(tmpdir(), `ttsprobe-${process.pid}-${Math.abs(hashCode(voice))}.aiff`);
  try {
    await execFileAsync('say', ['-v', voice, '-o', tmp, '가나다']);
    const h = createHash('md5').update(readFileSync(tmp)).digest('hex');
    return h;
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// 실제로 쓸 음성 결정.
// ⚠️ `say`는 설치되지 않은 음성 식별자를 줘도 조용히 기본 음성으로 폴백하고 exit 0을 반환하며,
//    출력이 기본 음성과 바이트 단위로 동일하다(실측 확인). 따라서 이름 존재 여부로는 판별 불가.
//    → 존재하지 않는 이름의 합성 결과를 "폴백 기준값"으로 삼고, 그와 다른 결과를 내는 음성만
//      실제 설치된 것으로 인정한다. 결과는 하루 캐시.
export async function resolveVoice(preferred = process.env.TTS_VOICE) {
  if (preferred) return preferred;

  const cached = getMeta('tts_voice_resolved');
  const at = Number(getMeta('tts_voice_probed_at') || 0);
  if (cached && Date.now() - at < 24 * 3600_000) return cached;

  const baseline = await probeHash('__no_such_voice__'); // 폴백 시 나오는 소리
  let chosen = 'Yuna';
  if (baseline) {
    for (const id of KO_VOICE_PREFERENCE) {
      if (id === 'Yuna') break; // 최후 수단은 검사 불필요
      const h = await probeHash(id);
      if (h && h !== baseline) {
        chosen = id;
        break;
      }
    }
  }
  setMeta('tts_voice_resolved', chosen);
  setMeta('tts_voice_probed_at', String(Date.now()));
  return chosen;
}

// 사용 가능한 음성인지 확인. ⚠️ `say`는 없는 음성 이름을 줘도 조용히 기본 음성으로 폴백하고
// exit 0을 반환하므로, 이름 존재 여부만으로는 판단할 수 없다. 최종 안전망은 아래 무음 감지다.
export async function checkVoice(voice = reel.voice) {
  const list = await installedVoices();
  if (!list) return false;
  const short = String(voice).split('.').pop();
  return list.includes(short);
}

// 원본 오디오(aiff/wav)를 호흡 패딩 + 스테레오 48kHz로 정규화하고 길이를 잰다.
async function normalize(rawPath, m4a, pad) {
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', rawPath,
    '-af', `apad=pad_dur=${pad},aformat=channel_layouts=stereo`,
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', m4a, '-y',
  ]);
  return durationOf(m4a);
}

// macOS `say`로 합성.
async function synthWithSay(lines, outDir, { pad, rate, voice }) {
  if (!(await checkVoice(voice))) {
    throw new Error(
      `TTS 음성 '${voice}'을(를) 찾을 수 없습니다. ` +
        `시스템 설정 › 손쉬운 사용 › 읽어주기(Read & Speak) › 시스템 음성에서 한국어 음성을 받거나 TTS_VOICE를 바꾸세요.`
    );
  }
  console.log(`[tts] engine=say voice=${voice}`);
  mkdirSync(outDir, { recursive: true });

  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const text = speakable(lines[i]);
    if (!text) continue;
    const aiff = path.join(outDir, `narr-${i}.aiff`);
    const m4a = path.join(outDir, `narr-${i}.m4a`);
    await execFileAsync('say', ['-v', voice, '-r', String(rate), '-o', aiff, text]);
    const duration = await normalize(aiff, m4a, pad);
    // 무음 감지: 음성이 미설치면 길이가 거의 0이 된다(say는 exit 0으로 조용히 폴백함).
    if (duration <= pad + 0.05) {
      throw new Error(`TTS가 무음을 생성했습니다 (라인 ${i}, 음성=${voice}).`);
    }
    segments.push({ text: lines[i], audioPath: m4a, duration });
  }
  return segments;
}

// Google Cloud TTS로 합성.
async function synthWithGoogle(lines, outDir, { pad, key, voice, speed }) {
  console.log(`[tts] engine=google voice=${voice}`);
  mkdirSync(outDir, { recursive: true });

  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const text = speakable(lines[i]);
    if (!text) continue;
    const wav = path.join(outDir, `narr-${i}.wav`);
    const m4a = path.join(outDir, `narr-${i}.m4a`);
    writeFileSync(wav, await synthOne(text, { voice, speed, key }));
    const duration = await normalize(wav, m4a, pad);
    if (duration <= pad + 0.05) throw new Error(`Google TTS 무음 응답 (라인 ${i})`);
    segments.push({ text: lines[i], audioPath: m4a, duration });
  }
  return segments;
}

// lines: string[] → [{ text, audioPath, duration }]
// 엔진 선택은 영상 단위로 한다 — 라인마다 엔진이 섞이면 한 영상 안에서 목소리가 바뀐다.
export async function synthesizeLines(lines, outDir, opts = {}) {
  const pad = opts.padSec ?? reel.linePadSec;
  const rate = opts.rate || reel.rate;
  const key = process.env.GOOGLE_TTS_API_KEY;
  const engine = process.env.TTS_ENGINE || (key ? 'google' : 'say');

  if (engine === 'google' && key) {
    try {
      const segs = await synthWithGoogle(lines, outDir, {
        pad,
        key,
        voice: process.env.TTS_VOICE_GOOGLE || GOOGLE_DEFAULT_VOICE,
        speed: Number(process.env.TTS_SPEED || 1.05),
      });
      if (segs.length) return segs;
      throw new Error('빈 결과');
    } catch (e) {
      // 네트워크·할당량 문제로 발행이 멈추면 안 되므로 로컬 엔진으로 폴백.
      console.warn(`[tts] Google 실패 → macOS say 폴백: ${e.message}`);
    }
  }

  const voice = opts.voice || (await resolveVoice(process.env.TTS_VOICE || undefined));
  const segments = await synthWithSay(lines, outDir, { pad, rate, voice });
  if (segments.length === 0) throw new Error('나레이션 라인이 비었습니다');
  return segments;
}
