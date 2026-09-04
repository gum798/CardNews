// 촬영지 섭외 — 그날 일정(out/schedule/YYYYMMDD.json)의 정거장마다 배경 사진을 구해 온다.
//
// 왜 필요한가(2026-09-04 사용자 요청): 「저녁·극장·카페·테이크아웃 커피·산책길 장소를 사진으로
//   검색해 촬영장소를 섭외하고, 그 배경사진으로 브이로그 이미지를 만든다」. 장소 프롬프트만으로는
//   매일 같은 그림이 나오고, 실사 레퍼런스가 붙어야 진짜 공간처럼 보인다(이케아 실측).
//
// 출처: Pexels API 하나만 쓴다.
//   · 라이선스(2026-09-04 확인): 수정 허용·출처 표기 불필요·상업 사용 가능. 금지는 원본 그대로
//     재판매, 인물·브랜드 보증 암시, 다른 스톡 사이트 재배포. 레퍼런스로 넣어 새 이미지를 만드는
//     우리 용도는 허용 범위다. API 가이드라인의 「Pexels 링크 표시」는 텔레그램 섭외 보고에
//     사진작가 크레딧(Photo by ○○ on Pexels + 링크)으로 지킨다.
//   · TourAPI(공공누리 3유형·변경금지), Unsplash(API 약관이 ML/AI 사용 금지), 네이버 이미지검색
//     (출처 불명)은 쓰지 않는다.
//
// ⚠️ 사람이 찍힌 사진은 쓰지 않는다. FLUX.2-klein은 레퍼런스를 「편집 대상」으로 다뤄서
//    사진 속 사람이 있으면 얼굴이 그 사람으로 바뀌고(방 실측) 옷이 그대로 끌려온다(헬스장 실측).
//    tools/people(Vision)로 얼굴·사람 수를 세어 0명인 후보만 채택한다.
// ⚠️ 한국 사진 우선(2026-09-04 사용자 요청). 설명문에 Seoul/Korea/Han river 등이 붙은 사진을
//    먼저 고르고, 없을 때만 일반 사진으로 내려간다. 실측: 한식당 25/40, 서울 카페 27/40,
//    한강 밤 38/40, 서울 골목 밤 34/40은 되지만 영화관 로비는 2/40(그마저 못 씀).
// ⚠️ 원격 API + Vision 한 번이라 업무 시간에 돌아도 된다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { InputFile, InputMediaBuilder } from 'grammy';
import { paths, telegram } from '../config.js';
import { hana } from '../persona/hana.js';

const execFileAsync = promisify(execFile);
const PEOPLE_BIN = path.join(paths.root, 'tools', 'people');
export const SCHEDULE_DIR = path.join(paths.out, 'schedule');
export const SCOUT_DIR = path.join(paths.out, 'scout');

const KOREAN_RE = /\b(korea|korean|seoul|busan|incheon|daegu|hangang|han river|gangnam|hongdae|itaewon|yongsan|mangwon|seongsu)\b/i;

// 장소 키별 기본 검색어(영어 — en-US 설명문에 Seoul/Korea가 붙어 한국 필터가 먹는다).
// 일정 파일의 stop.query가 있으면 그게 우선이다.
const PLACE_QUERY = {
  restaurant: 'korean restaurant interior seoul',
  cinema: 'cinema lobby',
  cafe: 'seoul cafe interior',
  hotplaceCafe: 'seoul cafe interior',
  nightStreet: 'seoul alley night',
  riverNight: 'han river seoul night',
  riversideDusk: 'han river seoul dusk',
  park: 'han river park seoul',
  nightView: 'seoul night view',
  marketAlley: 'seoul traditional market',
  hanokAlley: 'seoul hanok alley',
  noodleShop: 'korean noodle restaurant',
  convenienceStore: 'korean convenience store interior',
  beautyStore: 'cosmetics shop interior',
};
// 장소별 필수 단어. 설명문에 이게 없으면 검색어가 아무리 맞아도 그 장소가 아니다.
// 실측 2026-09-04: "seoul cafe interior night"에 「서울 벚꽃 야경」이 15점으로 뽑혔다(seoul·night만 맞음).
// 일정 파일의 stop.must(정규식 문자열)가 있으면 그게 우선이다.
const PLACE_MUST = {
  restaurant: 'restaurant|dining|eatery|diner',
  cinema: 'cinema|theat(er|re)|movie|box office|lobby',
  cafe: 'caf[eé]|coffee',
  hotplaceCafe: 'caf[eé]|coffee',
  riverNight: 'river|hangang|bridge|riverside',
  riversideDusk: 'river|hangang|bridge|riverside',
  park: 'park|river|hangang',
  noodleShop: 'restaurant|noodle|dining|eatery',
  convenienceStore: 'convenience|store|shop|mart',
  beautyStore: 'cosmetic|beauty|store|shop',
};
// 한국 사진이 사실상 없는 장소. 여기선 한국 필터를 처음부터 끈다(영화관은 어디나 비슷하다).
const NO_KOREAN_FILTER = new Set(['cinema']);

