# CardNews 자동화 시스템 설계 (2026-07-23)

AI가 매일 뉴스를 수집·선별해 카드뉴스를 만들고, 텔레그램 승인 버튼 하나로 인스타그램에 캐러셀+릴스를 완전 자동 발행하는 시스템.

참고 문서: `docs/video-analysis.md`(원본 영상 분석), `docs/prep-research.md`(기술 리서치, 2026-07-23 검증).

## 확정된 결정

| 항목 | 결정 |
|------|------|
| 계정 주제 | 오늘의 뉴스 (국내외 뉴스 요약) |
| 언어 | Node.js |
| 자동화 수준 | 완전 자동 (텔레그램 발행 버튼 → 캐러셀+릴스 자동 업로드) |
| 실행 환경 | macOS 로컬 + launchd (초기) |
| AI | Anthropic SDK — Haiku 4.5(필터/랭킹) + Sonnet 5(카드 카피, json_schema 구조화 출력) |
| 발행 | Instagram Graph API v25.0, Instagram Login 방식 (본인 계정, App Review 불필요) |
| 미디어 호스팅 | Cloudflare R2 공개 버킷 |
| 상태 저장 | SQLite (better-sqlite3) |

## 범위

**v1 포함**: RSS 수집 → AI 선별/카피 → 텔레그램 승인 → 카드 4:5 JPEG + 릴스 9:16 영상 생성 → R2 업로드 → IG 캐러셀+릴스 자동 발행 → 결과 보고. 토큰 자동 갱신. 발행 이력/상태 DB.

**v1 제외** (추후): AI 배경 이미지 생성(v1은 템플릿 배경만), 스토리 발행, 성과 분석(인사이트 API), 다중 계정, 해외 소스 원문 페이지 크롤링(발췌 RSS로 시작), 라즈베리파이/VPS 이전.

## 아키텍처

프로세스 2개 + 공유 모듈. 각 모듈은 단일 책임, 명확한 함수 인터페이스로 분리해 독립 테스트 가능하게 한다.

```
process A: daily-digest (launchd StartCalendarInterval 09:00, 실행 후 종료)
  collector → curator → bot.sendDigest → 종료

process B: bot-listener (launchd KeepAlive, 상시 상주)
  grammY 롱 폴링 → 승인 콜백 → pipeline: renderer → video → storage → publisher → bot.report
```

```
src/
  collector/   RSS 수집·정규화·중복제거      → NewsItem[]
  curator/     AI 필터·랭킹·카드 카피 생성    → CardDraft (Haiku 4.5 / Sonnet 5)
  bot/         텔레그램 다이제스트·승인·보고   (grammY, 롱 폴링)
  renderer/    HTML 템플릿 → JPEG 카드       (Playwright, Pretendard 임베드)
  video/       카드 → 릴스 mp4               (ffmpeg + BGM, ffprobe 검증)
  storage/     R2 업로드 → 공개 URL          (@aws-sdk/client-s3 호환)
  publisher/   IG Graph API 발행             (캐러셀 + 릴스, 토큰 갱신)
  db/          SQLite 상태·이력
  jobs/        daily-digest.ts, bot-listener.ts (엔트리포인트)
templates/     card.html (1080×1350), reel.html (1080×1920), 폰트, BGM 파일
launchd/       plist 2개 (com.cardnews.digest, com.cardnews.bot)
```

## 데이터 모델 (SQLite)

- `news_items`: id, source, url(정규화, UNIQUE), title, summary, published_at, collected_at
- `candidates`: id, news_item_id, rank, ai_reason, card_json(카드별 텍스트), status(`pending`→`approved`/`skipped`→`generating`→`uploaded`→`published`/`failed`), telegram_message_id, created_at
- `publishes`: id, candidate_id, ig_carousel_id, ig_reel_id, published_at, error
- `meta`: key-value (IG 토큰, 토큰 만료일, content_publishing_limit 캐시)

`callback_data`는 `pub:<candidate_id>` / `skip:<candidate_id>`만 싣는다 (64바이트 제한).

