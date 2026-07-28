// 프로필: 뉴스하나 (@newshana.daily) — 기존 계정.
// envPrefix가 있으면 .env에서 `<PREFIX>_IG_ACCESS_TOKEN` 같은 접두사 키를 먼저 찾고,
// 없으면 접두사 없는 기존 키로 폴백한다(기존 .env를 그대로 쓰기 위함).
export default {
  key: 'newshana',
  envPrefix: 'NEWSHANA',
  // 기존 .env가 접두사 없는 키(IG_ACCESS_TOKEN 등)로 되어 있어 폴백을 허용한다.
  // 신규 프로필은 폴백을 켜지 말 것 — 자격증명 누락 시 이 계정에 잘못 발행된다.
  envFallback: true,

  account: { name: '뉴스하나', handle: '@newshana.daily' },

  // 기존 DB·R2 경로를 그대로 유지(마이그레이션 불필요). 신규 프로필은 생략하면 `<key>.db`.
  dbFile: 'cardnews.db',
  r2Prefix: '', // 기존 업로드가 `<후보id>/card-1.jpg` 형태라 접두사 없음

  // 발행 슬롯: target=정규 시각, retryUntilHour=그 시각까지 매 정시 재시도 후 포기.
  schedule: {
    morning: { target: 6, retryUntilHour: 11 },
    evening: { target: 18, retryUntilHour: 23 },
  },

  // 주제 스트림. 각 주제는 고유 테마(색)와 피드 목록을 가진다.
  // evergreen: 최신 뉴스가 없을 때 AI가 만들 폴백 카드의 성격.
  topics: {
    general: {
      label: '일반뉴스',
      theme: 'grad-blue',
      ytCategory: '25', // News & Politics
      evergreen: '오늘 알아두면 좋은 시사·경제 상식이나 뉴스를 똑똑하게 읽는 팁',
      feeds: [
        { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
        { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' },
        { name: 'Reuters', url: 'https://news.google.com/rss/search?q=site:reuters.com&hl=en-US&gl=US&ceid=US:en' },
        { name: '전자신문', url: 'https://rss.etnews.com/Section901.xml' },
      ],
    },
    topic: {
      label: '재밌는토픽',
      theme: 'bold',
      ytCategory: '24', // Entertainment
      evergreen: '흥미로운 상식·기네스 기록·다가오는 이색 이벤트 등 가볍고 재밌는 이야기',
      feeds: [
        { name: 'Google뉴스 화제', url: 'https://news.google.com/rss/search?q=%ED%99%94%EC%A0%9C&hl=ko&gl=KR&ceid=KR:ko' },
        { name: 'Google뉴스 이색', url: 'https://news.google.com/rss/search?q=%EC%9D%B4%EC%83%89&hl=ko&gl=KR&ceid=KR:ko' },
        { name: 'UPI Odd', url: 'http://rss.upi.com/news/odd_news.rss' },
      ],
    },
    ai: {
      label: 'AI뉴스',
      theme: 'grad-green',
      ytCategory: '28', // Science & Technology
      evergreen: '실생활·업무에 바로 쓰는 AI 활용 팁이나 알아두면 좋은 AI 개념',
      feeds: [
        { name: 'AI타임스', url: 'https://www.aitimes.com/rss/allArticle.xml' },
        { name: 'ZDNet Korea', url: 'https://feeds.feedburner.com/zdkorea' },
        { name: 'Google뉴스 AI', url: 'https://news.google.com/rss/search?q=AI%20%EC%9D%B8%EA%B3%B5%EC%A7%80%EB%8A%A5&hl=ko&gl=KR&ceid=KR:ko' },
      ],
    },
  },
};
