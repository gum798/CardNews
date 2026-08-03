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
  // topics=이 슬롯에서 발행할 주제. 여러 개면 날짜별로 번갈아 하나만 낸다.
  //
  // 하루 6건(3주제×2슬롯) → 2건으로 감축.
  // 0을 여섯 번 찍는 것보다 두 번에 제작력을 몰아넣는 편이 낫고,
  // 고빈도 + 동일 템플릿 반복은 Meta 스팸 정책이 명시한 신호 두 가지에 동시에 해당한다.
  schedule: {
    morning: { target: 6, retryUntilHour: 11, topics: ['ai'] },
    evening: { target: 18, retryUntilHour: 23, topics: ['general', 'topic'] },
  },

  // 주제 스트림. 각 주제는 고유 테마(색)와 피드 목록을 가진다.
  // evergreen: 최신 뉴스가 없을 때 AI가 만들 폴백 카드의 성격.
  // scriptStyle: 릴스 대본 구조. 단순 전달은 저장·공유를 못 만들므로 주제별로 다르게 간다.
  //   howto  = 활용형 (무슨 도구 → 뭘 할 수 있나 → 복붙 프롬프트 → 저장 유도)
  //   impact = 영향형 (무슨 일 → 나에게 뭐가 달라지나 → 언제까지 뭘 하면 되나)
  //   story  = 서사형 (궁금증 → 전개 → 반전 → 판단)
  // pickCriteria: 그 주제의 뉴스 선별 기준. "뉴스 가치"가 아니라 시청자 효용으로 고른다.
  topics: {
    general: {
      label: '일반뉴스',
      theme: 'grad-blue',
      ytCategory: '25', // News & Politics
      scriptStyle: 'impact',
      pickCriteria:
        '시청자의 돈·시간·생활에 실제로 영향이 가는 것을 최우선으로 고르세요. ' +
        '정책·요금·금리·지원금·제도 변경처럼 "그래서 나는 뭘 해야 하나"가 나오는 뉴스가 좋습니다. ' +
        '정치 공방, 인사, 논평, 단순 사건사고는 시청자가 할 수 있는 게 없으므로 피하세요.',
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
      scriptStyle: 'story',
      pickCriteria:
        '"어? 진짜?" 소리가 나오는 것을 고르세요. 반전이 있거나, 통념을 뒤집거나, ' +
        '누군가에게 바로 공유하고 싶어지는 이야기가 좋습니다. ' +
        '연예인 가십과 단순 홍보성 기사는 피하세요.',
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
      scriptStyle: 'howto',
      pickCriteria:
        '⚠️ 시청자가 오늘 당장 따라 해볼 수 있는 것만 고르세요. ' +
        '새 AI 도구·기능 출시, 사용법, 무료 공개, 기존 도구의 새 활용처럼 ' +
        '"이걸로 뭘 할 수 있다"가 나오는 뉴스여야 합니다. ' +
        '⚠️ 투자·실적·인수합병·규제·안전 논쟁·연구 발표처럼 시청자가 할 수 있는 행동이 없는 뉴스는 ' +
        '아무리 큰 뉴스여도 고르지 마세요.',
      evergreen: '실생활·업무에 바로 쓰는 AI 활용 팁이나 알아두면 좋은 AI 개념',
      feeds: [
        { name: 'AI타임스', url: 'https://www.aitimes.com/rss/allArticle.xml' },
        { name: 'ZDNet Korea', url: 'https://feeds.feedburner.com/zdkorea' },
        { name: 'Google뉴스 AI', url: 'https://news.google.com/rss/search?q=AI%20%EC%9D%B8%EA%B3%B5%EC%A7%80%EB%8A%A5&hl=ko&gl=KR&ceid=KR:ko' },
      ],
    },
  },
};
