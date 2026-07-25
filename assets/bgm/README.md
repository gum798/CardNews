# BGM 트랙

릴스 배경음. 모두 [Pixabay Music](https://pixabay.com/music/) — 상업 사용 무료, 출처 표기 불필요, **음원 단독 재배포만 금지**.
따라서 `.mp3` 파일과 `licenses/`는 `.gitignore` 처리 (이 저장소는 공개). 로컬에만 보관한다.

video 모듈이 이 폴더에서 트랙을 랜덤 선택해 사용한다 (`-stream_loop -1` + `-shortest`).

## 트랙 목록 (2026-07-25 확보, 5종)

| 파일 | 길이 | 무드 |
|------|------|------|
| paulyudin-breaking-news-494566.mp3 | 116.0s | breaking news |
| sigmamusicart-news-news-background-520540.mp3 | 85.0s | news background |
| sigmamusicart-breaking-news-252187.mp3 | 82.4s | breaking news |
| krasnoshchok-news-breaking-news-music-529078.mp3 | 70.1s | breaking news |
| monume-breaking-news-547918.mp3 | 84.0s | breaking news |

모두 mp3 44.1/48kHz, 70초 이상 → 10~15초 클립에 충분. video 인코딩 시 AAC 192k/48kHz로 재인코딩됨.

## ⚠️ 라이선스 증거 보관 (분쟁 대비)

각 트랙의 License Certificate PDF를 `licenses/`에 저장할 것 (Pixabay 로그인 → 트랙 상세 → 라이선스 증명서 발급).
Content ID 클레임 발생 시 이 증명서로 해제한다. 클레임 잦은 트랙은 교체.
