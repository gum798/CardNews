// 하나의 일상 포스트(사진 + 글) 생성 → 텔레그램 전송. **자동 발행하지 않는다.**
// 사람이 보고 판단한 뒤 직접 올린다. 발행 단계가 없어 정책 리스크가 사실상 0이다.
//
// 뉴스는 나레이션 릴스, 일상은 인스타 피드 사진 포스트로 형식을 완전히 나눈다.
//
// 실행: VLOG_SLOT=day node src/jobs/vlog-cycle.js
// launchd: com.cardnews.vlog.plist (낮 13시 / 저녁 21시)
import { Bot, InputFile, InputMediaBuilder } from 'grammy';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadPost, savePost, reviewText, reviewKeyboard } from '../vlog/review.js';
import { existsSync } from 'node:fs';
import { writeVlogPost } from '../curator/vlog.js';
import { generateImage, scenePrompt, COMPOSITION_SETS, compositionsForPlace } from '../persona/image.js';
import { anchorPath } from '../persona/keyframe.js';
import { inspectImage } from '../persona/qc.js';
import { hana, outfitsForBand } from '../persona/hana.js';
import { seasonNoteFor } from '../weather/seoul.js';
import { paths, telegram } from '../config.js';
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

async function main() {
  const slot = process.env.VLOG_SLOT === 'evening' ? 'evening' : 'day';
  const id = postId(slot);
  console.log(`[vlog] start slot=${slot} id=${id}`);

  // 같은 슬롯에 검토 대기 중인 게시물이 이미 있으면 자동 실행은 건너뛴다.
  // 수동으로 만들어 둔 브이로그(소재 지정)를 20시 크론이 덮어쓰는 사고 방지.
  // 소재를 명시(VLOG_THEME)한 수동 실행은 의도적 재생성이므로 통과시킨다.
  if (!process.env.VLOG_THEME) {
    const existing = loadPost(id);
    if (existing && existing.status === 'pending') {
      console.log('[vlog] 이미 검토 대기 중인 게시물이 있음 → 건너뜀 (' + existing.theme + ')');
      return;
    }
  }

  // VLOG_THEME으로 오늘 소재를 지정할 수 있다(수동 실행). 장소는 소재가 정한다.
  const post = await writeVlogPost(slot, { theme: process.env.VLOG_THEME || undefined });
  console.log(`[vlog] 소재: ${post.theme} / 장소: ${post.place} / 사진 ${post.photos.length}장`);
  console.log(`[vlog] 날씨: ${post.weather.label} ${post.weather.tempC}도 (${post.weather.source})`);

  const outDir = path.join(paths.out, id);
  await mkdir(outDir, { recursive: true });

  // 사진 생성. 앵커를 첨부해 같은 사람을 유지하고, 구도·조명을 바꿔 다른 컷처럼 보이게 한다.
  // 매번 같은 "책상 앞 반신"이면 계정 전체가 한 장짜리처럼 보인다.
  // 슬롯마다 구도 세트를 다르게 두고, 그 안에서 날짜 시드로 섞는다.
  const anchor = anchorPath();
  // 장소 레퍼런스 사진이 있으면 앵커와 함께 붙인다. 실제 공간을 재현하려면 글만으로는 안 된다.
  // 장소 레퍼런스는 1장(문자열) 또는 여러 장(배열). Gemini 첨부 한도(4장) 안에서 앵커와 함께 붙인다.
  const placeRefList = [hana.placeRefs?.[post.place] || []].flat();
  const refs = [
    anchor,
    ...placeRefList.map((p) => path.join(paths.root, p)).filter((p) => existsSync(p)),
  ].filter(Boolean).slice(0, 4);
  // 게시물 단위로 복장 하나를 고정한다. looks.daily는 열려 있어서 그대로 두면
  // 같은 끼니인데 장마다 다른 옷이 나온다.
  // 기온대에 맞는 풀에서 하나를 뽑는다. 8월에 후디를 입고 있으면 그 자체로 가짜 티가 난다.
  // 밤 방 소재는 잠자리 차림, 그 외엔 낮 외출복 풀에서 뽑는다.
  const nightHome = hana.themeTimes?.[post.theme] === 'night' && post.place === 'room';
  const pool = outfitsForBand(post.weather.band);
  const outfit =
    post.place === 'gym'
      ? hana.appearance.gymwear
      : nightHome
        ? hana.appearance.sleepwearByBand[post.weather.band] || pool[0]
        : pool[hashSeed(id) % pool.length];
  // 방에서는 세 번째 컷만 플래시(밤 감성). 밖에서는 전부 낮 혼합광 —
  // feedWindow/feedFlash가 「그녀의 방」·「밤」을 전제해서 장소 묘사와 싸운다.
  // 밤 소재면 방 컷도 밤 프레이밍으로. 마지막 컷만 플래시로 변주를 준다.
  const isNight = hana.themeTimes?.[post.theme] === 'night';
  // 야외 장소는 하늘 상태가 조명을 정한다. 흐림·비면 골든아워 프레이밍을 쓸 수 없다.
  let forced = hana.placeFramings?.[post.place];
  if (forced === 'feedOutdoorGolden' && (post.weather.sky === 'overcast' || post.weather.sky === 'rain')) {
    forced = 'feedOutdoorOvercast';
  }
  const framings = forced
    ? [forced, forced, forced]
    : post.place === 'room'
      ? isNight
        ? ['feedNight', 'feedNight', 'feedFlash']
        : ['feedWindow', 'feedWindow', 'feedFlash']
      : isNight
        ? ['feedPublicNight', 'feedPublicNight', 'feedPublicNight']
        : ['feedPublic', 'feedPublic', 'feedPublic'];
  // 첫 장은 반드시 셀카 — 피드 썸네일에 얼굴이 걸려야 한다.
  const set = COMPOSITION_SETS[slot] || COMPOSITION_SETS.day;
  // 밖에서 찍는 날엔 방 전용 구도(전신거울·방 전경)를 뺀다.
  const first = compositionsForPlace(set.first, post.place);
  const rest = compositionsForPlace(set.rest, post.place);
  const compositions = [shuffleWithSeed(first, id)[0], ...shuffleWithSeed(rest, id)];
  const files = [];
  const flagged = []; // 검수에 걸린 컷 — 파일은 남기되 기본 미선택으로 보낸다
  for (let i = 0; i < post.photos.length; i++) {
    const ph = post.photos[i];
    const out = path.join(outDir, `photo-${i + 1}.png`);
    const build = (attempt) =>
      scenePrompt(hana, {
        look: ph.look,
        composition: compositions[i % compositions.length],
        scene: ph.action,
        framing: framings[i % framings.length],
        place: post.place,
        styling: ph.look === 'daily' ? outfit : '',
        expression: post.expression || '',
        seasonNote: seasonNoteFor(post.weather.band, post.place),
        withReference: Boolean(anchor),
        // 재시도는 시드를 바꿔야 같은 결함이 그대로 재현되지 않는다.
        seed: attempt ? `${id}-${i}-r${attempt}` : `${id}-${i}`,
      });
    try {
      let verdict;
      // 해부학 결함(팔 3개 등)은 시드를 바꾸면 대개 사라진다 → 1회만 다시 뽑는다.
      for (let attempt = 0; attempt <= 1; attempt++) {
        await generateImage(build(attempt), { outPath: out, refImages: refs });
        verdict = await inspectImage(out);
        if (verdict.ok) break;
        if (attempt === 0) console.warn(`[vlog] 사진 ${i + 1} 검수 실패(${verdict.reason}) → 재생성`);
      }
      files.push(out);
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

  // 승인 시 발행할 내용을 남겨둔다. 사진 선택·글 수정은 텔레그램에서 한다.
  const record = savePost({
    id,
    slot,
    theme: post.theme,
    caption,
    files,
    outfit, // 나중에 컷을 더 붙일 때 같은 옷을 쓰려면 남겨둬야 한다
    // 검수에 걸린 컷은 기본 미선택 — 사람이 보고 살릴 수도 있게 파일은 남긴다.
    selected: files.map((_, i) => !flagged.includes(i)),
    status: 'pending',
  });

  // 앨범으로 보내되 각 장에 번호를 달아 어느 게 몇 번인지 알 수 있게 한다.
  if (files.length === 1) {
    await bot.api.sendPhoto(telegram.chatId, new InputFile(files[0]), { caption: '1' });
  } else {
    await bot.api.sendMediaGroup(
      telegram.chatId,
      files.map((f, i) => InputMediaBuilder.photo(new InputFile(f), { caption: `${i + 1}` }))
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
