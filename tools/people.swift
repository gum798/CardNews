// 사진에 사람이 있는지 센다. macOS 내장 Vision만 쓴다(모델 다운로드 0, 오프라인).
//
// 왜 필요한가: 장소 레퍼런스에 사람이 남아 있으면 FLUX.2가 그 사람을 편집 대상으로 삼아
//   얼굴이 그 사람으로 바뀌거나(방 실측) 옷이 그대로 끌려온다(헬스장 마사지기 실측).
//   그래서 섭외한 배경 사진은 사람이 0명인 것만 쓴다 — 그 판정을 여기서 한다.
//
// 빌드: swiftc -O tools/people.swift -o tools/people
// 사용: people <in.jpg>
//   stdout: ok faces=N humans=N
//   exit 0 = 성공 / 1 = 읽기 실패 / 2 = 인자 오류
import Foundation
import Vision
import CoreImage

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: people <in.jpg>"); exit(2) }
guard let img = CIImage(contentsOf: URL(fileURLWithPath: args[1])) else { print("cannot read input"); exit(1) }

let handler = VNImageRequestHandler(ciImage: img, options: [:])
let faceReq = VNDetectFaceRectanglesRequest()
// 얼굴이 안 보여도(뒷모습·멀리) 몸통은 잡힌다. 옷이 끌려오는 건 얼굴이 아니라 몸이다.
let humanReq = VNDetectHumanRectanglesRequest()
humanReq.upperBodyOnly = false
do { try handler.perform([faceReq, humanReq]) } catch { print("perform failed: \(error)"); exit(1) }
let faces = (faceReq.results ?? []).count
// 신뢰도 낮은 검출(간판 속 사람 그림 등)은 버린다.
let humans = (humanReq.results ?? []).filter { $0.confidence >= 0.5 }.count
print("ok faces=\(faces) humans=\(humans)")
