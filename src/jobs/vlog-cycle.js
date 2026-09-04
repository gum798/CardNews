// 하나의 일상 포스트(사진 + 글) 생성 → 텔레그램 전송. **자동 발행하지 않는다.**
// 사람이 보고 판단한 뒤 직접 올린다. 발행 단계가 없어 정책 리스크가 사실상 0이다.
//
// 뉴스는 나레이션 릴스, 일상은 인스타 피드 사진 포스트로 형식을 완전히 나눈다.
//
// 실행: VLOG_SLOT=day node src/jobs/vlog-cycle.js
// launchd: com.cardnews.vlog.plist (낮 13시 / 저녁 21시)
//
// 일정이 있는 날(out/schedule/YYYYMMDD.json, slot이 맞을 때): 소재 풀 대신 그날의 동선을 쓴다.
//   정거장마다 Pexels에서 실제 장소 사진을 섭외해(src/vlog/scout.js) 장소 레퍼런스로 붙이고,
//   사진마다 장소·프레이밍·구도를 그 정거장에 맞춘다. VLOG_SCHEDULE=경로 로 직접 지정할 수도 있다.
import { Bot, InputFile, InputMediaBuilder } from 'grammy';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadPost, savePost, reviewText, reviewKeyboard } from '../vlog/review.js';
import { existsSync } from 'node:fs';
import { writeVlogPost } from '../curator/vlog.js';
import { generateImage, scenePrompt, COMPOSITION_SETS, compositionsForPlace, distancePlanFor, pickComposition, COMPOSITION_DISTANCE, venueOf, probeCloudflare } from '../persona/image.js';
import { scheduleFor, loadSchedule, scoutSchedule, sendScoutReport, isNightStop } from '../vlog/scout.js';
import { anchorPath, recentVlogPhoto } from '../persona/keyframe.js';
import { inspectImage } from '../persona/qc.js';
import { applyDepthBlur, SIGNAGE_PLACES } from '../persona/depth.js';
import { hana, outfitsForBand, everydayExpression, hairstyleFor, currentStageIndex } from '../persona/hana.js';
import { planPhotos, remaining, summary as neuronSummary } from '../persona/budget.js';
import { seasonNoteFor } from '../weather/seoul.js';
import { paths, telegram, cloudflare } from '../config.js';
import { setMeta } from '../db/index.js';

