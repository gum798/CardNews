# 기술 리서치: AI 인스타 카드뉴스 자동화 시스템 (2026-07-23 기준)

12개 에이전트(주제별 리서치 6 + 교차 검증 6)로 조사. 아래 내용은 검증 단계에서 수정된 사실 반영 완료.

## 1. 인스타그램 공식 API (Meta Graph API v25.0)

**계정/인증**
- Instagram **프로페셔널 계정** 필요 (Business 또는 Creator 모두 가능, 개인 계정 불가)
- **Instagram Login(Business Login)** 방식 권장 → 페이스북 페이지 연동 불필요. 스코프: `instagram_business_content_publish` + `instagram_business_basic`
- **본인 소유 계정만 게시하면 App Review 불필요** — Standard Access(개발 모드)에서 본인 계정을 앱 테스터/역할로 추가하면 즉시 발행 가능
- 장기 토큰(long-lived) 약 60일 만료 → 자동 갱신 잡 필요

**발행 (2단계: 컨테이너 생성 → 게시)**
- `POST /{ig-id}/media` → `POST /{ig-id}/media_publish`
- 캐러셀: `media_type=CAROUSEL`, 자식 컨테이너 최대 10장, 게시 1건 카운트
- ⚠️ **모든 캐러셀 이미지는 첫 장 비율로 크롭됨** → 전 카드 4:5(1080×1350) 통일 필수
- ⚠️ **이미지는 JPEG만 지원** (PNG 불가) → 렌더링 후 JPEG 변환
- ⚠️ **미디어는 공개 URL 호스팅 필수** (바이너리 직접 업로드 불가) → S3/R2/Cloudinary 등 필요
- Reels: `media_type=REELS` + `video_url`, 컨테이너 `status_code=FINISHED` 폴링(분당 1회, 최대 5분) 후 게시. **API Reels는 5~90초만 릴스 탭 노출 자격**
- ⚠️ **인스타 음악 라이브러리는 API로 사용 불가** → BGM은 영상 파일에 직접 인코딩 (영상 속 유튜버가 겪은 것과 동일한 제약, 동일한 해법)
- 발행 한도: **롤링 24시간당 100건** (구버전 25건 정보는 폐기됨). `GET /{ig-id}/content_publishing_limit`으로 잔여량 확인
- 컨테이너 24시간 내 미게시 시 만료
- 비공식 API(instagrapi 등): 2026년 밴 웨이브로 위험 큼 → 사용 금지

## 2. RSS 소스 (실제 HTTP 검증 완료)

| 테마 | 피드 | 비고 |
|------|------|------|
| 국제뉴스 | BBC World `feeds.bbci.co.uk/news/world/rss.xml` | 검증 ✓ |
| | Guardian World `theguardian.com/world/rss` | 검증 ✓ |
| | Sky News World, NPR, Al Jazeera | 정상 |
| | Reuters/AP: 공식 RSS 없음 → Google News 프록시 `news.google.com/rss/search?q=site:reuters.com&hl=en-US&gl=US&ceid=US:en` | 검증 ✓ |
| 기이/바이럴 | UPI Odd News `rss.upi.com/news/odd_news.rss` | ⚠️ HTTP 전용, HTTPS는 403 |
| | Oddity Central `odditycentral.com/feed` | 정상 |
| AI/테크 해외 | TechCrunch, The Verge, Ars Technica, VentureBeat AI, Wired AI, MIT Tech Review | ⚠️ 셋 다 발췌만 제공(TechCrunch 전문 제공은 옛말) → 본문 필요 시 원문 페이지 취득 |
| AI/테크 국내 | ZDNet Korea `feeds.feedburner.com/zdkorea`, 전자신문 AI·SW `rss.etnews.com/04.xml`, AI타임스 `aitimes.com/rss/allArticle.xml` | 검증 ✓ 한국어, 당일 갱신 |

**파싱**: Node = `@rowanmanning/feed-parser`(2026-07-21 최신 릴리스, 활발히 유지보수 — rss-parser는 3년 방치), Python = `feedparser`(표준)

**저작권 안전장치** (시스템에 내장할 것):
- 사실만 자기 표현으로 재작성 (원문 문장 복사 금지 — AI 프롬프트에 규칙화)
- 원문 첨부 사진 사용 금지 (Getty/AP/Reuters 라이선스) → 자체 템플릿/AI 생성 이미지만
- 카드 하단 출처 매체명 자동 표기
- 한국 저작권법 제7조 5호: 단순 사실 보도는 비보호이나 해설/기획 기사는 보호 → 요약·재작성 필수

