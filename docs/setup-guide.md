# 세팅 가이드: 사람이 할 일 7가지 (2026-07-23 기준, 절차 검증 완료)

구현 전/중에 직접 해야 하는 항목. 1~4번은 외부 서비스 세팅, 5~6번은 기획 결정, 7번은 자료 확보.
전 항목 **무료** (본인 계정 발행이므로 Meta App Review 불필요).

---

## 1. 인스타그램 계정 생성 + 프로페셔널(Creator) 전환

1. Instagram 앱에서 새 계정 가입. **크리에이터 계정은 반드시 공개(Public)** 여야 발행 API가 동작
2. 프로필 → 우측 상단 **≡ 메뉴** → **설정 및 활동(Settings and activity)**
3. 스크롤 → **프로페셔널을 위한(For professionals)** → **계정 유형 및 도구(Account type and tools)**
4. **프로페셔널 계정으로 전환** → **크리에이터(Creator)** 선택 → 다음
5. 카테고리 선택 (예: 디지털 크리에이터). **"Facebook 페이지 연결" 단계가 나오면 건너뛰기(Skip)** — Instagram Login 방식은 페이지 불필요

## 2. Meta for Developers 앱 생성 + Instagram Login + 토큰 발급

### (B) 앱 생성
1. https://developers.facebook.com/ → **My Apps** → **Create App** (직접: https://developers.facebook.com/apps/create/)
2. 유스케이스 선택 화면에서 **"Other"** → **Next** → 앱 타입 **"Business"** → **Next**
   (대안: "Manage messaging and content on Instagram" 유스케이스 직접 선택도 가능하나 Other→Business가 토큰 생성기 접근이 깔끔)
3. 앱 이름 입력 — ⚠️ **이름에 "Instagram"/"Facebook" 단어 넣으면 거부됨** → **Create App**
4. 대시보드에서 **Instagram** 제품 찾아 **Set up**
5. 좌측 **Instagram** → **"API setup with Instagram business login"** 선택 (⚠️ "with Facebook login" 아님)
   - 이 화면의 **Instagram App ID / App Secret** 복사해 둘 것 (토큰 교환에 필요)
6. 비즈니스 인증(Business Verification) 요구 화면이 나와도 **본인 계정만 쓸 경우 불필요** — 건너뜀

### (C) 본인 계정을 테스터로 추가 (App Review 없이 발행하는 핵심)
1. **API setup with Instagram business login** → **"1. Generate access tokens"** 섹션 → **Add account** → 1번에서 만든 계정으로 로그인/승인
   (대안 경로: **App roles → Roles → Add Instagram Testers**)
2. **초대 수락 (필수 — 안 하면 토큰 동작 안 함)**: Instagram 앱 → 설정 및 활동 → **웹사이트 권한(Website permissions)** → **앱 및 웹사이트(Apps and websites)** → **테스터 초대(Tester invites)** 탭 → **수락**
3. 앱은 **Development 모드 유지**. 테스터 계정은 `instagram_business_basic` + `instagram_business_content_publish`에 Standard Access → **App Review 없이 발행 가능**

### (D) 토큰 발급 → 60일 토큰 전환 → 갱신
1. **"2. Generate token"**에서 계정 옆 **Generate token** 클릭 → 로그인/승인 → 토큰 표시
   - ⚠️ **화면에 한 번만 표시됨 — 즉시 복사해 `.env` 저장.** 이건 ~1시간짜리 단기 토큰
2. 장기(60일) 토큰 교환:
   ```
   GET https://graph.instagram.com/access_token
       ?grant_type=ig_exchange_token
       &client_secret=<INSTAGRAM_APP_SECRET>
       &access_token=<단기_토큰>
   ```
3. 갱신 (만료 전 반복, 시스템이 자동화할 예정):
   ```
   GET https://graph.instagram.com/refresh_access_token
       ?grant_type=ig_refresh_token
       &access_token=<장기_토큰>
   ```
   - 조건: 발급 후 24시간 경과 + 만료 전. ⚠️ **60일 내 갱신 없으면 영구 만료 → 재발급**

### (E) IG User ID 확인
- 대시보드 **API setup** 화면 상단에 표시, 또는:
  ```
  GET https://graph.instagram.com/v25.0/me?fields=user_id,username&access_token=<토큰>
  ```
- 이 `user_id`를 발행 엔드포인트(`POST /{user_id}/media`, `/media_publish`)에 사용. API 버전은 프로젝트 표준 v25.0 사용

**공식 문서**: [Instagram Platform 시작하기](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started) · [Business Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login) · [토큰 갱신](https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/)

## 3. Cloudflare R2 버킷 생성 + 공개 접근 설정