// 같은 날 같은 슬롯이면 항상 같은 순서 — 재실행해도 결과가 튀지 않는다.
// ⚠️ 단순 h*31 해시는 시드가 한 글자만 다르면 결과가 거의 안 바뀐다.
//    (날짜 시드가 딱 그런 형태라 실제로 일주일 내내 같은 구도가 나왔다)
//    FNV-1a + 눈사태 믹서로 작은 입력 차이가 출력 전체를 바꾸게 한다.
function hashSeed(seed) {
  let h = 0x811c9dc5;
  for (const c of String(seed)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // 눈사태(avalanche)
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function shuffleWithSeed(arr, seed) {
  let h = hashSeed(seed);
  const next = () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return h;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function postId(slot) {
  // VLOG_DATE=YYYYMMDD로 다른 날짜의 게시물을 미리 만들 수 있다.
  // (검토 대기 게시물이 있으면 그날 자동 실행이 건너뛰므로 충돌하지 않는다)
  if (/^\d{8}$/.test(process.env.VLOG_DATE || '')) return `vlog-${process.env.VLOG_DATE}-${slot}`;
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `vlog-${stamp}-${slot}`;
}

// 브이로그 목표 장수. 실제 장수는 남은 뉴런에 따라 이보다 줄 수 있다.
const PHOTO_TARGET = 5;

async function main() {
  const slot = process.env.VLOG_SLOT === 'evening' ? 'evening' : 'day';
  const id = postId(slot);
  console.log(`[vlog] start slot=${slot} id=${id}`);

  // 그날의 동선. VLOG_SCHEDULE=경로 가 우선, 없으면 out/schedule/YYYYMMDD.json(슬롯이 맞을 때).
  const schedule = process.env.VLOG_SCHEDULE ? loadSchedule(process.env.VLOG_SCHEDULE) : scheduleFor(id.split('-')[1], slot);
  if (schedule) console.log(`[vlog] 일정: 「${schedule.title || ''}」 정거장 ${schedule.stops.length}곳 (${schedule.file || 'out/schedule'})`);

  // 같은 슬롯에 검토 대기 중인 게시물이 이미 있으면 자동 실행은 건너뛴다.
  // 수동으로 만들어 둔 브이로그(소재 지정)를 20시 크론이 덮어쓰는 사고 방지.
  // 소재(VLOG_THEME)나 일정(VLOG_SCHEDULE)을 명시한 수동 실행은 의도적 재생성이므로 통과시킨다.
  if (!process.env.VLOG_THEME && !process.env.VLOG_SCHEDULE) {
    const existing = loadPost(id);
    if (existing && existing.status === 'pending') {
      console.log('[vlog] 이미 검토 대기 중인 게시물이 있음 → 건너뜀 (' + existing.theme + ')');
      return;
    }
  }

  // ⚠️ 글부터 쓰고 사진을 뽑다가 뉴런이 떨어지면 글값(claude 호출)만 버리고 끝난다.
  //    남은 예산을 먼저 재서 몇 장까지 가능한지 정한 뒤 그만큼만 만든다.
  //    실측(8/20): 뉴스 발행이 하루치를 먼저 먹어 브이로그 5장이 전원 실패하고 작업이 죽었다.
  const accountCount = cloudflare.accounts.length || 1;
  // 장부만 믿지 않는다 — 실측(09/04) 장부는 12,794 남았다는데 두 계정 다 429였다.
  // 계정마다 10뉴런짜리 탐침을 쏴서 살아 있는지 확인하고 장부에 반영한 뒤 계획한다.
  await probeCloudflare({ log: console.log });
  const plan = planPhotos(cloudflare.imageModel, PHOTO_TARGET, { accountCount, refs: 1 });
  if (plan.affordable === 0) {
    console.warn(
      `[vlog] 뉴런 부족으로 건너뜀 — 남은 ${remaining(accountCount)} (${neuronSummary(accountCount)}) / 1장당 ${plan.per}. ` +
        '00:00 UTC(KST 09:00) 초기화 후 다시 시도한다.'
    );
    return;
  }
  if (plan.affordable < plan.wanted) {
    console.warn(`[vlog] 뉴런이 빠듯해 ${plan.wanted}장 → ${plan.affordable}장으로 줄인다 (남은 ${remaining(accountCount)}, ${neuronSummary(accountCount)})`);
  }

  // 촬영지 섭외 — 정거장마다 실제 장소 사진(Pexels)을 구한다. 뉴런은 안 쓴다(원격 검색 + Vision).
  // 이미 섭외한 날은 out/scout/YYYYMMDD/scout.json을 그대로 쓴다.
  const scout = schedule ? await scoutSchedule(schedule, { log: console.log }) : null;
  const stopOf = new Map((scout?.stops || []).map((st) => [st.key, st]));

  // VLOG_THEME으로 오늘 소재를 지정할 수 있다(수동 실행). 장소는 소재가 정한다.
  // 일정이 있으면 소재·장소·상황은 일정에서 온다(VLOG_THEME은 무시).
  const post = await writeVlogPost(slot, { theme: process.env.VLOG_THEME || undefined, placeSeed: id, schedule });
  post.photos = post.photos.slice(0, plan.affordable);
  // 사진 i의 장소. 일정이 없으면 게시물 장소 하나.
  const placeAt = (i) => post.photos[i]?.place || post.place;
  const stopAt = (i) => (post.photos[i]?.stop ? stopOf.get(post.photos[i].stop) : null) || null;
  console.log(`[vlog] 소재: ${post.theme} / 장소: ${post.place} / 사진 ${post.photos.length}장`);
  if (post.stops) console.log(`[vlog] 정거장별 사진: ${post.photos.map((ph, i) => `${i + 1}.${ph.stop}(${ph.place})`).join(' ')}`);
  console.log(`[vlog] 날씨: ${post.weather.label} ${post.weather.tempC}도 (${post.weather.source})`);
  console.log(`[vlog] 뉴런: 남은 ${remaining(accountCount)} (${neuronSummary(accountCount)}) / 예상 소모 ${plan.per * post.photos.length}`);

  const outDir = path.join(paths.out, id);
  await mkdir(outDir, { recursive: true });

  // 사진 생성. 앵커를 첨부해 같은 사람을 유지하고, 구도·조명을 바꿔 다른 컷처럼 보이게 한다.
  // 매번 같은 "책상 앞 반신"이면 계정 전체가 한 장짜리처럼 보인다.
  // 슬롯마다 구도 세트를 다르게 두고, 그 안에서 날짜 시드로 섞는다.
  const anchor = anchorPath();
  // 장소 레퍼런스 사진이 있으면 앵커와 함께 붙인다. 실제 공간을 재현하려면 글만으로는 안 된다.
  // 장소 레퍼런스는 1장(문자열) 또는 여러 장(배열). Gemini 첨부 한도(4장) 안에서 앵커와 함께 붙인다.
  // ⚠️ 신원 레퍼런스를 둘 주면 얼굴이 나아지는 게 아니라 두 번째 사진의 배경·의상이
  //    통째로 끌려온다(실측: 바닷가 소재인데 방 안 수건 차림이 나왔다).
  //    얼굴 흔들림은 레퍼런스를 늘려서가 아니라 표정 지시로 잡는다.
  // 일정이 있는 날은 정거장마다 섭외 사진이 장소 레퍼런스다. 섭외를 못 한 정거장은 기존 placeRefs로.
  const refsFor = (i) => {
    const st = stopAt(i);
    const scouted = st?.file && existsSync(st.file) ? [st.file] : [];
    const placeRefList = scouted.length
      ? scouted
      : [hana.placeRefs?.[placeAt(i)] || []].flat().map((p) => path.join(paths.root, p)).filter((p) => existsSync(p));
    return [anchor, ...placeRefList].filter(Boolean).slice(0, 4);
  };
  // 게시물 단위로 복장 하나를 고정한다. looks.daily는 열려 있어서 그대로 두면
  // 같은 끼니인데 장마다 다른 옷이 나온다.
  // 기온대에 맞는 풀에서 하나를 뽑는다. 8월에 후디를 입고 있으면 그 자체로 가짜 티가 난다.
  // 밤 방 소재는 잠자리 차림, 그 외엔 낮 외출복 풀에서 뽑는다.
  const nightHome = hana.themeTimes?.[post.theme] === 'night' && post.place === 'room';
  const pool = outfitsForBand(post.weather.band);
  // ⚠️ VLOG_OUTFIT으로 그날 옷을 지정할 수 있다. 두 페르소나 대화에서 친구가 옷을
  //    골라준 날처럼, 이야기가 옷을 정해버린 경우에 쓴다. 안 주면 기존대로 기온대 풀에서 뽑는다.
  const outfit =
    process.env.VLOG_OUTFIT ||
    // 헬스장 계열은 전부 운동복. gymMassage를 빠뜨리면 스트레칭 코너에 원피스를 입고 앉는다.
    (post.place === 'gym' || post.place === 'gymMassage'
      ? hana.appearance.gymwear
      : nightHome
        ? hana.appearance.sleepwearByBand[post.weather.band] || pool[0]
        : pool[hashSeed(id) % pool.length]);
  // 머리는 게시물 하나에 하나. 매일 다르되 그날 안에서는 안 바뀐다.
  const hairstyle = hairstyleFor(id);

  // 방에서는 세 번째 컷만 플래시(밤 감성). 밖에서는 전부 낮 혼합광 —
  // feedWindow/feedFlash가 「그녀의 방」·「밤」을 전제해서 장소 묘사와 싸운다.
  // 밤 소재면 방 컷도 밤 프레이밍으로. 마지막 컷만 플래시로 변주를 준다.
  const isNight = hana.themeTimes?.[post.theme] === 'night';
  // 야외 장소는 하늘 상태가 조명을 정한다. 흐림·비면 골든아워 프레이밍을 쓸 수 없다.
  const forcedFor = (place) => {
    const f = hana.placeFramings?.[place];
    return f === 'feedOutdoorGolden' && (post.weather.sky === 'overcast' || post.weather.sky === 'rain') ? 'feedOutdoorOvercast' : f;
  };
  const forced = forcedFor(post.place);
  // 일정이 있는 날은 사진마다 정거장의 장소·시각으로 프레이밍을 정한다.
  // ⚠️ feedPublicNight는 「해 뜨기 전 + 형광등」이라 저녁 식당·카페·밤거리와 맞지 않는다.
  //    저녁 정거장은 실내면 feedIndoorNight, 야외면 feedOutdoorNight.
  const framingFor = (i) => {
    const place = placeAt(i);
    const key = post.photos[i]?.stop;
    // 일정 원본 정거장을 먼저 본다 — 작성자의 night 명시는 거기에만 확실히 있다.
    const st = schedule?.stops?.find((x) => x.key === key) || stopAt(i) || post.stops?.find((x) => x.key === key);
    const night = st ? isNightStop(st, schedule) : isNight;
    const f = forcedFor(place);
    if (f) return f;
    if (place === 'room') return night ? 'feedNight' : 'feedWindow';
    if (night) return venueOf(place) === 'outdoor' ? 'feedOutdoorNight' : 'feedIndoorNight';
    return 'feedPublic';
  };
  const framings = forced
    ? [forced, forced, forced]
    : post.place === 'room'
      ? isNight
        ? ['feedNight', 'feedNight', 'feedFlash']
        : ['feedWindow', 'feedWindow', 'feedFlash']
      : isNight
        ? ['feedPublicNight', 'feedPublicNight', 'feedPublicNight']
        : ['feedPublic', 'feedPublic', 'feedPublic'];
  // 첫 장에는 얼굴이 있어야 한다 — 피드 썸네일에 얼굴이 걸려야 하기 때문이다.
  // ⚠️ 다만 「반드시 셀카」로 묶어뒀더니 6일치 첫 컷이 전부 같은 정면 셀카였다(실측).
  //    얼굴이 보이는 건 유지하되 셀카 말고 다른 사람이 찍어준 컷도 섞는다.
  //    candidSide는 3/4 측면이라 얼굴이 살아 있고, 셀카가 아니라 그림이 확 달라진다.
  const set = COMPOSITION_SETS[slot] || COMPOSITION_SETS.day;
  // 장소 종류에 맞는 구도만 남긴다(집 전용 구도는 밖에서 빼고, 넓은 곳에서만 와이드를 허용).
  const first = compositionsForPlace(set.first, placeAt(0));
  const restFor = (i) => compositionsForPlace(set.rest, placeAt(i));
  const rest = restFor(0);
  // ⚠️ 예전에는 구도 키만 섞었다. 그래서 키가 5개 다 달라도 전부 팔 길이 셀카일 수 있었고,
  //    실제로 이케아 5장이 정확히 그렇게 나왔다(2026-08-31). 이제 거리를 먼저 정하고
  //    그 거리에 맞는 구도를 뽑는다 — 가까움/넓음/중간/디테일이 한 게시물 안에 반드시 섞인다.
  // ⚠️ 이름 주의: 이 스코프에는 이미 planPhotos()의 plan과 outfitsForBand()의 pool이 있다.
  // 일정이 있는 날은 장소가 사진마다 다르므로 거리·구도 풀도 그 사진의 장소로 본다.
  const distPlan = post.stops
    ? post.photos.map((_, i) => distancePlanFor(placeAt(i), post.photos.length)[i])
    : distancePlanFor(post.place, post.photos.length);
  const shuffledPool = shuffleWithSeed(rest, id);
  const compositions = [];
  for (let i = 0; i < post.photos.length; i++) {
    // 1번은 피드 썸네일이라 얼굴이 커야 한다 — first 풀에서 뽑는다.
    const compPool = i === 0 ? shuffleWithSeed(first, id) : post.stops ? shuffleWithSeed(restFor(i), id) : shuffledPool;
    compositions.push(pickComposition(placeAt(i), distPlan[i], compositions, compPool));
  }
  console.log(`[vlog] 구도 계획: ${compositions.map((c, i) => `${i + 1}.${c}(${distPlan[i]})`).join(' ')}`);
  const files = [];
  const shot = []; // files[k]가 몇 번째 계획 컷인가 — 실패한 컷이 있으면 files와 photos 인덱스가 어긋난다
  const dists = []; // 앵커 대비 얼굴 거리 — 정렬용(차단용 아님)
  const flagged = []; // 검수에 걸린 컷 — 파일은 남기되 기본 미선택으로 보낸다
  for (let i = 0; i < post.photos.length; i++) {
    const ph = post.photos[i];
    const out = path.join(outDir, `photo-${i + 1}.png`);
    const build = (attempt) =>
      scenePrompt(hana, {
        look: ph.look,
        composition: compositions[i],
        // 거리를 넘겨야 배경 심도·장소 소개문·체형 문장이 넓은 컷에 맞게 바뀐다.
        distance: COMPOSITION_DISTANCE[compositions[i]] || '',
        scene: ph.action,
        framing: post.stops ? framingFor(i) : framings[i % framings.length],
        place: placeAt(i),
        // 섭외 사진이 붙는 컷엔 그 사진이 어떤 장소인지(Pexels 설명문) 한 줄 덧붙인다.
        placeNote: stopAt(i)?.credit?.alt || '',
        // 머리는 게시물 단위로 고정(한 시간 사이에 바뀌면 이상하다), 옷도 마찬가지.
        styling: ph.look === 'daily' ? `${outfit}, ${hairstyle}` : hairstyle,
        // ⚠️ 표정을 소재에만 맡기면 26개 중 22개가 빈 문자열이라 매일 같은 무표정이 나온다
        //    (실측: 6일치 첫 컷이 전부 같은 얼굴). 소재가 정한 표정은 그날의 감정 비트라
        //    첫 컷에 쓰고, 나머지 컷은 일상 표정 풀에서 컷마다 다르게 뽑는다.
        expression: i === 0 && post.expression ? post.expression : everydayExpression(`${id}-${i}`),
        seasonNote: seasonNoteFor(post.weather.band, placeAt(i)),
        withReference: Boolean(anchor),
        // 재시도는 시드를 바꿔야 같은 결함이 그대로 재현되지 않는다.
        seed: attempt ? `${id}-${i}-r${attempt}` : `${id}-${i}`,
      });
    try {
      let verdict;
      // 해부학 결함(팔 3개 등)은 시드를 바꾸면 대개 사라진다 → 1회만 다시 뽑는다.
      // ⚠️ 9b는 장당 1,416뉴런 — 재시도 한 번이 4b 아홉 장 값이다. 1회만 다시 뽑는다.
      for (let attempt = 0; attempt <= 1; attempt++) {
        // ⚠️ 디테일 컷에는 앵커(얼굴 크롭)를 붙이지 않는다. 프레임에 얼굴이 없어야 하는데
      //    얼굴 사진을 레퍼런스로 주면 모델이 그 얼굴을 그려 넣는다(실측 2026-08-31).
      //    장소 레퍼런스만 남긴다 — 신원은 이 컷에서 지킬 게 없다.
      // 디테일 컷은 레퍼런스를 아예 붙이지 않는다. 앵커는 얼굴을 불러오고,
      // 장소 레퍼런스는 넓은 장면이라 카메라를 뒤로 빼게 만든다(실측).
      const shotRefs = COMPOSITION_DISTANCE[compositions[i]] === 'detail' ? [] : refsFor(i);
      await generateImage(build(attempt), { outPath: out, refImages: shotRefs });
        verdict = await inspectImage(out, shotRefs.includes(anchor) ? anchor : null, { distance: COMPOSITION_DISTANCE[compositions[i]] || '' });
        if (verdict.ok) break;
        if (attempt < 1) console.warn(`[vlog] 사진 ${i + 1} 검수 실패(${verdict.reason}) → 재생성`);
      }
      // 간판·상품명이 많은 장소는 배경 심도를 넣어 깨진 한글을 지운다.
      // 검수·거리 측정이 끝난 뒤에 적용한다(블러가 얼굴 거리에 영향을 주지 않게).
      // ⚠️ 넓은·중간 컷은 프롬프트가 딥포커스로 「장소가 읽히게」 요청한 컷이다. 여기에 기본 심도를
      //    그대로 걸면 그 지시를 후처리가 도로 지워 로비·골목이 색 덩어리로 돌아간다(리뷰에서 잡힘).
      //    글자만 뭉개지고 공간 구조는 남도록 시그마를 낮춘다. 가까운·디테일 컷은 그대로.
      if (SIGNAGE_PLACES.has(placeAt(i))) {
        const d = COMPOSITION_DISTANCE[compositions[i]] || '';
        await applyDepthBlur(out, d === 'wide' || d === 'medium' ? { far: 4, near: 1.2 } : {});
      }
      files.push(out);
      shot.push(i);
      dists.push(verdict?.stats?.faceDist ?? null);
      if (verdict && !verdict.ok) {
        flagged.push(i);
        console.warn(`[vlog] 사진 ${i + 1} 재생성 후에도 ${verdict.reason} → 미선택으로 표시`);
      } else {
        console.log(`[vlog] 사진 ${i + 1} 생성`);
      }
    } catch (e) {
      console.warn(`[vlog] 사진 ${i + 1} 실패: ${e.message.slice(0, 120)}`);
    }
  }
  if (files.length === 0) throw new Error('사진을 한 장도 만들지 못했습니다');

  // 텔레그램 전송 — 검토용. 승인 버튼을 눌러야 인스타에 올라간다.
  //
  // 인스타 API에는 초안·비공개·예약 게시가 없다(컨테이너를 안 올리면 앱에서 보이지도 않고
  // 24시간 뒤 만료된다). 그래서 "올려두고 나중에 공개" 대신 "승인 전까지 아예 안 올림"으로 간다.
  // 검토 목적으로는 이쪽이 더 안전하다 — 잘못 나간 글이 잠깐이라도 노출될 일이 없다.
  const bot = new Bot(telegram.botToken);
  const caption = [post.caption, '', post.hashtags.join(' ')].filter(Boolean).join('\n');

  // 섭외 보고(어느 사진을 배경으로 썼나 + Pexels 크레딧)는 새로 섭외한 날에만 보낸다.
  // 같은 날 다시 만들면 섭외는 캐시라 보고도 되풀이하지 않는다.
  if (scout?.fresh) {
    try {
      await sendScoutReport(bot, scout);
    } catch (e) {
      console.warn(`[vlog] 섭외 보고 실패(계속): ${String(e.message).slice(0, 120)}`);
    }
  }

  // 얼굴이 앵커에 가까운 순으로 정렬한다. 검수를 통과해도 신원이 흔들린 컷이 섞이는데,
  // 그걸 자동으로 버리기엔 지표가 부정확하다(정상 컷 사이에서도 0.4 넘게 벌어진다).
  // 대신 앞쪽에 좋은 컷을 모아 고르는 부담을 줄인다. 거리를 못 잰 컷은 뒤로 보낸다.
  // ⚠️ 예전엔 앵커 대비 얼굴 거리순으로 재정렬했다. 그런데 얼굴이 없거나 작은 컷
  //    (와이드·디테일)은 거리를 못 재 Infinity가 되어 항상 맨 뒤로 밀렸다.
  //    즉 위에서 애써 세운 거리 계약을 정렬이 도로 무너뜨리고, 앞쪽엔 셀카만 남았다.
  //    이제 계획 순서를 그대로 지킨다 — 1번 얼굴, 2번 넓게… 가 그대로 보인다.
  //    검수에 걸린 컷만 뒤로 보낸다(파일은 남기고 기본 미선택).
  // ⚠️ i는 계획 컷 번호(shot[k])다 — files 위치 k가 아니다. 컷 하나가 실패하면 둘이 어긋나서
  //    flagged·photoStops가 엉뚱한 사진에 붙었다(리뷰에서 잡힘).
  const order = files
    .map((f, k) => ({ f, i: shot[k], d: dists[k] ?? Infinity, bad: flagged.includes(shot[k]) }))
    .sort((a, b) => a.bad - b.bad || a.i - b.i);
  const sortedFiles = order.map((o) => o.f);
  const sortedFlagged = order.map((o, k) => (o.bad ? k : -1)).filter((k) => k >= 0);

  // 승인 시 발행할 내용을 남겨둔다. 사진 선택·글 수정은 텔레그램에서 한다.
  // ⚠️ 나중에 「어느 장소·옷·구도가 실제로 반응이 좋았나」를 세려면 지금 남겨야 한다.
  //    54건이 쌓이는 동안 place를 안 남겨서 소급 집계가 불가능했다(2026-09-03 확인).
  //    발행 후 인스타 인사이트와 이어붙일 키도 함께 남긴다.
  const record = savePost({
    id,
    place: post.place,
    theme: post.theme,
    // 살아남은 컷 순서(files)에 맞춰 남긴다 — 계획 5장 중 1장이 실패하면 4개가 된다.
    compositions: order.map((o) => compositions[o.i]),
    distances: order.map((o) => COMPOSITION_DISTANCE[compositions[o.i]] || ''),
    hairstyle,
    weatherBand: post.weather?.band ?? null,
    // 어느 얼굴로 만들었나. 릴스 자격(review.reelEligible)이 이걸 본다 — 시기가 바뀐 뒤
    // 옛 얼굴 사진이 릴스에 섞이지 않게. 없는 옛 파일은 날짜로 되짚는다(STAGE_HISTORY).
    stage: currentStageIndex(),
    phase: process.env.PERSONA_PHASE || 'before',
    slot,
    caption,
    // 일정이 있던 날: 어느 정거장·어느 섭외 사진으로 만들었나. 나중에 「배경 사진을 붙인 날이
    // 반응이 좋았나」를 세려면 지금 남겨야 한다. photos[i].stop으로 컷 ↔ 정거장이 이어진다.
    ...(post.stops
      ? {
          schedule: post.schedule,
          stops: post.stops.map((st) => ({ ...st, credit: stopOf.get(st.key)?.credit || null, ref: stopOf.get(st.key)?.file || null })),
          photoStops: order.map((o) => post.photos[o.i]?.stop || null),
        }
      : {}),
    files: sortedFiles,
    outfit, // 나중에 컷을 더 붙일 때 같은 옷을 쓰려면 남겨둬야 한다
    // ⚠️ 기본값은 「전부 해제」다(2026-09-03 사용자 결정). 쓸 사진만 체크해서 고른다.
    //    예전엔 검수 통과분을 미리 켜뒀는데, 그러면 「빼는」 작업이 되어 실수로 안 뺀 컷이
    //    같이 나간다. 고르는 쪽이 안전하다 — 체크한 것만 영상에 들어간다.
    selected: sortedFiles.map(() => false),
    // 검수(macOS Vision)에 걸린 컷 번호. 기본이 전부 해제라 「미선택 = 실패」 신호가
    // 사라졌으므로, 어느 컷이 걸렸는지 따로 남겨 검토 화면에 표시한다.
    flagged: sortedFlagged,
    status: 'pending',
  });

  // 앨범으로 보내되 각 장에 번호를 달아 어느 게 몇 번인지 알 수 있게 한다.
  if (sortedFiles.length === 1) {
    await bot.api.sendPhoto(telegram.chatId, new InputFile(sortedFiles[0]), { caption: '1' });
  } else {
    await bot.api.sendMediaGroup(
      telegram.chatId,
      sortedFiles.map((f, i) => InputMediaBuilder.photo(new InputFile(f), { caption: `${i + 1}` }))
    );
  }

  const msg = await bot.api.sendMessage(telegram.chatId, reviewText(record), {
    reply_markup: reviewKeyboard(record),
  });
  // 나중에 이 메시지를 갱신하려면 id가 필요하다(사진 토글·글 수정 반영).
  record.reviewMessageId = msg.message_id;
  savePost(record);

  setMeta(`vlog_last:${slot}`, new Date().toISOString());
  console.log('[vlog] 텔레그램 전송 완료');
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[vlog] fatal:', err);
    try {
      const bot = new Bot(telegram.botToken);
      await bot.api.sendMessage(
        telegram.chatId,
        `⚠️ 일상 포스트 생성 실패\n${String(err.message).slice(0, 300)}`
      );
    } catch {}
    process.exit(1);
  });