## 3. 텔레그램 봇

- 봇 생성: @BotFather `/newbot` → 토큰 발급 (환경변수로만 보관)
- 로컬 macOS = **롱 폴링** (공개 URL/SSL 불필요). 웹훅은 공개 HTTPS 필요 → 부적합
- 라이브러리: Node = **grammY 1.44**(주간 126만 DL, Bot API 최신 추종) / Python = **python-telegram-bot v22.8**(JobQueue.run_daily 내장, KST 타임존 지정 필수)
- 승인 UX: InlineKeyboard `[발행][스킵][수정]`, `callback_data` 최대 64바이트 → `pub:<id>`만 싣고 상태는 SQLite에
- 콜백 처리: `answerCallbackQuery`(스피너 정지) → `editMessageReplyMarkup`(중복 탭 방지) → 파이프라인 실행 → 결과 후속 메시지
- ⚠️ `sendMediaGroup`(앨범)에는 인라인 버튼 못 붙임 → 앨범 먼저 + 버튼 메시지 별도, 또는 4장 합성 프리뷰 1장을 sendPhoto로
- 콜백 수신하려면 봇 프로세스 상시 상주 필요 (종료형 cron만으로는 버튼 이벤트 수신 불가)

## 4. 카드 이미지 & 릴스 생성

**카드 렌더링**
- **Playwright(Chromium)**: viewport 1080×1350, deviceScaleFactor 1 → 정확한 4:5 캡처. 고선명 원하면 CSS 540×675 + dSF 2
- 스크린샷은 JPEG로 출력(또는 PNG → JPEG 변환) — IG API가 JPEG만 받으므로
- 폰트: **Pretendard**(SIL OFL, 상업 이용 자유). headless Chromium은 폰트 미임베드 시 한글 깨짐 → `@font-face` 임베드 + 스크린샷 직전 `document.fonts.ready` 대기
- 릴스용은 4:5 재활용 말고 **1080×1920 전용 HTML 변형**을 따로 렌더 (텍스트 축소 방지)

**릴스 영상 (ffmpeg)**
- concat demuxer로 카드당 3~4초. ⚠️ 마지막 이미지 duration 무시됨 → 마지막 file 줄 반복
- 인코딩: `libx264 -profile:v high -pix_fmt yuv420p -b:v 6M -maxrate 8M -bufsize 12M, 30fps, aac 192k 48kHz, -movflags +faststart`
- 길이: 카드 4장 × 3.5초 ≈ 14초 (API 릴스 자격 5~90초 내)
- 업로드 전 ffprobe 자동 검증 스텝 권장
- BGM: **Pixabay Music**(무료 상업·출처표기 불필요) 권장. ⚠️ YouTube Audio Library는 유튜브 전용 라이선스라 인스타 사용 불가

**AI 배경 이미지** (선택)
- 배경만 AI로, 한글 문구는 HTML/CSS 오버레이 (폰트/정렬 완벽 제어)
- 저가: SD 3.5 / Flux Schnell ≈ $0.003~0.012/장. Nano Banana(Gemini) 표준 ≈ $0.039/장

## 5. 인스타 성장 메커니즘 (영상 주장 검증 결과)

| 영상 주장 | 검증 |
|-----------|------|
| 피드는 팔로워에게만, 릴스는 비팔로워에게 노출 | **대체로 사실**. 단 "2~5배"가 아니라 릴스가 캐러셀 대비 도달 약 +36% (2026-04 Social Insider). 1천 팔로워 미만에선 릴스가 사실상 유일한 확장 포맷 |
| 릴스 변환으로 도달 급증 | **조건부 사실 + 중대 리스크**: 2026-04-30 Mosseri 발표로 **독창성 페널티가 사진·캐러셀까지 확대**. 30일 롤링 기준 대부분이 타인 콘텐츠거나 '의미 있는 변형' 없으면 비팔로워 추천 제외. **정적 이미지 슬라이드쇼 릴스 = 저노력 편집으로 원본 불인정 위험** |
| 프로필 4줄 세팅이 전환 좌우 | 방향성 타당 (업계 통설: 최적화 프로필 전환 10~15%). 공식 랭킹 신호는 아님 |
| 매일 릴스1+카드1+스토리4 | 2026 통설보다 공격적. 권장: 릴스 주 2~4, 캐러셀 주 1~3, 스토리 거의 매일. 몰아 올리면 노출 저하 |
| 공유/저장이 핵심 신호 | **사실** (Mosseri 2025-01 공식 top3: 시청시간·좋아요·전송(DM 공유)). 전송=비팔로워 도달, 좋아요=팔로워 도달 |