function pexelsKey() {
  if (process.env.PEXELS_KEY) return process.env.PEXELS_KEY;
  try {
    const m = readFileSync(path.join(paths.root, '.env'), 'utf8').match(/^PEXELS_KEY=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

/** YYYYMMDD → out/schedule/YYYYMMDD.json. 없거나 슬롯이 다르면 null. */
export function scheduleFor(stamp, slot) {
  const f = path.join(SCHEDULE_DIR, `${stamp}.json`);
  if (!existsSync(f)) return null;
  const s = loadSchedule(f);
  if (slot && s.slot && s.slot !== slot) return null;
  return s;
}

export function loadSchedule(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(s.stops) || s.stops.length === 0) throw new Error(`일정에 stops가 없습니다: ${file}`);
  const seenKeys = new Set();
  for (const st of s.stops) {
    if (!st.key || !st.place) throw new Error(`일정 정거장에 key/place가 없습니다: ${JSON.stringify(st)}`);
    // key는 파일 이름(out/scout/<날짜>/<key>.jpg)이자 사진↔정거장 연결 키다.
    // 겹치면 뒤 정거장이 앞 정거장 사진을 덮어써 크레딧·프레이밍이 어긋난다.
    if (seenKeys.has(st.key)) throw new Error(`정거장 key가 겹칩니다: ${st.key} — 정거장마다 다른 key를 쓸 것(예: cafe, cafeNight)`);
    seenKeys.add(st.key);
    if (!hana.setting.places[st.place]) throw new Error(`모르는 장소 키 ${st.place} — src/persona/hana.js setting.places에 먼저 추가할 것`);
  }
  s.stamp = String(s.date || path.basename(file, '.json')).replace(/-/g, '');
  s.file = file;
  return s;
}

// 이전 섭외에서 쓴 Pexels 사진 id. 같은 검색어의 1등 사진이 매일 나오는 걸 막는다.
function usedIds(exceptStamp = '') {
  const ids = new Set();
  if (!existsSync(SCOUT_DIR)) return ids;
  for (const d of readdirSync(SCOUT_DIR)) {
    if (d === exceptStamp) continue; // --force로 다시 뽑는 날의 사진까지 막으면 매번 다른 사진이 된다
    try {
      const j = JSON.parse(readFileSync(path.join(SCOUT_DIR, d, 'scout.json'), 'utf8'));
      for (const st of j.stops || []) if (st.credit?.id) ids.add(st.credit.id);
    } catch {}
  }
  return ids;
}

async function search(query, { orientation = 'portrait', perPage = 30 } = {}) {
  const key = pexelsKey();
  if (!key) throw new Error('PEXELS_KEY가 .env에 없습니다');
  const u = new URL('https://api.pexels.com/v1/search');
  u.searchParams.set('query', query);
  u.searchParams.set('per_page', String(perPage));
  u.searchParams.set('locale', 'en-US');
  if (orientation) u.searchParams.set('orientation', orientation);
  let lastErr;
  for (const wait of [0, 3000, 8000]) { // 실측 2026-09-04: 504 upstream timeout이 간헐적으로 난다
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(u, { headers: { Authorization: key }, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return (await res.json()).photos || [];
      lastErr = new Error(`pexels ${res.status}: ${(await res.text()).slice(0, 120)}`);
      // 4xx(키·검색어 오류)는 재시도해도 같다. ⚠️ try 안에서 throw하면 바로 아래 catch가 삼켜
      //    루프가 계속 돈다(리뷰에서 잡힘) — 표시만 하고 catch 밖에서 던진다.
      if (res.status < 500 && res.status !== 429) lastErr.fatal = true;
    } catch (e) {
      lastErr = e;
    }
    if (lastErr?.fatal) throw lastErr;
  }
  throw lastErr;
}

async function countPeople(file) {
  if (!existsSync(PEOPLE_BIN)) return null; // 도구가 없으면 판정 불가 → 호출부가 통과시킨다
  try {
    const { stdout } = await execFileAsync(PEOPLE_BIN, [file], { timeout: 30_000 });
    const m = String(stdout).match(/faces=(\d+) humans=(\d+)/);
    return m ? { faces: Number(m[1]), humans: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

async function download(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// 배경으로 못 쓰는 사진. 공중·스카이라인 사진은 「그녀가 서 있는 눈높이」가 아니다.
// 접사(병·컵 클로즈업)는 장소 레퍼런스가 못 된다 — 실측: cafe 재섭외에서 「콤부차 병 클로즈업」이 15점으로 1등.
const AVOID_RE = /\b(aerial|drone|high-angle|bird'?s[- ]eye|skyline|cityscape|panorama|panoramic|from above|rooftop view|close[- ]?up|macro)\b/i;
// 밤 정거장에서 피할 낮 사진.
const DAY_RE = /\b(sunlit|sunny|daylight|daytime|morning|noon|afternoon|sunset|sunrise|golden hour)\b/i;
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'at', 'on', 'and', 'with']);

function normalize(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
export function isNightStop(stop, schedule) {
  if (stop.night !== undefined) return Boolean(stop.night);
  // ⚠️ when이 없으면 Number('')이 0이라 「새벽 0시」로 읽혀 밤이 돼 버린다 — 없으면 NaN으로.
  const raw = String(stop.when || '').trim();
  const h = raw ? Number(raw.split(':')[0]) : NaN;
  if (!Number.isFinite(h)) return Boolean(schedule?.night);
  // 저녁 일정(schedule.night)은 저녁 식사 시간대(17시~)부터 밤 프레이밍으로 간다.
  // 17:30 저녁을 낮으로 찍으면 첫 장이 한낮 식당인데 글은 「저녁」이라 어긋난다.
  return h >= 18 || h < 6 || (Boolean(schedule?.night) && h >= 17);
}

// 정거장 하나 섭외. 후보를 점수로 줄 세운 뒤(한국 > 검색어 일치 > 세로) 앞에서부터 사람 수를 재어
// 0명인 첫 사진을 고른다. 아무것도 없으면 null.
async function scoutStop(stop, schedule, dir, used, log) {
  const query = stop.query || PLACE_QUERY[stop.place] || hana.setting.headlineFor[stop.place] || stop.place;
  const wantKorean = stop.korean === undefined ? !NO_KOREAN_FILTER.has(stop.place) : Boolean(stop.korean);
  const night = isNightStop(stop, schedule);
  const mustSrc = stop.must || PLACE_MUST[stop.place];
  const must = mustSrc ? new RegExp(mustSrc, 'i') : null;
  const words = normalize(query).split(/\s+/).filter((w) => w && !STOP_WORDS.has(w));

  const seen = new Set();
  const cands = [];
  let searchErr = null;
  for (const orientation of ['portrait', 'landscape']) {
    let photos;
    try {
      photos = await search(query, { orientation });
    } catch (e) {
      // 세로 검색은 됐는데 가로가 504면 세로 후보를 버릴 이유가 없다. 둘 다 실패했을 때만 던진다.
      searchErr = e;
      log(`[scout] ${stop.key}: ${orientation} 검색 실패 (${String(e.message).slice(0, 80)}) — 모은 후보로 계속`);
      continue;
    }
    for (const p of photos) {
      if (seen.has(p.id) || used.has(p.id)) continue;
      seen.add(p.id);
      const alt = p.alt || '';
      const nalt = normalize(alt);
      if (AVOID_RE.test(alt)) continue;
      if (must && !must.test(alt)) continue;
      const korean = KOREAN_RE.test(alt);
      const overlap = words.filter((w) => nalt.includes(w)).length;
      const score = (wantKorean && korean ? 10 : 0) + overlap * 2 + (orientation === 'portrait' ? 1 : 0) - (night && DAY_RE.test(alt) ? 5 : 0);
      cands.push({ p, korean, orientation, score, label: `${korean ? '한국' : '일반'}·${orientation === 'portrait' ? '세로' : '가로'}` });
    }
  }
  if (!cands.length && searchErr) throw searchErr;
  cands.sort((a, b) => b.score - a.score);

  const tmp = path.join(dir, `_cand-${stop.key}.jpg`);
  const file = path.join(dir, `${stop.key}.jpg`);
  const record = (c, n) => ({
    key: stop.key,
    place: stop.place,
    label: stop.label || hana.setting.summaryFor[stop.place] || stop.place,
    when: stop.when || '',
    night,
    query,
    tier: c.label,
    score: c.score,
    file,
    korean: c.korean,
    people: n,
    credit: { id: c.p.id, alt: c.p.alt || '', photographer: c.p.photographer, photographerUrl: c.p.photographer_url, url: c.p.url },
  });
  // 얼굴은 없지만 사람 1명(뒷모습)인 후보 — 아무것도 없을 때만 쓴다.
  // ⚠️ tmp는 다음 후보가 덮어쓰므로 파일을 그 자리에서 따로 복사해 둬야 한다.
  let fallback = null;
  const fbFile = path.join(dir, `_fb-${stop.key}.jpg`);
  for (const c of cands.slice(0, 12)) { // 12장까지만 내려받아 본다
    try {
      await download(c.p.src.large, tmp);
    } catch {
      continue;
    }
    const n = await countPeople(tmp);
    if (!n || (n.faces === 0 && n.humans === 0)) {
      log(`[scout] ${stop.key}: ${c.label} #${c.p.id} 채택 (점수 ${c.score}) ${(c.p.alt || '').slice(0, 70)}`);
      renameSync(tmp, file);
      return record(c, n);
    }
    if (n.faces === 0 && n.humans <= 1 && !fallback) {
      copyFileSync(tmp, fbFile);
      fallback = record(c, n);
    }
    log(`[scout] ${stop.key}: #${c.p.id} 사람 ${n.humans}명/얼굴 ${n.faces} → 제외`);
  }
  if (fallback) {
    log(`[scout] ${stop.key}: 사람 0명 사진이 없어 뒷모습 1명 사진으로 대신함`);
    renameSync(fbFile, file);
    return fallback;
  }
  return null;
}

/**
 * 일정 전체 섭외. 결과는 out/scout/YYYYMMDD/{key}.jpg + scout.json.
 * 이미 scout.json이 있으면 다시 검색하지 않는다(force로 강제).
 */
export async function scoutSchedule(schedule, { force = false, only = null, log = console.log } = {}) {
  const dir = path.join(SCOUT_DIR, schedule.stamp);
  const jsonFile = path.join(dir, 'scout.json');
  let cached = null;
  if (existsSync(jsonFile)) {
    // 깨진 캐시(쓰다 죽은 프로세스·디스크 풀)는 「캐시 없음」이다 — 여기서 죽으면 그날 브이로그가 통째로 안 나온다.
    try {
      cached = JSON.parse(readFileSync(jsonFile, 'utf8'));
    } catch (e) {
      log(`[scout] 기존 scout.json을 읽을 수 없어 다시 섭외한다: ${String(e.message).slice(0, 80)}`);
    }
    if (!Array.isArray(cached?.stops)) cached = null;
    if (cached && !force) {
      // 검색 자체가 실패한 정거장(Pexels 504·키 오류)은 캐시로 굳히지 않는다 — 그 정거장만 다시 뽑는다.
      // 「검색은 됐는데 쓸 사진이 없다」(error 없음)는 다시 돌려도 같으니 그대로 둔다.
      // --only로 일부만 뽑은 날은 나머지 정거장이 아예 없다 — 그것도 이번에 뽑는다.
      const have = new Set(cached.stops.map((s) => s.key));
      const retry = schedule.stops.map((s) => s.key).filter((k) => !have.has(k) || cached.stops.find((s) => s.key === k)?.error);
      if (!retry.length) {
        log(`[scout] 기존 섭외 사용 (${cached.stops.filter((s) => s.file).length}/${cached.stops.length}곳)`);
        return cached;
      }
      only = retry;
      log(`[scout] 지난 실패·미섭외 정거장 재시도: ${retry.join(', ')}`);
    }
  }
  mkdirSync(dir, { recursive: true });
  const used = usedIds(schedule.stamp);
  // only=['cafe']면 그 정거장만 다시 뽑고 나머지는 기존 결과를 그대로 둔다(있을 때).
  // 「검색은 됐는데 쓸 사진이 없던」 정거장(file null·error 없음)도 결과다 — 다시 돌려도 같다.
  const keep = new Map((cached?.stops || []).filter((s) => !s.error && (!s.file || existsSync(s.file))).map((s) => [s.key, s]));
  for (const s of keep.values()) if (s.credit) used.add(s.credit.id);
  const stops = [];
  for (const stop of schedule.stops) {
    // ⚠️ 기존 결과가 없는 정거장(첫 섭외 날의 --only)은 그냥 뽑는다. 빈칸을 scout.json에 박아두면
    //    캐시에 걸려 그날 내내 「사진 없음」으로 고정된다(리뷰에서 잡힘).
    if (only && !only.includes(stop.key) && keep.has(stop.key)) {
      stops.push(keep.get(stop.key));
      continue;
    }
    let hit = null;
    let error = null;
    try {
      hit = await scoutStop(stop, schedule, dir, used, log);
    } catch (e) {
      error = String(e.message).slice(0, 120);
      log(`[scout] ${stop.key} 검색 실패: ${error}`);
    }
    if (hit) used.add(hit.credit.id);
    else log(`[scout] ${stop.key}: 쓸 사진 없음 → 장소 프롬프트만으로 그린다`);
    stops.push(hit || {
      key: stop.key, place: stop.place, label: stop.label || '', when: stop.when || '', night: isNightStop(stop, schedule),
      file: null, credit: null, ...(error ? { error } : {}),
    });
  }
  for (const f of readdirSync(dir)) if (f.startsWith('_')) try { unlinkSync(path.join(dir, f)); } catch {}
  const out = { date: schedule.stamp, title: schedule.title || '', stops };
  // 쓰다 죽어도 반쪽짜리 JSON이 남지 않게 임시 파일에 쓰고 바꿔치기한다.
  writeFileSync(`${jsonFile}.tmp`, JSON.stringify(out, null, 2));
  renameSync(`${jsonFile}.tmp`, jsonFile);
  // 이번 실행에서 새로 섭외했다는 표시(파일에는 안 남긴다) — 호출부가 보고를 한 번만 보내게.
  out.fresh = true;
  return out;
}

/** 텔레그램 섭외 보고 — 사진 앨범 + 크레딧. Pexels API 가이드라인(링크 표시)을 여기서 지킨다. */
export async function sendScoutReport(bot, scout) {
  const found = scout.stops.filter((s) => s.file && existsSync(s.file));
  const lines = [`📍 ${scout.date} 촬영지 섭외 (${found.length}/${scout.stops.length}곳)`];
  scout.stops.forEach((s, i) => {
    const c = s.credit;
    lines.push(
      c
        ? `${i + 1}. ${s.when ? s.when + ' ' : ''}${s.label} — ${s.korean ? '🇰🇷 ' : ''}Photo by ${c.photographer} on Pexels\n   ${c.url}`
        : `${i + 1}. ${s.when ? s.when + ' ' : ''}${s.label} — 사진 없음(프롬프트만)`
    );
  });
  if (found.length === 1) {
    await bot.api.sendPhoto(telegram.chatId, new InputFile(found[0].file), { caption: found[0].label });
  } else if (found.length > 1) {
    await bot.api.sendMediaGroup(
      telegram.chatId,
      found.map((s) => InputMediaBuilder.photo(new InputFile(s.file), { caption: `${s.when ? s.when + ' ' : ''}${s.label}` }))
    );
  }
  await bot.api.sendMessage(telegram.chatId, lines.join('\n'), { link_preview_options: { is_disabled: true } });
}
