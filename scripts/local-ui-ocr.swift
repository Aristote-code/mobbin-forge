import Foundation
import Vision
import ImageIO

func box(_ r: CGRect) -> [String: Double] {
    return ["x": Double(r.origin.x), "y": Double(1 - r.origin.y - r.height), "width": Double(r.width), "height": Double(r.height)]
}
while let line = readLine() {
    autoreleasepool {
        do {
            guard let data = line.data(using: .utf8),
                  let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let file = input["path"] as? String,
                  let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                throw NSError(domain: "LocalUICatalog", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot read input image"])
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US"]
            request.usesLanguageCorrection = false
            let rectangles = VNDetectRectanglesRequest()
            rectangles.maximumObservations = 25
            rectangles.minimumConfidence = 0.45
            rectangles.minimumSize = 0.04
            rectangles.minimumAspectRatio = 0.08
            rectangles.quadratureTolerance = 20
            let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
            try handler.perform([request, rectangles])
            let all = request.results ?? []
            let text: [[String: Any]] = all.prefix(500).compactMap { observation in
                guard let candidate = observation.topCandidates(1).first else { return nil }
                return ["text": candidate.string, "confidence": Double(candidate.confidence), "bounds": box(observation.boundingBox)]
            }
            let rects: [[String: Any]] = (rectangles.results ?? []).map { observation in
                return ["confidence": Double(observation.confidence), "bounds": box(observation.boundingBox)]
            }
            let result: [String: Any] = ["ok": true, "width": image.width, "height": image.height, "text": text,
              "text_truncated": all.count > 500, "rectangles": rects, "coordinate_space": "normalized top-left original raster",
              "engine": "Apple Vision VNRecognizeTextRequest accurate + VNDetectRectanglesRequest", "recognition_languages": ["en-US"], "revision": request.revision]
            let out = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print(String(data: out, encoding: .utf8)!)
        } catch {
            let out = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": String(describing: error)])
            print(String(data: out, encoding: .utf8)!)
        }
        fflush(stdout)
    }
}
