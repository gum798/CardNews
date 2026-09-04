// 실제 장소 수집 — 한국관광공사 TourAPI(공공데이터포털).
//
// 왜 필요한가:
//   인플루언서 아크(seen-by-strangers)는 하나가 맛집·핫플·여행지를 다니는 이야기인데,
//   장소가 고정 6곳뿐이면 며칠 만에 반복이 보인다. 실제 장소 이름·분류·지역을 받아와
//   매일 다른 곳에 간 것처럼 만든다.
//
// ⚠️ 사진은 절대 쓰지 않는다. TourAPI 이미지는 공공누리 3유형(출처표시+변경금지)이라
//    우리가 가공할 수 없다. 이름·분류·지역·개요(텍스트)만 받아 우리 모델이 새로 그린다.
//    (신청서에도 그렇게 적어 승인받았다)
// ⚠️ 출처 표기: 게시물에 「한국관광공사」를 밝힌다. 공공누리 1유형 조건이다.
// ⚠️ 원격 API라 업무 시간에 돌아도 된다 — 로컬 부하가 없다.
//
// 출력: out/places-pool.json
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../src/config.js';

const KEY = process.env.DATA_GO_KR_KEY || (() => {
  const f = path.join(paths.root, '.env');
  if (!existsSync(f)) return '';
  const m = readFileSync(f, 'utf8').match(/^DATA_GO_KR_KEY=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
})();

const BASE = 'https://apis.data.go.kr/B551011/KorService2';
const OUT = path.join(paths.out, 'places-pool.json');

// 아크에 필요한 장소 종류 → TourAPI 분류.
// contentTypeId: 12 관광지 / 14 문화시설 / 39 음식점 / 38 쇼핑
// areaCode 1 = 서울. sigunguCode로 구를 좁힌다.
const QUERIES = [
  { key: 'hotplaceCafe', label: '핫플 카페',   contentTypeId: 39, cat3: 'A05020900', sigungu: [4, 5, 24] }, // 카페/전통찻집 · 성동·광진·마포
  { key: 'noodleShop',   label: '노포 국숫집', contentTypeId: 39, cat3: 'A05020100', sigungu: [] },          // 한식
  { key: 'nightView',    label: '야경 명소',   contentTypeId: 12, cat3: '',          sigungu: [] },
  { key: 'marketAlley',  label: '재래시장',    contentTypeId: 38, cat3: 'A04010200', sigungu: [] },          // 상설시장
  { key: 'hanokAlley',   label: '한옥·고택',   contentTypeId: 12, cat3: 'A02010700', sigungu: [] },          // 고택
];

async function fetchList(q) {
  // ⚠️ serviceKey는 URLSearchParams에 넣으면 안 된다. data.go.kr이 주는 키는 이미
  //    URL 인코딩돼 있어서(%2B 등) 다시 인코딩되면 %252B가 되고 «등록되지 않은 서비스키»가 난다(실측).
  //    나머지 파라미터만 인코딩하고 키는 원문 그대로 붙인다.
  const p = new URLSearchParams({
    numOfRows: '50', pageNo: '1', MobileOS: 'ETC',
    MobileApp: 'newshana', _type: 'json', areaCode: '1',
    arrange: 'O', // 대표이미지가 있는 것 우선 정렬(사진은 안 쓰지만 정보가 충실한 편)
  });
  if (q.contentTypeId) p.set('contentTypeId', String(q.contentTypeId));
  if (q.cat3) p.set('cat3', q.cat3);
  const r = await fetch(`${BASE}/areaBasedList2?serviceKey=${KEY}&${p}`);
  const b = await r.json();
  const items = b?.response?.body?.items?.item;
  if (!items) return [];
  return (Array.isArray(items) ? items : [items]).map((x) => ({
    id: x.contentid,
    name: x.title,
    // ⚠️ 주소는 구까지만 남긴다. 상세 주소는 실존 업소를 특정하게 되어
    //    「이 가게 다녀왔다」는 사실 주장이 된다. 우리는 허구를 만든다.
    district: String(x.addr1 || '').split(' ').slice(0, 2).join(' '),
    cat: x.cat3 || x.cat2 || '',
  })).filter((x) => x.name && x.district);
}

async function main() {
  if (!KEY) { console.error('[places] DATA_GO_KR_KEY 없음'); process.exit(2); }
  const pool = { collectedAt: new Date().toISOString(), source: '한국관광공사 TourAPI (공공누리 1유형)', byPlace: {} };
  for (const q of QUERIES) {
    try {
      const list = await fetchList(q);
      pool.byPlace[q.key] = { label: q.label, items: list };
      console.log(`[places] ${q.key.padEnd(14)} ${String(list.length).padStart(3)}곳  예: ${list.slice(0,2).map(x=>x.name).join(', ')}`);
    } catch (e) {
      console.warn(`[places] ${q.key} 실패: ${String(e.message).slice(0, 120)}`);
      pool.byPlace[q.key] = { label: q.label, items: [] };
    }
  }
  writeFileSync(OUT, JSON.stringify(pool, null, 2));
  const total = Object.values(pool.byPlace).reduce((n, v) => n + v.items.length, 0);
  console.log(`[places] 총 ${total}곳 → ${OUT}`);
}

main().catch((e) => { console.error('[places] 실패:', e.message.slice(0, 300)); process.exit(1); });
