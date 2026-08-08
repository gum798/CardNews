// 서울 날씨. 브이로그 복장과 글이 계절에 안 맞으면 그 자체로 가짜 티가 난다
// (8월에 가디건, 1월에 반팔).
//
// ⚠️ 라이선스: Open-Meteo 무료 티어는 약관 원문이 "You may only use the free API
//    services for non-commercial purposes" 라 이 프로젝트(수익화 예정)에서는 못 쓴다.
//    한국에서 무료 + 상업이용 가능한 건 기상청 공공데이터포털이다(공공데이터법상
//    영리·비영리 무관 자유 이용). 다만 가입·키 발급이 필요하다.
//
// 그래서 2단 구성이다:
//   1) 키가 없으면 → 서울 평년값(기상청 1991~2020 월평균)으로 날짜에서 추정. 항상 동작.
//   2) KMA_API_KEY가 있으면 → 초단기실황으로 실제 기온·강수를 읽는다.
//
// 평년값만으로도 "8월엔 덥다"는 충분히 맞는다. 실측은 "오늘 비 온다" 같은 디테일용이다.
const SEOUL_NX = 60;
const SEOUL_NY = 127;

// 기상청 서울 월평균기온 평년값(1991~2020, ℃). 월 중순 기준값으로 쓴다.
const MONTHLY_NORMALS = [-1.9, 0.7, 6.1, 12.6, 17.8, 22.1, 25.3, 26.1, 21.6, 15.0, 7.5, 0.2];

// 월 경계에서 기온이 튀지 않게 이웃 달 사이를 선형 보간한다.
// (8월 31일과 9월 1일의 옷차림이 갑자기 바뀌면 그것도 어색하다)
function normalTemp(date) {
  const m = date.getMonth();
  const day = date.getDate();
  const daysInMonth = new Date(date.getFullYear(), m + 1, 0).getDate();
  // 월 중순(15일)을 기준점으로 두고 앞뒤 달로 보간
  const t = (day - 15) / daysInMonth;
  const other = t < 0 ? (m + 11) % 12 : (m + 1) % 12;
  return MONTHLY_NORMALS[m] + (MONTHLY_NORMALS[other] - MONTHLY_NORMALS[m]) * Math.abs(t);
}

// 낮 최고기온은 일평균보다 대략 5도 높다. 옷은 낮 기온에 맞춰 입는다.
function dayHigh(avg) {
  return avg + 5;
}

export const BANDS = [
  { min: 28, key: 'midsummer', label: '한여름' },
  { min: 23, key: 'summer', label: '여름' },
  { min: 17, key: 'mild', label: '선선한 봄가을' },
  { min: 10, key: 'cool', label: '쌀쌀' },
  { min: 3, key: 'cold', label: '추움' },
  { min: -99, key: 'winter', label: '한겨울' },
];

export function bandFor(tempC) {
  return BANDS.find((b) => tempC >= b.min) || BANDS[BANDS.length - 1];
}

