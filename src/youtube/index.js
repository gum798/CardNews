// 유튜브 쇼츠 자동 업로드 (YouTube Data API v3, OAuth refresh_token).
// 베스트에포트: 자격증명 없음/실패해도 파이프라인은 계속 (IG가 주 채널). dryRun이면 합성 ID.
import { youtube as makeYoutube, auth as gauth } from '@googleapis/youtube';
import { createReadStream } from 'node:fs';
import { youtube as yt, dryRun } from '../config.js';

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
    console.log('[youtube] 업로드 완료:', id);
    return id;
  } catch (err) {
    console.error('[youtube] 업로드 실패(계속 진행):', err?.message || err);
    return null;
  }
}
