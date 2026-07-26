# launchd 설치

프로세스 2개: 발행 사이클 잡(A, 매일 08:00·19:00) + 상시 상주 봇 리스너(B).
발행 잡은 3주제(일반뉴스·재밌는토픽·AI뉴스) 각 1건을 수집·선별해 자동 발행한다 (하루 6건 = 주제별 2건). 한도 초과분은 텔레그램 수동 승인으로 간다.
경로는 `/Users/seojeonghwa/project/CardNews`, node는 `/opt/homebrew/bin/node` 기준으로 하드코딩돼 있음 (launchd는 셸 env·PATH를 상속하지 않음). 경로가 다르면 plist를 수정할 것.

## 설치

```sh
cp launchd/com.cardnews.publish.plist ~/Library/LaunchAgents/
cp launchd/com.cardnews.bot.plist     ~/Library/LaunchAgents/

launchctl load ~/Library/LaunchAgents/com.cardnews.publish.plist
launchctl load ~/Library/LaunchAgents/com.cardnews.bot.plist
```

## 확인 / 로그

```sh
launchctl list | grep cardnews
tail -f out/bot.log       # 봇 리스너
tail -f out/publish.log   # 발행 사이클 잡 (08시·19시)
```

## 수동 실행 (테스트)

```sh
DRY_RUN=1 npm run publish   # 3주제 수집→AI선별→발행(DRY_RUN이라 실게시 안 함)
DRY_RUN=1 npm run bot       # 봇 리스너 (승인 시 발행 대신 로컬 저장+보고)
```

## 갱신 / 제거

```sh
launchctl unload ~/Library/LaunchAgents/com.cardnews.bot.plist
# ...plist 수정 or 재복사 후...
launchctl load ~/Library/LaunchAgents/com.cardnews.bot.plist
```

## 슬립 대응

- launchd `StartCalendarInterval`은 슬립 중 놓친 08:00·19:00 실행을 깨어날 때 캐치업 (cron과 다름).
- 정시 기상 원하면: `sudo pmset repeat wakeorpoweron MTWRFSU 07:55:00`
- 텔레그램은 업데이트를 ~24h 보관하므로 봇이 잠깐 꺼져도 승인 콜백 유실 없음.
