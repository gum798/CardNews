// 프로필: 건강하나 — 건강·운동 계정 (뉴스하나의 자매 브랜드).
// 계정 개설 후 handle과 .env의 HEALTHHANA_* 키를 채우면 동작한다.
// 피드는 2026-07-28 기준 응답을 확인한 것만 등록 (하이닥·헬스조선은 RSS 404라 제외).
export default {
  key: 'healthhana',
  envPrefix: 'HEALTHHANA',

  account: { name: '건강하나', handle: '@healthhana.daily' },

  // dbFile 생략 → data/healthhana.db 자동 사용. r2Prefix 생략 → 'healthhana/' 접두사.

  // 기존 뉴스하나(06·18시)와 3시간씩 떨어뜨려 부하·API 호출이 겹치지 않게 한다.
  schedule: {
    morning: { target: 9, retryUntilHour: 14 },
    evening: { target: 21, retryUntilHour: 23 },
  },

  topics: {
    health: {
      label: '건강정보',
      theme: 'navy',
      ytCategory: '26', // Howto & Style
      evergreen: '오늘 바로 실천할 수 있는 건강 습관이나 알아두면 좋은 의학 상식',
      feeds: [
        { name: 'Google뉴스 건강', url: 'https://news.google.com/rss/search?q=%EA%B1%B4%EA%B0%95&hl=ko&gl=KR&ceid=KR:ko' },
        { name: '코메디닷컴', url: 'https://kormedi.com/feed/' },
        { name: 'BBC Health', url: 'https://feeds.bbci.co.uk/news/health/rss.xml' },
      ],
    },
    fitness: {
      label: '운동·피트니스',
      theme: 'bold',
      ytCategory: '17', // Sports
      evergreen: '집이나 헬스장에서 바로 따라 할 수 있는 운동법과 자세 교정 팁',
      feeds: [
        { name: 'Google뉴스 운동', url: 'https://news.google.com/rss/search?q=%EC%9A%B4%EB%8F%99%20%ED%97%AC%EC%8A%A4&hl=ko&gl=KR&ceid=KR:ko' },
        { name: 'Google뉴스 다이어트', url: 'https://news.google.com/rss/search?q=%EB%8B%A4%EC%9D%B4%EC%96%B4%ED%8A%B8&hl=ko&gl=KR&ceid=KR:ko' },
      ],
    },
    nutrition: {
      label: '영양·식단',
      theme: 'grad-green',
      ytCategory: '26', // Howto & Style
      evergreen: '몸에 좋은 식재료·식단 구성법이나 흔한 영양 오해 바로잡기',
      feeds: [
        { name: 'Google뉴스 영양', url: 'https://news.google.com/rss/search?q=%EC%98%81%EC%96%91%20%EC%8B%9D%EB%8B%A8&hl=ko&gl=KR&ceid=KR:ko' },
        { name: 'Google뉴스 정신건강', url: 'https://news.google.com/rss/search?q=%EC%A0%95%EC%8B%A0%EA%B1%B4%EA%B0%95%20%EC%88%98%EB%A9%B4&hl=ko&gl=KR&ceid=KR:ko' },
        { name: 'NYT Health', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml' },
      ],
    },
  },
};
