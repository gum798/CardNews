// 생성 이미지 해부학 검수기. macOS 내장 Vision만 쓴다(무료·오프라인·모델 다운로드 0).
//
// 무료 이미지 모델은 손가락이 여섯 개거나 팔이 하나 더 달린 컷을 꾸준히 만든다.
// 사람이 매번 10장을 눈으로 거르는 건 낭비이므로, 확실히 틀린 것만 기계로 잡는다.
//
// 셀 수 있는 것만 센다 — "어색하다"는 판단은 하지 않는다. 오탐이 나면
// 멀쩡한 컷이 버려지므로, 명백한 위반(손 3개 이상, 얼굴 2개 이상)만 신고한다.
//
// 빌드: swiftc -O tools/qc.swift -o tools/qc
// 사용: qc <image.png>
//   stdout: faces=N bigFaces=N hands=N bodies=N fingers=N
//   exit 0 = 검사 완료(판정은 호출부) / 1 = 읽기 실패 / 2 = 인자 오류
import Foundation
import Vision
import CoreImage

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: qc <image>\n".data(using: .utf8)!)
    exit(2)
}
guard let src = CIImage(contentsOf: URL(fileURLWithPath: args[1])) else {
    print("cannot read input"); exit(1)
}

let handler = VNImageRequestHandler(ciImage: src, options: [:])

// 얼굴 — 배경 행인의 작은 얼굴은 정상이므로 크기로 나눠 센다.
var faces = 0, bigFaces = 0
let faceReq = VNDetectFaceRectanglesRequest()
if (try? handler.perform([faceReq])) != nil {
    let results = faceReq.results ?? []
    faces = results.count
    bigFaces = results.filter { $0.boundingBox.height >= 0.10 }.count
}

// 손 — 최대 6개까지 찾아본다. 1인 사진에서 3개 이상이면 명백한 결함이다.
// 손가락 관절이 몇 개 잡히는지도 같이 본다(뭉개진 손은 관절 수가 적다).
var hands = 0, fingerPoints = 0
let handReq = VNDetectHumanHandPoseRequest()
handReq.maximumHandCount = 6
if (try? handler.perform([handReq])) != nil {
    let results = handReq.results ?? []
    // 신뢰도가 낮은 검출은 배경 잡음일 수 있어 제외한다.
    let solid = results.filter { $0.confidence >= 0.5 }
    hands = solid.count
    for h in solid {
        if let pts = try? h.recognizedPoints(.all) {
            fingerPoints += pts.values.filter { $0.confidence >= 0.5 }.count
        }
    }
}

// 몸 — 1인 사진에 몸통이 둘이면 인물이 겹쳐 생성된 것이다.
var bodies = 0
let bodyReq = VNDetectHumanBodyPoseRequest()
if (try? handler.perform([bodyReq])) != nil {
    bodies = (bodyReq.results ?? []).filter { $0.confidence >= 0.5 }.count
}

print("faces=\(faces) bigFaces=\(bigFaces) hands=\(hands) bodies=\(bodies) fingers=\(fingerPoints)")
