// 후보 1건 → 카드 카피 → 표지 사진 → 렌더 → 릴스 → R2 업로드 → IG 발행 → 텔레그램 보고.
// 수동 승인(bot-listener)과 자동 발행(hourly-collect)이 공유한다. 실패는 내부에서 잡아 보고.
import {
  getCandidate,
  getNewsItem,
  updateCandidateStatus,
  setCandidateCardJson,
  insertPublish,
} from './db/index.js';
import { writeCards, pickBackgroundImages } from './curator/index.js';
import { searchTopicImages, downloadImage, searchTopicVideos, downloadVideo } from './images/index.js';
import { renderCandidate, renderReelLines } from './renderer/index.js';
import { makeReel, makeNarratedReel, grabPoster, personaLayersFor } from './video/index.js';
import { animatePersona } from './video/hailuo.js';
import { synthesizeLines } from './tts/index.js';
import { scriptViolations, ADVICE_GUARD_PROMPT } from './guards/policy.js';
import { getReelKeyframes, publishKey } from './persona/keyframe.js';
import { uploadCandidate, uploadFile } from './storage/index.js';
import { checkPublishingLimit, publishCarousel, publishReel } from './publisher/index.js';
import { uploadShort } from './youtube/index.js';
import { report } from './bot/index.js';
import { dryRun, topics, paths, instagram, account, reel as reelCfg } from './config.js';
import { getMeta, setMeta } from './db/index.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// 훅 A/B: 발행마다 지목형/손실형을 번갈아 써서 어느 쪽이 저장·공유를 더 만드는지 비교한다.
// (조회수 대신 Studio의 '조회 선택 비율'로 판정 — 발행 후 수동 확인)
function nextHookType() {
  const n = Number(getMeta('hook_ab_counter') || 0);
  setMeta('hook_ab_counter', String(n + 1));
  return n % 2 === 0 ? '지목형' : '손실형';
}

