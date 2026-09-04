#!/usr/bin/env python3
"""ZeroGPU로 인트로 클립 1개 생성 (본인 소유 Space 호출).

왜 원격인가: 로컬 영상 생성은 이 맥의 Metal wired 한도(17.76 GiB)에 5회 전부 막혔다.
             원격은 그 벽이 아예 없다.

⚠️ 무료 할당은 5분/일이고 **Space가 아니라 호출 계정** 기준이다.
   무거운 모델은 클립당 2분 넘게 먹어 하루 2개가 현실이다(2026-09-02 실측).
   그래서 이건 「모든 게시물」이 아니라 「하루 인트로 1개」용이다.
   분량은 tools/reel/ 의 ffmpeg 릴스가 만든다 — 그쪽은 무제한이고 공짜다.

⚠️ 반드시 본인 소유 Space만 호출한다. 남의 Space를 스크립트로 두드리는 건
   약관상 회색지대라 쓰지 않는다.
"""
import os, sys, shutil, argparse, json, re, time

# scripts/ 아래에 있으므로 한 단계 위가 리포 루트. .env와 out/ 경로의 기준.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ⚠️ 이 맥은 회사 TLS 검사(SK C&C CA) 뒤에 있다. 설정 안 하면
#    httpx.ConnectError: CERTIFICATE_VERIFY_FAILED 로 죽는다(실측).
_CA = "/Users/seojeonghwa/models/localgen/ca-bundle.pem"
if os.path.exists(_CA):
    os.environ.setdefault("SSL_CERT_FILE", _CA)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", _CA)

def save_quota(msg):
    """HF가 거절하며 알려준 실제 잔량을 out/zerogpu-quota.json에 남긴다.

    src/persona/zerogpu-budget.js의 remaining()이 이 파일을 우리 추정보다 우선한다 —
    ZeroGPU는 롤링 24시간 창이라 자체 장부로는 잔량을 정확히 못 센다.
    메시지 예: "You have exceeded your GPU quota (62s requested vs. 16s left). Try again in 1:23:45"
    잔량 숫자를 못 읽으면 쓰지 않는다(엉터리 값으로 장부를 덮는 것보다 낫다).
    """
    m = re.search(r"(\d+(?:\.\d+)?)\s*s\s*left", msg, re.I) or re.search(r"left[^\d]{0,10}(\d+(?:\.\d+)?)\s*s", msg, re.I)
    if not m:
        return
    left = int(float(m.group(1)))
    t = re.search(r"(\d+):(\d{2}):(\d{2})", msg)
    reset = int(t.group(1)) * 3600 + int(t.group(2)) * 60 + int(t.group(3)) if t else 3600
    try:
        os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
        with open(os.path.join(ROOT, "out", "zerogpu-quota.json"), "w") as f:
            json.dump({"checkedAt": int(time.time()), "secondsLeft": left, "resetInSec": reset}, f)
        print(f"[zerogpu] 실제 잔량 기록: {left}초 남음, {reset}초 뒤 회복", file=sys.stderr)
    except OSError as e:
        print(f"[zerogpu] 잔량 기록 실패: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True, help="첫 프레임으로 쓸 하나 사진")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--kind", default="h3",
                    help="h3 / wan, 또는 폴백 사슬 'h3,wan' (앞부터 시도, 붐비거나 실패하면 다음)")
    ap.add_argument("--space", default=None, help="비우면 --kind의 기본 Space")
    ap.add_argument("--canvas", default="544x960 · 9:16 fast", help="세로. 짧은 변이 작을수록 할당량을 덜 쓴다")
    ap.add_argument("--duration", type=float, default=3)
    ap.add_argument("--steps", type=float, default=None, help="비우면 h3=6 / wan=4")
    ap.add_argument("--seed", type=float, default=42)
    ap.add_argument("--timeout", type=int, default=900, help="최대 대기 초")
    ap.add_argument("--lora", default="larry", help="터보 LoRA: larry / lightx / off")
    a = ap.parse_args()

    token = os.environ.get("HF_TOKEN")
    if not token:
        # .env에서 읽는다. 토큰은 .env에만 두고 코드·로그에 남기지 않는다.
        envp = os.path.join(ROOT, ".env")
        if os.path.exists(envp):
            for line in open(envp):
                if line.startswith("HF_TOKEN="):
                    token = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    if not token:
        print("HF_TOKEN 없음 (.env에 넣어주세요)", file=sys.stderr); return 2

    # ⚠️ kind가 'h3,wan'이면 앞부터 시도하고, 붐빔(pool at capacity)·실패면 다음으로 넘어간다.
    #    H3 Turbo는 인기가 많아 자주 붐비는데(실측 2026-09-03), 붐빔은 할당량과 무관하므로
    #    WAN으로 넘어가면 대개 바로 된다. WAN은 16fps라 호출부에서 30fps 보간이 필요하다.
    kinds = [k.strip() for k in a.kind.split(',') if k.strip()]
    # ⚠️ generate_one()이 비어 있는 a.space / a.steps를 kind 기본값으로 채워 넣는다.
    #    그대로 두면 두 번째 kind가 첫 kind의 Space·스텝을 물려받아(h3 → wan 폴백이
    #    H3 Space에 WAN 인자를 던져 실패) 폴백이 한 번도 동작하지 않았다.
    #    → 명령줄에서 받은 값만 기억해 두고 kind마다 되돌린다.
    cli_space, cli_steps = a.space, a.steps
    last_rc = 1
    for ki, kind in enumerate(kinds):
        a.space, a.steps = cli_space, cli_steps
        if len(kinds) > 1:
            print(f'[zerogpu] 시도 {ki+1}/{len(kinds)}: {kind}', file=sys.stderr)
        rc = generate_one(a, kind, token)
        if rc == 0:
            return 0
        last_rc = rc
        # rc=3(할당량/붐빔 거절)일 때만 다음 kind로 폴백한다. rc=1(진짜 오류)이면 멈춘다.
        if rc != 3:
            return rc
    return last_rc