// 기상청 초단기실황. 키가 없거나 실패하면 null — 호출부는 평년값으로 간다.
async function fetchKma(date) {
  const key = process.env.KMA_API_KEY;
  if (!key) return null;

  // 초단기실황은 매시 40분에 생성된다. 여유를 두고 한 시간 전 자료를 요청한다.
  const base = new Date(date.getTime() - 60 * 60 * 1000);
  const y = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, '0');
  const dd = String(base.getDate()).padStart(2, '0');
  const hh = String(base.getHours()).padStart(2, '0');

  const url =
    'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst' +
    `?serviceKey=${encodeURIComponent(key)}&numOfRows=10&pageNo=1&dataType=JSON` +
    `&base_date=${y}${mm}${dd}&base_time=${hh}00&nx=${SEOUL_NX}&ny=${SEOUL_NY}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const items = body?.response?.body?.items?.item;
    if (!Array.isArray(items)) throw new Error('예상과 다른 응답 형식');

    const val = (cat) => items.find((i) => i.category === cat)?.obsrValue;
    const t1h = Number(val('T1H'));
    const pty = Number(val('PTY')); // 0 없음 / 1 비 / 2 비눈 / 3 눈 / 5 빗방울 / 6 빗방울눈날림 / 7 눈날림
    if (!Number.isFinite(t1h)) throw new Error('기온(T1H) 없음');

    return {
      tempC: t1h,
      raining: [1, 2, 5, 6].includes(pty),
      snowing: [3, 7].includes(pty),
      source: 'kma',
    };
  } catch (e) {
    console.warn(`[weather] 기상청 조회 실패 → 평년값 사용: ${String(e.message).slice(0, 80)}`);
    return null;
  }
}

// 오늘(또는 지정일) 서울 날씨. 실패해도 절대 throw하지 않는다 —
// 날씨 때문에 브이로그 생성이 멈추면 안 된다.
export async function getSeoulWeather(date = new Date()) {
  const live = await fetchKma(date);
  const tempC = live ? live.tempC : dayHigh(normalTemp(date));
  const band = bandFor(tempC);
  return {
    tempC: Math.round(tempC * 10) / 10,
    band: band.key,
    label: band.label,
    raining: live?.raining ?? false,
    snowing: live?.snowing ?? false,
    source: live ? 'kma' : 'normals',
    month: date.getMonth() + 1,
  };
}

// 장면에 붙일 계절 보정.
//
// ⚠️ 계절 신호를 「사람에게 나타나는 것」과 「그 공간에 놓인 물건」으로 갈라야 한다.
//    처음엔 안 갈랐더니 방에 두려고 쓴 선풍기가 도서관·편의점까지 따라다녔다.
//    소품은 방에서만 유효하다. 밖은 대개 에어컨이 도는 공공장소다.
const SEASON_BODY = {
  midsummer:
    'It is the middle of a hot Korean summer. Her skin has a faint sheen from the heat, ' +
    'a few strands of hair stick to her temple, and she wears no outer layer of any kind.',
  summer: 'It is summer. She wears no outer layer of any kind.',
  mild: '',
  cool: '',
  cold: 'It is cold outside. She has an outer layer with her.',
  winter: 'It is deep winter. She has a heavy padded coat with her.',
};

// 방(원룸)에만 붙는 소품. roomPrompt가 「의자에 걸린 후디」처럼 배치를 고정해 둬서,
// 계절에 안 맞는 물건만 여기서 덮어쓴다.
const SEASON_ROOM_PROPS = {
  midsummer:
    'The window is open and a small white electric fan on the floor is pointed at her. ' +
    'There is no hoodie, coat or knitwear anywhere in the room — the chair back is bare.',
  summer: 'The window is open and there is no hoodie, coat or knitwear anywhere in the room.',
  mild: '',
  cool: '',
  cold: 'The window is shut and a thick outer jacket hangs on the clothing rack.',
  winter:
    'The window is shut with condensation at the edges, a padded coat hangs on the clothing rack, ' +
    'and a folded blanket sits on the bed.',
};

// 실내 공공장소는 냉난방이 돌아간다. 개인 선풍기·난로가 있으면 안 된다.
const INDOOR_PUBLIC = new Set(['library', 'libraryCafe', 'convenienceStore']);

export function seasonNoteFor(band, place = 'room') {
  const body = SEASON_BODY[band] || '';
  if (place === 'room') return [body, SEASON_ROOM_PROPS[band] || ''].filter(Boolean).join(' ');
  if (INDOOR_PUBLIC.has(place)) {
    // 밖은 덥지만 안은 에어컨이다. 그 대비가 여름 장면을 설명한다.
    const ac =
      band === 'midsummer' || band === 'summer'
        ? 'Inside it is air-conditioned and clearly cooler than outside. ' +
          'There is no personal electric fan anywhere — this is a public indoor space.'
        : band === 'cold' || band === 'winter'
          ? 'Inside it is heated and warm. There is no personal heater anywhere — this is a public indoor space.'
          : '';
    return [body, ac].filter(Boolean).join(' ');
  }
  return body;
}

// 글 작성자에게 줄 한 줄 요약.
export function weatherBrief(w) {
  const parts = [`서울 ${w.month}월, ${w.label} (체감 ${w.tempC}도쯤)`];
  if (w.raining) parts.push('비가 온다');
  if (w.snowing) parts.push('눈이 온다');
  if (w.source === 'normals') parts.push('※ 평년값 기준');
  return parts.join(' · ');
}