export async function generateAndPublish(candidateId, { auto = false } = {}) {
  const tag = auto ? '자동 ' : '';
  try {
    const cand = getCandidate(candidateId);
    if (!cand) throw new Error('후보를 찾을 수 없음');
    updateCandidateStatus(candidateId, 'generating');

    // 1. 카드 데이터: evergreen 후보는 생성 시점에 card_json이 이미 있음 → writeCards 생략.
    let cardData;
    if (cand.card) {
      cardData = cand.card;
    } else {
      const n = getNewsItem(cand.news_item_id);
      const opts = {
        hookType: nextHookType(),
        scriptStyle: topics[cand.topic]?.scriptStyle || 'impact',
      };
      const news = { id: n.id, source: n.source, title: n.title, summary: n.summary, url: n.url };
      cardData = await writeCards(news, opts);

      // 민감 주제(건강·법률·재무·정치)에서 조언성 표현이 나오면 1회 재생성한다.
      // AI 생성 인물이 전문가처럼 조언하는 것으로 읽히면 유튜브 수익화가 막힌다.
      const bad = scriptViolations(cardData);
      if (bad.length) {
        console.warn(`[pipeline] 정책 가드: ${bad[0]} → 대본 재생성`);
        cardData = await writeCards(news, { ...opts, extraInstruction: ADVICE_GUARD_PROMPT });
        const still = scriptViolations(cardData);
        if (still.length) {
          throw new Error(`정책 가드 재생성 후에도 위반: ${still[0]}`);
        }
      }
    }
    // 캡션에 실물을 남긴다. 영상에서 "저장해두세요"라고 해놓고 캡션이 비면 거짓말이 된다.
    const sc = cardData.script;
    if (sc) {
      const extra = [];
      if (sc.checklist?.items?.length) {
        extra.push(`― ${sc.checklist.title} ―`, ...sc.checklist.items.map((i) => `· ${i}`));
      }
      if (sc.prompt) extra.push('', '― 복붙용 프롬프트 ―', sc.prompt);
      if (sc.shareCta) extra.push('', sc.shareCta);
      if (extra.length && !cardData.caption.includes(extra[0])) {
        cardData.caption = `${cardData.caption}\n\n${extra.join('\n')}`;
      }
    }
    cardData.theme = topics[cand.topic]?.theme || 'navy';
    setCandidateCardJson(candidateId, cardData);

    // 1b. 표지 배경 사진: Pixabay 후보 검색 → AI 관련성 선택(1회) → 어울리면 그 1장 다운로드.
    //     어울리는 게 없으면 사진 없이 그래픽 표지로. (전 과정 베스트에포트)
    const cover = cardData.cards.find((c) => c.type === 'cover');
    const reelBgs = []; // 릴스 배경용(여러 장). 첫 장은 표지 카드에도 쓴다.
    if (cover && cardData.imageKeywords) {
      const candidates = await searchTopicImages(cardData.imageKeywords);
      if (candidates.length > 0) {
        // 릴스는 배경이 바뀌어야 덜 지루하므로 여러 장을 고른다.
        const picks = await pickBackgroundImages(cover.card.headline, cover.card.category, candidates, 3);
        const outDir = path.join(paths.out, String(candidateId));
        await mkdir(outDir, { recursive: true });
        for (let k = 0; k < picks.length; k++) {
          const p = await downloadImage(candidates[picks[k]].url, path.join(outDir, `bg-${k}.jpg`));
          if (p) reelBgs.push('file://' + p);
        }
        if (reelBgs.length > 0) {
          cover.card.bg = reelBgs[0];
          console.log(`[pipeline] 배경 사진 ${reelBgs.length}장 선택 (후보 ${candidates.length}장 중 ${picks.join(',')})`);
        } else {
          console.log('[pipeline] 어울리는 배경 사진 없음 → 그래픽 배경');
        }
      }
    }

    // 2. 카드 렌더. 캐러셀을 끄면 4:5 카드는 만들지 않는다(릴스 프레임은 폴백·표지용으로 유지).
    const { cardPaths, reelFramePaths } = await renderCandidate(candidateId, cardData, {
      cards: instagram.carousel,
    });

    // 3. 릴스: 나레이션 + 번인 자막. 배경은 실사 영상 우선, 없으면 사진 켄번즈.
    //    대본/TTS 실패 시 구형 무음 슬라이드쇼로 폴백.
    let reelPath;
    let hookFrame = null; // 릴스 표지(썸네일)로 쓸 훅 프레임
    if (reelCfg.narrated && cardData.script) {
      try {
        const outDir = path.join(paths.out, String(candidateId));

        // 3a. 실사 영상 배경 (베스트에포트). 배경이 실제로 움직이면 정지 사진보다 이탈이 적다.
        let bgVideo = null;
        if (reelCfg.stockVideo && cardData.imageKeywords) {
          try {
            const vids = await searchTopicVideos(cardData.imageKeywords);
            if (vids.length > 0) {
              bgVideo = await downloadVideo(vids[0].url, path.join(outDir, 'bg.mp4'));
              if (bgVideo) console.log(`[pipeline] 실사 배경 영상 (${vids[0].duration}초, ${vids[0].width}x${vids[0].height})`);
            }
          } catch (e) {
            console.warn('[pipeline] 실사 영상 실패, 사진 배경 사용:', e.message);
          }
        }

        // 3b. 진행자 하나 (베스트에포트). 인트로/아웃트로에만 등장한다.
        // 발행마다 다른 그림이 나오도록 날짜·슬롯·주제를 키로 준다.
        // 키가 같으면(같은 발행의 재시도) 캐시가 먹어 그림이 튀지 않는다.
        const personaFrames = reelCfg.persona
          ? await getReelKeyframes({
              key: publishKey({ slot: new Date().getHours() < 12 ? 'am' : 'pm', topic: cand.topic }),
            })
          : null;

        // 훅도 낭독한다 → 0초부터 소리가 나고, 프레임과 오디오가 1:1로 맞는다.
        const narrationLines = [cardData.script.hook, ...cardData.script.lines];
        const segments = await synthesizeLines(narrationLines, path.join(outDir, 'audio'));
        // 인트로: 정지 사진 대신 실사 영상(Hailuo, 크레딧). 실패 시 null → 기존 컷아웃 방식.
        let introVideo = null;
        if (bgVideo && reelCfg.introVideo && personaFrames?.intro) {
          introVideo = await animatePersona(
            personaFrames.intro,
            path.join(outDir, 'intro-hana.mp4'),
            { duration: 6 }
          );
        }

        // 하나를 오려낼 수 있는지 렌더 전에 판정한다. 실패한 컷은 HTML이 기존 방식대로 그린다.
        const personaLayers = bgVideo
          ? await personaLayersFor(personaFrames, segments.map((s) => s.duration), { skipIntro: Boolean(introVideo) })
          : [];

        const lineFrames = await renderReelLines(candidateId, cardData.script, {
          theme: cardData.theme,
          bgs: reelBgs,
          account: account.name,
          aiNotice: 'AI 생성 콘텐츠',
          persona: personaFrames,
          // ffmpeg가 얹는 컷 + 인트로 영상으로 대체된 컷 — HTML은 둘 다 그리지 않는다.
          personaLayerImages: [
            ...personaLayers.map((l) => l.image),
            ...(introVideo ? [personaFrames.intro] : []),
          ],
          transparent: Boolean(bgVideo), // 영상 위에 얹으려면 투명 PNG
        });
        // 투명 오버레이(실사영상 배경)일 때는 배경이 없는 PNG라 표지로 못 쓴다 → 영상 첫 프레임을 뽑아 쓴다.
        hookFrame = bgVideo ? null : lineFrames[0];
        reelPath = await makeNarratedReel(candidateId, lineFrames, segments, { bgVideo, personaLayers, introVideo });
        console.log(
          `[pipeline] 나레이션 릴스 생성 (훅=${cardData.script.hookType}, 라인 ${segments.length}, ` +
            `배경=${bgVideo ? '실사영상' : reelBgs.length + '장 사진'})`
        );
      } catch (e) {
        console.error('[pipeline] 나레이션 릴스 실패 → 구형 슬라이드쇼로 폴백:', e.message);
        reelPath = null;
      }
    }
    if (!reelPath) reelPath = await makeReel(candidateId, reelFramePaths);

    // 4. 업로드
    const { cardUrls, reelUrl } = await uploadCandidate(candidateId, { cardPaths, reelPath });
    // 표지: 나레이션 릴스면 훅 프레임(실제 첫 화면), 아니면 구형 릴스 프레임.
    // 실사영상 배경이면 훅 프레임이 투명 PNG라 못 쓰므로 영상 1.0초 지점을 뽑아 표지로 만든다.
    const coverSrc = hookFrame || (await grabPoster(reelPath, path.join(paths.out, String(candidateId), 'poster.jpg'))) || reelFramePaths[0];
    const coverUrl = await uploadFile(`${candidateId}/cover.jpg`, coverSrc, 'image/jpeg');
    updateCandidateStatus(candidateId, 'uploaded');

    // 5. IG 발행 (베스트에포트 — 토큰 없거나 실패해도 유튜브는 계속). dryRun이면 합성 ID.
    let carouselId = null;
    let reelId = null;
    if (dryRun || instagram.accessToken) {
      try {
        await checkPublishingLimit();
        if (instagram.carousel) {
          carouselId = await publishCarousel(cardUrls, cardData.caption);
        } else {
          console.log('[pipeline] 캐러셀 비활성 → 릴스만 발행');
        }
        reelId = await publishReel(reelUrl, coverUrl, cardData.caption);
      } catch (e) {
        console.error('[pipeline] IG 발행 실패(유튜브는 계속):', e.message);
      }
    } else {
      console.log('[pipeline] IG 미설정 → 건너뜀 (유튜브만 발행)');
    }

    // 5b. 유튜브 쇼츠 업로드 (베스트에포트, 병렬 채널)
    let ytId = null;
    try {
      ytId = await uploadShort({
        videoPath: reelPath,
        title: cover?.card?.headline || '오늘의 뉴스',
        description: cardData.caption,
        tags: ['뉴스', '오늘의뉴스', '쇼츠', 'shorts'],
        categoryId: topics[cand.topic]?.ytCategory,
      });
    } catch (e) {
      if (e.authExpired) {
        await report({
          text:
            '🔴 유튜브 인증 만료 (invalid_grant)\n\n' +
            '업로드가 계속 실패합니다. 재발급이 필요합니다:\n' +
            '1) Cloud Console → Google Auth Platform → 대상 → 앱 게시\n' +
            '2) node scripts/youtube-auth.mjs 실행 후 .env의 YOUTUBE_REFRESH_TOKEN 교체\n' +
            '⚠️ 동의 화면의 채널 선택에서 반드시 「뉴스하나」를 고를 것',
        }).catch(() => {});
      } else if (e.wrongChannel) {
        // 업로드는 이미 됐다 — 되돌릴 수 없으므로 즉시 알려 지우게 한다.
        // 이걸 조용히 넘겨서 9건이 개인 채널에 쌓인 적이 있다.
        await report({
          text:
            '🔴 유튜브 업로드가 다른 채널로 갔습니다\n\n' +
            `${e.message}\n\n` +
            '토큰이 엉뚱한 채널에 묶여 있습니다. 고치는 법:\n' +
            '1) 위 영상을 해당 채널에서 삭제\n' +
            '2) node scripts/youtube-auth.mjs 실행\n' +
            '3) 채널 선택 화면에서 반드시 「뉴스하나」 선택\n' +
            '4) .env의 YOUTUBE_REFRESH_TOKEN 교체',
        }).catch(() => {});
      }
    }

    if (!carouselId && !reelId && !ytId) throw new Error('IG·유튜브 모두 발행 실패');
    insertPublish({ candidateId, igCarouselId: carouselId, igReelId: reelId });
    // DRY_RUN은 'published'로 남기면 안 된다 — countPublishedToday가 일일 한도를 잘못 채워
    // 정작 실제 발행 슬롯이 "한도 초과"로 건너뛰게 된다(실제로 그 사고가 났다).
    updateCandidateStatus(candidateId, dryRun ? 'dryrun' : 'published');

    // 6. 보고
    const lines = [];
    if (dryRun) {
      lines.push(`✅ ${tag}생성 완료 (DRY_RUN — 실제 게시 안 함)`);
    } else {
      lines.push(`✅ ${tag}발행 완료`);
      if (carouselId) lines.push(`📷 인스타 캐러셀: ${carouselId}`);
      if (reelId) lines.push(`🎬 인스타 릴스: ${reelId}`);
      if (ytId) {
        lines.push(`📺 유튜브: https://youtu.be/${ytId}`);
        lines.push(`⚙️ Studio 관리: https://studio.youtube.com/video/${ytId}/edit`);
      }
      if (!carouselId && !reelId) lines.push('ℹ️ 인스타 미설정 — 유튜브만 발행됨');
    }
    lines.push('', '📋 캡션 (복사용):', cardData.caption, '', `🎬 릴스 원본: ${reelUrl}`);
    // 보고는 베스트에포트: 이미 발행(YouTube 등)이 끝난 뒤라 텔레그램 실패가 발행 상태를 'failed'로
    // 뒤집으면 안 된다(뒤집히면 다음 정시 재시도에서 중복 업로드 발생). 미디어 전송이 끊기면 텍스트만이라도.
    try {
      await report({ text: lines.join('\n'), mediaPaths: cardPaths, videoPath: reelPath });
    } catch (e) {
      console.error('[pipeline] 텔레그램 미디어 보고 실패 → 텍스트만 재시도:', e.message);
      await report({ text: lines.join('\n') }).catch((e2) =>
        console.error('[pipeline] 텔레그램 텍스트 보고도 실패(발행은 성공):', e2.message)
      );
    }
    console.log(`[pipeline] ${tag}done candidate ${candidateId}${dryRun ? ' (DRY_RUN)' : ''}`);
    return { ok: true, carouselId, reelId, ytId };
  } catch (err) {
    updateCandidateStatus(candidateId, 'failed');
    insertPublish({ candidateId, error: err.message });
    await report({ text: `❌ ${tag}발행 실패 (후보 ${candidateId})\n${err.message}` }).catch(() => {});
    console.error(`[pipeline] failed ${candidateId}:`, err);
    return { ok: false, error: err.message };
  }
}
