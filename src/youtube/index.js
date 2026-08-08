// 유튜브 쇼츠 자동 업로드 (YouTube Data API v3, OAuth refresh_token).
// 베스트에포트: 자격증명 없음/실패해도 파이프라인은 계속 (IG가 주 채널). dryRun이면 합성 ID.
import { youtube as makeYoutube, auth as gauth } from '@googleapis/youtube';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { getMeta, setMeta } from '../db/index.js';
import { youtube as yt, dryRun } from '../config.js';

// 토큰 지문. refresh_token 자체를 저장하지 않으려고 해시만 쓴다.
// 재인증으로 토큰이 바뀌면 지문이 달라져 기록이 무효가 된다.
function tokenFingerprint() {
  return createHash('sha256').update(String(yt.refreshToken || '')).digest('hex').slice(0, 16);
}

// 이 토큰이 실제로 어느 채널에 묶여 있는지(관측된 값). 모르면 null.
function boundChannel() {
  try {
    const rec = JSON.parse(getMeta('yt_bound_channel') || 'null');
    return rec && rec.fp === tokenFingerprint() ? rec.channelId : null;
  } catch {
    return null;
  }
}

function rememberChannel(channelId) {
  if (!channelId) return;
  setMeta('yt_bound_channel', JSON.stringify({ fp: tokenFingerprint(), channelId }));
}

function client() {
  const oauth2 = new gauth.OAuth2(yt.clientId, yt.clientSecret);
  oauth2.setCredentials({ refresh_token: yt.refreshToken });
  return makeYoutube({ version: 'v3', auth: oauth2 });
}

// 세로 영상 + #Shorts → 유튜브가 쇼츠로 자동 인식. 업로드한 영상 id 반환 (실패 시 null).
export async function uploadShort({ videoPath, title, description, tags = [], categoryId = '25' }) {
  if (dryRun) {
    console.log('[youtube] DRY_RUN 업로드 생략:', title.slice(0, 30));
    return 'DRYRUN-YT-' + Date.now();
  }
  if (!yt.refreshToken) {
    console.log('[youtube] 자격증명 없음 → 업로드 건너뜀');
    return null;
  }

  // 사전 차단: 이 토큰이 엉뚱한 채널에 묶인 걸 이미 확인했다면 아예 올리지 않는다.
  // 응답을 보고 잡는 것만으로는 늦다 — 그때는 이미 남의 채널에 올라간 뒤다.
  // 토큰이 바뀌면(재인증) 지문이 달라져 자동으로 다시 시도한다.
  const known = boundChannel();
  if (yt.channelId && known && known !== yt.channelId) {
    console.warn(
      `[youtube] 토큰이 다른 채널(${known})에 묶여 있음 → 업로드 건너뜀. ` +
        `재인증 필요: node scripts/youtube-auth-manual.mjs`
    );
    return null;
  }

  try {
    const shortTitle = `${title} #Shorts`.slice(0, 100); // 제목 100자 제한
    const res = await client().videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: shortTitle,
          description: `${description}\n\n#Shorts`,
          tags,
          categoryId,
          defaultLanguage: 'ko',
        },
        status: {
          privacyStatus: 'public', // 심사 전 프로젝트는 유튜브가 강제로 비공개 처리
          selfDeclaredMadeForKids: false,
        },
      },
      media: { body: createReadStream(videoPath) },
    });
    const id = res.data.id;
    const channelId = res.data.snippet?.channelId;
    const privacy = res.data.status?.privacyStatus;

    // ⚠️ 토큰은 동의 화면에서 고른 채널에 묶인다. 재인증 때 다른 채널을 고르면
    //    업로드는 계속 "성공"하면서 엉뚱한 채널에 쌓인다 — 실제로 9건을 그렇게 날렸다.
    //    로그만 봐서는 절대 안 보이므로 응답의 channelId를 매번 대조한다.
    //    (channels.list는 readonly 스코프가 필요하지만 이 값은 업로드 응답에 그냥 들어있다)
    rememberChannel(channelId);

    if (yt.channelId && channelId && channelId !== yt.channelId) {
      throw Object.assign(
        new Error(
          `업로드가 엉뚱한 채널로 갔습니다.\n` +
            `기대: ${yt.channelId}\n실제: ${channelId}\n` +
            `영상: https://youtu.be/${id} (삭제 후 재인증 필요)`
        ),
        { wrongChannel: true, videoId: id, channelId }
      );
    }

    console.log(
      `[youtube] 업로드 완료: ${id}` +
        `${channelId ? ` (채널 ${channelId})` : ''}${privacy ? ` ${privacy}` : ''}`
    );
    return id;
  } catch (err) {
    // 채널 불일치는 우리가 던진 것 — 삼키면 안 된다. 그대로 올려 알림을 띄운다.
    if (err?.wrongChannel) throw err;
    const msg = String(err?.message || err);
    console.error('[youtube] 업로드 실패(계속 진행):', msg);
    // invalid_grant는 재시도해도 절대 낫지 않는다(토큰 만료·취소). 조용히 넘기면
    // 유튜브가 죽은 줄 모르고 며칠이 지나므로 즉시 알린다. 실제로 하루치를 날렸다.
    if (/invalid_grant/i.test(msg)) throw Object.assign(new Error(msg), { authExpired: true });
    return null;
  }
}

// 토큰이 살아있는지 사전 점검. 발행 전에 1회 호출해 죽었으면 알림을 띄운다.
export async function checkAuth() {
  if (dryRun || !yt.refreshToken) return { ok: true, skipped: true };
  try {
    const oauth2 = new gauth.OAuth2(yt.clientId, yt.clientSecret);
    oauth2.setCredentials({ refresh_token: yt.refreshToken });
    await oauth2.getAccessToken();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