## 컴포넌트 상세

### collector
- 피드 목록(설정 파일): BBC World, Guardian World, Google News Reuters 프록시, ZDNet Korea, 전자신문 오늘의뉴스(`rss.etnews.com/Section901.xml`), AI타임스. 국내외 균형은 curator가 조절
- `@rowanmanning/feed-parser` 사용. 어댑터 계층에서 http:// 피드 허용, 인코딩(EUC-KR 가능성)·pubDate 편차 정규화
- 중복 제거: URL 정규화(UTM 제거) + 제목 유사도. 이미 `news_items`에 있는 URL은 스킵
- 피드별 HTTP 상태·최신 pubDate 로깅 (죽은 피드 감지)

### curator
- 1단계 필터/랭킹 (Haiku 4.5): 최근 24h 수집분 → 카드뉴스 적합도 랭킹 상위 5~8건, 선정 사유 포함
- 2단계 카드 카피 (Sonnet 5, `output_config.format` json_schema): 후보당 카드 3~4장 텍스트 생성
  - 카드 구성: ① 표지(후킹 헤드라인) ②~③ 본문(핵심 사실) ④ 마무리(요약/인사이트 + 저장·공유 유도)
  - **저작권/독창성 규칙을 시스템 프롬프트에 고정**: 사실만 자기 표현으로 재작성, 원문 문장 복사 금지, 자체 인사이트 한 줄 포함, 출처 매체명 필드 필수
  - 캡션도 함께 생성: 앞부분 검색 키워드 + 해시태그 3~5개

### bot (grammY)
- 다이제스트: 후보별 제목+요약+사유 텍스트 메시지에 `[발행][스킵]` 인라인 버튼. 프리뷰 이미지는 발행 승인 후 생성하므로 다이제스트엔 텍스트만 (렌더링 비용 절약)
- 콜백: `answerCallbackQuery` → 버튼을 "⏳ 생성 중…"으로 교체(중복 탭 방지) → 파이프라인 실행
- 완료 시: 생성된 카드 앨범(`sendMediaGroup`) + 발행 결과·IG 링크 후속 메시지. 실패 시 에러 요약 전송, status=`failed`
- 허용 chat_id 화이트리스트 (본인만 조작 가능)

### renderer (Playwright)
- `card.html` 템플릿: 1080×1350 고정 body, Pretendard `@font-face` 로컬 woff2, 데이터는 JSON 주입
- viewport 1080×1350 + deviceScaleFactor 1, `document.fonts.ready` 대기 후 JPEG 캡처 (품질 90)
- `reel.html`: 1080×1920 전용 변형 (4:5 재활용 금지 — 텍스트 축소 방지)
- **첫 카드부터 4:5 통일** (캐러셀은 첫 장 비율로 전체 크롭됨)
- 템플릿 디자인은 구현 단계에서 사용자와 확정 (사람 몫)

### video (ffmpeg)
- 릴스 프레임 JPEG를 filter_complex `xfade`로 카드당 3.5초 + 카드 간 크로스페이드 합성 (독창성 페널티 대응 — 정적 나열 회피). xfade 구현이 막히면 concat demuxer(마지막 file 줄 반복 — duration 무시 버그 대응)로 폴백하되 모션 강화를 후속 과제로 명시
- BGM: `assets/bgm/`의 Pixabay Music 트랙 중 랜덤 선택, `-stream_loop -1` + `-shortest`
- 인코딩: libx264 high, yuv420p, 30fps, 6M(max 8M), AAC 192k 48kHz, `+faststart`, 총 10~15초 (API 릴스 자격 5~90초)
- ffprobe로 코덱/픽셀포맷/faststart 자동 검증 후 통과 시에만 업로드

### storage (R2)
- 공개 버킷에 `{candidate_id}/card-N.jpg`, `{candidate_id}/reel.mp4` 업로드 → 공개 URL 반환
- 발행 완료 후 파일 유지 (IG가 fetch 완료해도 즉시 삭제하지 않음, 정리는 수동/추후)