**⚠️ 이 시스템의 1순위 리스크 = 독창성(애그리게이터) 페널티.** 대응:
1. 자체 디자인 템플릿 + AI 자체 요약/논평/인사이트 결합 (단순 재게시 금지)
2. 릴스에 실제 모션(카드 전환 애니메이션, 자막 모션), 첫 3초 후크
3. 계정 상태(Account Status) 도구로 추천 제한 여부 주기 점검
4. 해시태그는 3~5개만 (2024-12 해시태그 팔로우 기능 제거됨, 도달 수단 아님). 캡션/바이오 키워드(소셜 SEO)가 더 중요

## 6. 오케스트레이션 (macOS)

- **프로세스 2개 구조**:
  - (A) 단발성 잡: launchd `StartCalendarInterval` 매일 09:00 — RSS 수집 → AI 필터 → 텔레그램 후보 전송 → 종료
  - (B) 상시 리스너: launchd LaunchAgent `KeepAlive` — 승인 콜백 수신 → 카드/릴스 생성 → 발행
- launchd는 슬립 중 놓친 잡을 기상 시 실행 (cron은 건너뜀). `sudo pmset repeat wakeorpoweron`으로 잡 직전 자동 기상
- 텔레그램 업데이트 24시간 보관 → 슬립 후에도 승인 회수됨
- launchd는 셸 환경변수 미상속 → 앱이 `.env` 직접 로드
- 24/7 필요 시: 무료 티어 대부분 소멸(fly.io 폐지, Railway 유료화, Render 슬립). 라즈베리파이(1회 비용) 또는 저가 VPS. **초기엔 Mac으로 충분**
- **AI 레이어** (에이전트 아닌 일반 Anthropic SDK 호출):
  - 뉴스 필터/랭킹: **Haiku 4.5** (`claude-haiku-4-5`, $1/$5 per MTok) ≈ $0.0075/호출
  - 한국어 카드 카피: **Sonnet 5** (`claude-sonnet-5`, 도입가 $2/$10, 2026-08-31까지) ≈ $0.011/호출
  - 구조화 출력: `output_config.format`(json_schema)으로 카드 텍스트 JSON 검증 수신
  - **월 예상 AI 비용 $1~2 미만**
- 미디어 공개 호스팅(IG API 요구): Cloudflare R2 무료 티어 등

## 7. 종합 권장 스택

| 구성 | 선택 | 이유 |
|------|------|------|
| 언어 | Node.js 또는 Python (동등) | Node: grammY+Playwright+템플릿 한 언어 / Python: PTB JobQueue+Pydantic 성숙 |
| RSS | feed-parser(Node) / feedparser(Py) | 유지보수 활발 |
| AI | Anthropic SDK — Haiku 4.5(필터) + Sonnet 5(카피) | 월 $1~2 |
| 렌더링 | Playwright + Pretendard + HTML/CSS 템플릿 | 4:5 카드 + 9:16 릴스 변형 |
| 영상 | ffmpeg (H.264/AAC/faststart) + Pixabay BGM | API 릴스 5~90초 |
| 승인 | Telegram 봇 (롱 폴링, 인라인 버튼) | 로컬 최적 |
| 발행 | IG Graph API v25.0 (Instagram Login, 캐러셀+릴스) | App Review 불필요 (본인 계정) |
| 호스팅 | Mac + launchd (초기) → 필요 시 라즈베리파이 | 비용 0 |
| 미디어 호스팅 | Cloudflare R2 (공개 URL) | IG API 필수 요건 |
| 상태 저장 | SQLite | 후보/승인/발행 상태 |

## 8. 사람이 결정해야 할 것 (자동화 불가)

1. **계정 주제/컨셉** — 영상에서 가장 어려웠고 성패를 가른 요소. 영상 교훈: 뉴스 > 해외이슈 > AI뉴스 순으로 성과
2. 카드 디자인 템플릿 구조 (요소 구성/배치)
3. 계정 이름 + 프로필 4줄 (슬로건/이력/가치/CTA)
4. 스택 언어 선택 (Node vs Python)
5. 자동화 수준 (반자동: 승인 후 수동 업로드 / 완전 자동: 승인 버튼만)
