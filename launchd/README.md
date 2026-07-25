# launchd 설치

프로세스 2개: 매시간 정각 수집 잡(A) + 상시 상주 봇 리스너(B).
수집 잡은 3주제(일반뉴스·재밌는토픽·AI뉴스) 각 1건을 수집·선별해 텔레그램으로 보낸다.
경로는 `/Users/seojeonghwa/project/CardNews`, node는 `/opt/homebrew/bin/node` 기준으로 하드코딩돼 있음 (launchd는 셸 env·PATH를 상속하지 않음). 경로가 다르면 plist를 수정할 것.

## 설치

```sh
cp launchd/com.cardnews.hourly.plist ~/Library/LaunchAgents/
cp launchd/com.cardnews.bot.plist    ~/Library/LaunchAgents/

launchctl load ~/Library/LaunchAgents/com.cardnews.hourly.plist
launchctl load ~/Library/LaunchAgents/com.cardnews.bot.plist
```

## 확인 / 로그

```sh
launchctl list | grep cardnews
tail -f out/bot.log       # 봇 리스너
tail -f out/hourly.log    # 매시간 수집 잡
```

## 수동 실행 (테스트)

```sh
DRY_RUN=1 npm run hourly   # 3주제 수집→AI선별→텔레그램 (발행 안 함)
DRY_RUN=1 npm run bot      # 봇 리스너 (승인 시 발행 대신 로컬 저장+보고)
```

## 갱신 / 제거

```sh
launchctl unload ~/Library/LaunchAgents/com.cardnews.bot.plist
# ...plist 수정 or 재복사 후...
launchctl load ~/Library/LaunchAgents/com.cardnews.bot.plist
```

## 슬립 대응

- launchd `StartCalendarInterval`은 슬립 중 놓친 09:00 잡을 깨어날 때 캐치업 (cron과 다름).
- 정시 기상 원하면: `sudo pmset repeat wakeorpoweron MTWRFSU 08:55:00`
- 텔레그램은 업데이트를 ~24h 보관하므로 봇이 잠깐 꺼져도 승인 콜백 유실 없음.