1. **계정 생성**: https://dash.cloudflare.com/sign-up → 이메일 인증. 도메인 없어도 r2.dev 공개 URL 사용 가능
2. **R2 활성화**: 좌측 **R2 Object Storage** (직접: https://dash.cloudflare.com/?to=/:account/r2/overview) → 첫 구독 추가 플로우 진행. 무료 티어 시작은 카드 불필요, $0 표시. 운영 안정성 위해 카드 등록 권장 (무료 한도 내 청구 없음)
3. **무료 한도** ([요금](https://developers.cloudflare.com/r2/pricing/)): 저장 10GB/월, 쓰기 100만 건, 읽기 1,000만 건, **egress 무제한 무료** → 이 프로젝트엔 충분
4. **버킷 생성**: **Create bucket** → 이름 `cardnews-assets` (소문자·숫자·하이픈) → Location: Automatic (힌트 APAC 가능) → Standard
5. **공개 접근** — 시작은 (a), 도메인 있으면 (b):
   - (a) **r2.dev 개발 URL**: 버킷 → **Settings** → **Public Development URL** → **Enable** → 팝업에 `allow` 입력 → `https://pub-<해시>.r2.dev/<파일명>` 형식 URL 생성. ⚠️ rate limit 있음(개발용) — 우리 용도(IG가 발행 시 1회 fetch)로는 충분
   - (b) **커스텀 도메인**: 도메인이 같은 Cloudflare 계정 zone에 있어야 함. 버킷 Settings → **Custom Domains** → **Add** → 서브도메인 입력 → CNAME 자동 생성 → **Active** 될 때까지 대기(보통 수 분)
6. **API 토큰**: R2 Overview → **API → Manage API Tokens** → **Create API Token** → 이름 `cardnews-uploader` → 권한 **Object Read & Write** → **Apply to specific buckets only**로 해당 버킷만 → 생성
   - ⚠️ **Secret Access Key는 이 화면에서만 표시 — 즉시 `.env` 저장**
7. **SDK 설정값**: endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (Account ID는 R2 Overview 우측), region `auto`, `@aws-sdk/client-s3` 사용

## 4. 텔레그램 @BotFather 봇 생성 (5분, 심사 없음)

1. 텔레그램에서 `@BotFather` 검색 — ⚠️ **파란 인증 체크마크 확인** (가짜 계정 주의)
2. `/start` → `/newbot` → 표시 이름 입력 (예: `카드뉴스 알림봇`) → 사용자명 입력 (`bot`으로 끝나야 함, 예: `mycardnews_bot`, **변경 불가**)
3. 토큰 발급됨 (`1234567890:ABC...` 형식) → `.env` 저장. 노출 시 `/revoke`로 재발급
4. **봇과 대화 시작 (필수)**: 만든 봇 검색 → **Start** 클릭. 안 하면 봇이 먼저 메시지 못 보냄 (403 오류)
5. **chat_id 확인**:
   - 방법 A: `@userinfobot`에게 아무 메시지 → 숫자 Id 응답 (2026-07 현재 작동)
   - 방법 B: `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` → JSON의 `"chat":{"id":...}` (비어 있으면 봇에게 먼저 메시지 전송)
6. 선택: `/setdescription`, `/setuserpic`. 그룹 프라이버시는 기본값 유지

## 5. 카드 템플릿 디자인 확정

구현 단계에서 Playwright 렌더링 시안을 보고 결정하는 항목. 미리 정해둘 것:

### 결정할 요소
1. **컬러 스킴**: 뉴스 계정은 신뢰감 — 영상 속 전문가 평가에서 "언론사 느낌" 디자인이 팔로우 전환에 유리했음. 추천: 다크 네이비/화이트 + 포인트 컬러 1개(레드/블루)
2. **카드 구조** (4:5, 1080×1350):
   - 표지: 대형 헤드라인 + 카테고리 뱃지 + 계정 로고 — 첫 3초 후크 역할
   - 본문 2장: 핵심 사실 2~3줄 + 보조 텍스트, 시각 요소(아이콘/숫자 강조)
   - 마지막: 한 줄 요약/인사이트 + "저장해두고 다시 보기" / "친구에게 공유" CTA + 출처 표기
3. **고정 요소**: 상단 계정명/로고, 하단 페이지 인디케이터(1/4), 출처 라인 — 매 카드 동일 위치 (브랜드 일관성 = 독창성 인정에도 유리)
4. **폰트 위계**: Pretendard — 헤드라인 ExtraBold 64~80px / 본문 Medium 40~48px / 캡션 Regular 28~32px (1080px 기준)
5. **릴스 변형** (9:16, 1080×1920): 같은 컬러/폰트, 상하 여백 확장 + 텍스트 확대. 안전 영역: 상단 220px·하단 420px은 UI에 가려질 수 있으므로 핵심 텍스트 배치 금지

### 진행 방식
renderer 모듈 완성 시 시안 3종(라이트/다크/포인트컬러 변형)을 실제 뉴스 1건으로 렌더링해 보고 → 선택 → 미세 조정. 별도 디자인 툴 불필요.

## 6. 계정 이름 + 프로필 4줄

### 계정 이름
영상 교훈: 이름에 시간 쓰지 말 것 (유튜버는 "뉴스여기스"를 즉석에서 지음). 조건:
- 한글 2~5자, 발음 쉬움, "뉴스" 포함 시 검색(소셜 SEO) 유리
- 인스타 사용자명(영문)도 함께: 예) 계정명 "뉴스브리핑" / @news.briefing.kr
- 후보 예시: 뉴스한입, 오늘뉴스요약, 뉴스3분, 데일리뉴스컷 — 최종은 본인 취향으로 결정

### 프로필 4줄 (6만 팔로워 전문가 조언 구조)
```
① 슬로건: "3분이면 충분한 오늘의 핵심 뉴스"
② 이력/사회적 증거: "매일 아침 국내외 뉴스 큐레이션" (초기엔 증거가 없으므로 운영 방식을 씀)
③ 제공 가치: "복잡한 뉴스, 카드 4장으로 정리"
④ CTA: "팔로우하면 매일 핵심 뉴스 5개를 받아봅니다 👇"
```
- 검색 키워드("뉴스", "시사", "요약")를 자연스럽게 포함할 것
- 참고: 최적화 프로필의 방문→팔로우 전환율 업계 통설 10~15% (`docs/prep-research.md` 5절)
- 운영 시작 후 조회수 대비 팔로우 전환이 낮으면 이 4줄부터 A/B 조정

## 7. Pixabay Music BGM 트랙 3~5개 다운로드

1. **계정**: 다운로드 자체는 비로그인 가능(캡차 있음). **무료 가입 권장** — 캡차 제거 + **라이선스 증명서(License Certificate)** 발급 가능: https://pixabay.com/accounts/register/
2. **다운로드**: https://pixabay.com/music/ → 검색/필터 → 미리듣기 → **Download** (MP3)
   - 필터: Genre / Mood / Duration / **Content type** — 2026년 신설 **Authentic / AI-generated** 구분, **Authentic 권장**
   - Duration 60초 이상 트랙이 10~15초 구간 잘라 쓰기 좋음
3. **추천 검색어**: `news`, `corporate`, `documentary`, `minimal`, `upbeat corporate` (예: https://pixabay.com/music/search/news/)
   - 무드: Calm(차분) / Serious(진지) / Uplifting(경쾌) 3종을 섞어 확보
4. **라이선스** ([요약](https://pixabay.com/service/license-summary/) · [약관](https://pixabay.com/service/terms/)): 상업 사용 무료, 출처 표기 불필요. 금지는 음원 단독 재배포뿐 — 릴스 배경음 사용은 문제없음
5. **⚠️ 증거 보관 (분쟁 대비)**: 트랙별로 상세 페이지 URL + 라이선스 문구 보이는 스크린샷 + 로그인 상태에서 발급한 License Certificate PDF를 `assets/bgm/licenses/`에 보관. 클레임 발생 시 이 증명서로 해제 가능
6. **클레임 주의**: 일부 인기 트랙은 Content ID 등록되어 있어 클레임 가능 → 중간 인기 트랙 위주, 여러 트랙 분산 사용, 클레임 트랙은 교체
7. **대체 소스** (Pixabay 트랙 클레임 시):
   - **Uppbeat** https://uppbeat.io/ — 무료 티어 월 3회 + 크레딧 표기 필수, 유료 플랜은 무제한
   - **Chosic** https://www.chosic.com/free-music/ — CC0/CC-BY 혼재, [표기 불필요 필터](https://www.chosic.com/free-music/all/?attribution=no) 사용, 트랙별 라이선스 확인 필수
   - ⚠️ **YouTube Audio Library는 사용 금지** — 라이선스가 유튜브 플랫폼 한정이라 인스타 사용 시 근거 없음 (`docs/prep-research.md` 4절 검증 결과)

---

## 진행 순서 요약

| 순서 | 항목 | 소요 | 대기/주의 |
|------|------|------|-----------|
| 1 | 인스타 계정 + Creator 전환 | 10분 | 공개 계정 필수 |
| 2 | Meta 앱 + 토큰 | 30분 | 토큰 1회만 표시, 60일 갱신 룰 |
| 3 | R2 버킷 | 15분 | Secret 1회만 표시 |
| 4 | 텔레그램 봇 | 5분 | 봇에게 먼저 말 걸기 |
| 7 | BGM 다운로드 | 20분 | 라이선스 증거 보관 |
| 6 | 계정 이름/프로필 | 구현 전 아무 때나 | — |
| 5 | 템플릿 디자인 | 구현 중 시안 보고 | — |

완료한 값들은 프로젝트 루트 `.env`에 채워 넣음 (구현 시 `.env.example` 제공 예정):
`IG_USER_ID`, `IG_ACCESS_TOKEN`, `IG_APP_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`, `ANTHROPIC_API_KEY`