### publisher (IG Graph API v25.0)
- 캐러셀: 카드별 자식 컨테이너 생성 → CAROUSEL 부모 → `media_publish`
- 릴스: REELS 컨테이너(`video_url`, `cover_url`=첫 카드 9:16, `share_to_feed=true`) → `status_code` 폴링(60초 간격, 최대 5분) → FINISHED 후 `media_publish`
- 발행 전 `content_publishing_limit` 확인. 각 단계 creation_id/에러 로깅, 실패 시 1회 재시도 후 텔레그램 보고
- 토큰: long-lived(~60일), launchd 주간 잡 또는 daily-digest에서 만료 7일 전 자동 갱신, `meta` 테이블에 저장

## 에러 처리 원칙

- daily-digest: 피드 일부 실패해도 나머지로 진행. AI 호출 실패 시 1회 재시도, 최종 실패 시 텔레그램 에러 알림
- 파이프라인: 단계별 실패 지점을 status와 함께 DB 기록, 텔레그램에 어느 단계에서 실패했는지 보고. 재시도는 `[재시도]` 버튼으로 수동 트리거 (v1은 자동 무한 재시도 없음)
- 컨테이너 24h 만료: 생성 즉시 발행하므로 통상 무관, 발행 지연 시 컨테이너 재생성
- Mac 슬립: launchd 캐치업 + `pmset repeat wakeorpoweron` 08:55 설정(문서화), 텔레그램 24h 업데이트 보관으로 승인 유실 없음

## 시크릿/설정

- `.env` (gitignore): `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `IG_USER_ID`, `IG_ACCESS_TOKEN`, `R2_*`
- launchd는 셸 env 미상속 → 엔트리포인트에서 dotenv 직접 로드
- `config.ts`: 피드 목록, 다이제스트 시각(09:00), 카드 수, 카드당 초 등

## 테스트 전략

- 단위: collector 정규화/중복제거, curator 스키마 검증(AI는 목킹), video concat 파일 생성 로직, publisher API 페이로드 구성 (nock 목킹)
- 통합: renderer는 실제 Playwright로 골든 이미지 크기/포맷 검증 (1080×1350 JPEG). video는 실제 ffmpeg로 샘플 생성 → ffprobe 검증
- E2E 드라이런 모드: `DRY_RUN=1`이면 IG 발행 대신 로컬 저장 + 텔레그램 보고만. 실계정 발행 전 전체 흐름 검증용
- 수동 검수: 첫 실발행은 테스트 게시물로 하고 결과 확인 후 운영 시작

## 사람이 할 일 (구현과 병행)

1. 인스타그램 계정 생성 + 프로페셔널(Creator) 전환
2. Meta for Developers 앱 생성, Instagram Login 설정, 본인 계정 역할 추가, 토큰 발급
3. Cloudflare R2 버킷 생성 + 공개 도메인 설정
4. 텔레그램 @BotFather 봇 생성
5. 카드 템플릿 디자인 확정 (구현 중 시안 보고 결정)
6. 계정 이름 + 프로필 4줄 (슬로건/이력/가치/CTA)
7. Pixabay Music BGM 트랙 3~5개 다운로드

## 리스크와 대응

| 리스크 | 대응 |
|--------|------|
| 독창성 페널티 (2026-04 확대, 1순위) | 자체 표현 재작성 + 인사이트 강제(프롬프트), 자체 디자인, 릴스 크로스페이드 모션. 운영 중 Account Status 주기 점검. 도달 정체 시 모션/논평 강화 |
| 저작권 | 원문 문장·사진 미사용, 출처 표기, 사실 위주 선별 |
| API 스펙 변경 | v25.0 고정 호출, 에러 로깅으로 조기 감지 |
| Mac 슬립/재부팅 | launchd 캐치업 + 자동 기상, 텔레그램 24h 보관 |
| 발행 한도 | 하루 수 건 규모라 100건/24h 한도 여유. 발행 전 잔여량 확인 |