def generate_one(a, kind, token):
        DEFAULT_SPACE = {"h3": "gum798/MiniMax-H3-Turbo-Lora",
                         "wan": "gum798/WAN2.2_I2V_LIGHTNING_4-8step_custom"}
        if not a.space:
            a.space = DEFAULT_SPACE[kind]
        if a.steps is None:
            a.steps = 6.0 if kind == "h3" else 4.0

        from gradio_client import Client, handle_file
        print(f"[zerogpu] {a.space} 접속", flush=True)
        # ⚠️ 기본 httpx 읽기 타임아웃이 짧아 생성 중 스트림이 끊긴다
        #    ("The read operation timed out" — submit()으로 바꿔도 동일하게 발생, 실측).
        #    연결은 짧게, 읽기는 길게 잡는다.
        import httpx
        client = Client(a.space, token=token,
                        httpx_kwargs={"timeout": httpx.Timeout(connect=30.0, read=a.timeout,
                                                               write=120.0, pool=30.0)})

        print(f"[zerogpu] 생성 요청 · {a.duration}초 · {a.steps}스텝 · {kind}", flush=True)
        # ⚠️ predict()는 기본 읽기 타임아웃이 짧아 긴 생성에서 "The read operation timed out"으로 끊긴다(실측).
        #    submit()으로 던져두고 폴링한다 — 서버는 계속 만들고 있으므로 기다리기만 하면 된다.
        import time
        try:
            if kind == "h3":
                # H3 Space는 파라미터 이름이 없어 위치 인자로 넘긴다(app.py의 generate_video 순서).
                job = client.submit(
                    a.prompt, handle_file(a.image), None, a.canvas,
                    a.duration, a.steps, a.seed, False, a.lora,
                    api_name="/output_video")
            else:
                # WAN Lightning은 이름 있는 파라미터를 준다. 4스텝이라 할당량을 훨씬 덜 쓴다.
                job = client.submit(
                    input_image=handle_file(a.image), last_image=None, prompt=a.prompt,
                    steps=a.steps, duration_seconds=a.duration, seed=a.seed, randomize_seed=False,
                    api_name="/generate_video")
        except ValueError as e:
            # ⚠️ Space가 잠들었거나(무료 Space는 48시간 놀면 잠든다) 재빌드 중이면 API 목록이 비어
            #    "Cannot find a function with `api_name`: /generate_video"가 난다(실측 2026-09-04 10:00,
            #    같은 Space가 14시에는 정상). 할당량 문제가 아니라 「지금 못 받음」이므로 rc=3으로
            #    돌려 다음 kind로 넘어가게 한다. 예전엔 예외가 그대로 터져 rc=1로 사슬이 끊겼다.
            if "api_name" in str(e):
                print(f"[zerogpu] {a.space} 엔드포인트 없음(잠들었거나 재빌드 중) → 건너뜀: {str(e)[:200]}", file=sys.stderr)
                return 3
            raise

        waited = 0
        while not job.done():
            time.sleep(10); waited += 10
            if waited % 60 == 0:
                print(f"[zerogpu] 대기 {waited}초...", flush=True)
            if waited > a.timeout:
                print(f"[zerogpu] {a.timeout}초 초과 → 포기", file=sys.stderr); return 4
        try:
            res = job.result()
        except Exception as e:
            msg = str(e)
            if "quota" in msg.lower() or "exceeded" in msg.lower() or "gpu" in msg.lower():
                save_quota(msg)
                print(f"[zerogpu] 할당량/GPU 사유로 거절됨:\n{msg[:500]}", file=sys.stderr); return 3
            print(f"[zerogpu] 실패: {msg[:800]}", file=sys.stderr); return 1

        video = res[0] if isinstance(res, (list, tuple)) else res
        path = video.get("video") if isinstance(video, dict) else video
        if isinstance(path, (list, tuple)):
            path = path[0]
        if not path or not os.path.exists(path):
            print(f"[zerogpu] 결과 파일을 못 찾음: {json.dumps(res, default=str)[:400]}", file=sys.stderr)
            return 1
        shutil.copy(path, a.out)
        print(f"[zerogpu] 완료 → {a.out}", flush=True)
        if isinstance(res, (list, tuple)) and len(res) > 1:
            print(f"[zerogpu] 리포트: {str(res[1])[:300]}", flush=True)
        return 0

if __name__ == "__main__":
    sys.exit(main())
