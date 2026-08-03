// Google Cloud Text-to-Speech (ko-KR). 라인 하나 → WAV Buffer.
// Chirp3-HD는 한국어 전용 뉴럴 음성으로 macOS `say`(유닛선택)보다 억양·외래어 처리가 낫다.
// 자막 싱크는 ffprobe로 길이를 재서 맞추므로 타임포인트 API(v1beta1)는 필요 없다.
const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

export const DEFAULT_VOICE = 'ko-KR-Chirp3-HD-Aoede';

// 사용 가능한 ko-KR 음성 목록 (키 검증 겸용).
export async function listVoices(key) {
  const res = await fetch(`https://texttospeech.googleapis.com/v1/voices?languageCode=ko-KR`, {
    headers: { 'X-Goog-Api-Key': key },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`voices ${res.status}: ${JSON.stringify(body.error?.message || body).slice(0, 200)}`);
  }
  return (body.voices || []).map((v) => ({ name: v.name, gender: v.ssmlGender }));
}

// 한 줄 합성 → WAV(LINEAR16, RIFF 헤더 포함) Buffer.
// 일시적 오류(429/5xx)는 백오프 재시도, 인증·요청 오류는 즉시 throw(재시도해도 소용없음).
export async function synthOne(text, { voice = DEFAULT_VOICE, speed = 1.0, key } = {}) {
  if (!key) throw new Error('GOOGLE_TTS_API_KEY 없음');

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'X-Goog-Api-Key': key,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: 'ko-KR', name: voice },
          // Chirp3-HD는 pitch 미지원. speakingRate만 사용(0.25~2.0).
          audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000, speakingRate: speed },
        }),
        signal: AbortSignal.timeout(25_000),
      });

      if (res.status === 429 || res.status >= 500) throw new Error(`retryable ${res.status}`);
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw Object.assign(new Error(`google tts ${res.status}: ${t.slice(0, 300)}`), { fatal: true });
      }

      const { audioContent } = await res.json();
      const buf = Buffer.from(audioContent || '', 'base64');
      if (buf.length < 1000) throw new Error('빈 오디오 응답');
      return buf;
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastErr;
}
