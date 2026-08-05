// 전경(인물) 매트 추출기. macOS 내장 Vision 프레임워크만 쓴다 —
// 모델 다운로드 0, 추가 메모리 0, 오프라인 동작, 라이선스 제약 없음.
//
// 릴스에서 하나를 방 사진째로 얹지 않고 오려내서 배경 영상 위에 세우기 위한 알파 채널을 만든다.
// 바운딩박스까지 내주므로 호출부가 "머리 위치"를 계산해 자막을 안 가리게 배치할 수 있다.
//
// 빌드: swiftc -O tools/matte.swift -o tools/matte
// 사용: matte <in.png> <mask.png>
//   stdout: ok instances=N mask=WxH bbox=X,Y,W,H cover=P time=S
//   exit 0 = 성공 / 1 = 전경 미검출·읽기 실패 (호출부는 켄번즈로 폴백) / 2 = 인자 오류
import Foundation
import Vision
import CoreImage

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: matte <in.png> <mask.png>\n".data(using: .utf8)!)
    exit(2)
}
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])

guard let src = CIImage(contentsOf: inURL) else { print("cannot read input"); exit(1) }

let handler = VNImageRequestHandler(ciImage: src, options: [:])
let req = VNGenerateForegroundInstanceMaskRequest()

let t0 = Date()
do { try handler.perform([req]) } catch { print("perform failed: \(error)"); exit(1) }
guard let obs = req.results?.first else { print("no foreground instance found"); exit(1) }

// 인스턴스를 통째로 합친다. 인물 외 물체가 섞일 수 있으므로 호출부가 instances 수를 보고 판단한다.
guard let pb = try? obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler) else {
    print("mask generation failed"); exit(1)
}
let elapsed = Date().timeIntervalSince(t0)

// ── 바운딩박스: 마스크에서 실제로 불투명한 영역 ──────────────────────────────
// 이걸 알아야 인물의 머리끝을 자막 아래로 정확히 내려놓을 수 있다.
CVPixelBufferLockBaseAddress(pb, .readOnly)
let mw = CVPixelBufferGetWidth(pb)
let mh = CVPixelBufferGetHeight(pb)
let stride = CVPixelBufferGetBytesPerRow(pb)
let fmt = CVPixelBufferGetPixelFormatType(pb)
var minX = mw, minY = mh, maxX = -1, maxY = -1
var covered = 0

if let base = CVPixelBufferGetBaseAddress(pb) {
    let buf = base.assumingMemoryBound(to: UInt8.self)
    // OneComponent8이면 1바이트/픽셀, OneComponent32Float이면 4바이트/픽셀.
    let isFloat = (fmt == kCVPixelFormatType_OneComponent32Float)
    for y in 0..<mh {
        let row = buf.advanced(by: y * stride)
        for x in 0..<mw {
            let on: Bool
            if isFloat {
                let v = row.advanced(by: x * 4).withMemoryRebound(to: Float32.self, capacity: 1) { $0.pointee }
                on = v > 0.5
            } else {
                on = row[x] > 128
            }
            if on {
                covered += 1
                if x < minX { minX = x }
                if x > maxX { maxX = x }
                if y < minY { minY = y }
                if y > maxY { maxY = y }
            }
        }
    }
}
CVPixelBufferUnlockBaseAddress(pb, .readOnly)

guard maxX >= 0 else { print("mask is empty"); exit(1) }
let bw = maxX - minX + 1
let bh = maxY - minY + 1
let coverPct = Double(covered) / Double(mw * mh) * 100.0

// ── 마스크 PNG 저장 (그레이스케일 L8) ────────────────────────────────────────
let maskCI = CIImage(cvPixelBuffer: pb)
let ctx = CIContext()
let cs = CGColorSpaceCreateDeviceGray()
guard let png = ctx.pngRepresentation(of: maskCI, format: .L8, colorSpace: cs) else {
    print("encode failed"); exit(1)
}
do { try png.write(to: outURL) } catch { print("write failed: \(error)"); exit(1) }

print(String(format: "ok instances=%d mask=%dx%d bbox=%d,%d,%d,%d cover=%.1f time=%.3fs",
             obs.allInstances.count, mw, mh, minX, minY, bw, bh, coverPct, elapsed))
