#if os(iOS)
import CoreML
import Foundation
import WebKit

/// The blur's face models, run by Core ML on the phone's own Neural
/// Engine or GPU instead of WebGL inside the page.
///
/// iPhone blur ran every model in the page on the main thread (WKWebView
/// cannot start the inference worker the way Android's WebView can), and
/// the simulator measured about 5 seconds per thumbnail. This is the
/// iPhone half of Android's NativeInfer.kt: the same wire format
/// (native-frame.mjs), so the page's native-client and its decoding are
/// shared code, and only the transport differs. The page side of the
/// bridge is lib.rs's native_port_stash_script, which turns this
/// handler into the MessagePort native-client expects.
///
/// Models: 1 = BlazeFace (input scaled to -1..1), 2 = faceres (raw
/// 0..255). Both are compiled into the app (app/src-tauri/ios-models).
/// Request 0 is the configuration ping, answered with an empty reply.
final class TsInfer: NSObject, WKScriptMessageHandlerWithReply {
  static let shared = TsInfer()

  private let queue = DispatchQueue(label: "app.tamescroll.infer", qos: .userInitiated)
  private var models: [UInt32: MLModel] = [:]
  private var inputNames: [UInt32: String] = [:]
  private var readyJSON: String?
  private var logged = 0

  private static let files: [(UInt32, String)] = [(1, "blazeface"), (2, "faceres")]

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage,
    replyHandler: @escaping (Any?, String?) -> Void
  ) {
    guard message.frameInfo.isMainFrame, let body = message.body as? String else {
      replyHandler(nil, "bad message")
      return
    }
    queue.async {
      if body == "hello" {
        replyHandler(self.hello(), nil)
        return
      }
      guard let data = Data(base64Encoded: body) else {
        replyHandler(nil, "bad base64")
        return
      }
      replyHandler(self.handle(data).base64EncodedString(), nil)
    }
  }

  /// Loads both models once and answers with native-frame.mjs's ready
  /// message. A warm-up prediction runs here so the first thumbnail does
  /// not pay for the Neural Engine's first-use setup.
  private func hello() -> String {
    if let ready = readyJSON { return ready }
    let t0 = CFAbsoluteTimeGetCurrent()
    let config = MLModelConfiguration()
    config.computeUnits = .all
    for (id, name) in Self.files {
      guard let url = Bundle.main.url(forResource: name, withExtension: "mlmodelc") else {
        return failed("no \(name) model in the app")
      }
      do {
        let model = try MLModel(contentsOf: url, configuration: config)
        guard let input = model.modelDescription.inputDescriptionsByName.keys.first else {
          return failed("\(name) has no input")
        }
        models[id] = model
        inputNames[id] = input
        let side = id == 1 ? 256 : 224
        _ = try? run(id, width: side, height: side, rgba: Data(count: side * side * 4))
      } catch {
        return failed("\(name): \(error.localizedDescription)")
      }
    }
    let ms = Int((CFAbsoluteTimeGetCurrent() - t0) * 1000)
    let ready =
      "{\"type\":\"native-ready\",\"backend\":\"coreml\",\"models\":[\"blazeface\",\"faceres\"],\"initMs\":\(ms)}"
    readyJSON = ready
    return ready
  }

  private func failed(_ why: String) -> String {
    let safe = why.replacingOccurrences(of: "\\", with: " ").replacingOccurrences(of: "\"", with: "'")
    return "{\"type\":\"native-failed\",\"why\":\"\(safe)\"}"
  }

  /// One request: [u32 reqId, u32 modelId, u32 width, u32 height] then
  /// width*height RGBA bytes, little-endian. The reply carries every
  /// output as float32; the page matches them by length.
  private func handle(_ data: Data) -> Data {
    guard data.count >= 16 else { return reply(0, status: 1, outputs: [], elapsedUs: 0) }
    let reqId = u32(data, 0)
    let modelId = u32(data, 4)
    let w = Int(u32(data, 8))
    let h = Int(u32(data, 12))
    if modelId == 0 { return reply(reqId, status: 0, outputs: [], elapsedUs: 0) }
    guard models[modelId] != nil, w > 0, h > 0, w <= 1024, h <= 1024, data.count == 16 + w * h * 4 else {
      return reply(reqId, status: 1, outputs: [], elapsedUs: 0)
    }
    let t0 = CFAbsoluteTimeGetCurrent()
    guard let outputs = try? run(modelId, width: w, height: h, rgba: data.subdata(in: 16..<data.count)) else {
      return reply(reqId, status: 1, outputs: [], elapsedUs: 0)
    }
    let us = UInt32(min(Double(UInt32.max), (CFAbsoluteTimeGetCurrent() - t0) * 1_000_000))
    return reply(reqId, status: 0, outputs: outputs, elapsedUs: us)
  }

  private func run(_ id: UInt32, width w: Int, height h: Int, rgba: Data) throws -> [[Float]] {
    guard let model = models[id], let inputName = inputNames[id] else { return [] }
    let input = try MLMultiArray(shape: [1, NSNumber(value: h), NSNumber(value: w), 3], dataType: .float32)
    let dst = input.dataPointer.bindMemory(to: Float.self, capacity: input.count)
    // Core ML may pad an array's rows, so every index goes through the
    // array's own strides rather than assuming a packed layout.
    let sy = input.strides[1].intValue, sx = input.strides[2].intValue, sc = input.strides[3].intValue
    let blazeface = id == 1
    rgba.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      let src = raw.bindMemory(to: UInt8.self)
      for y in 0..<h {
        for x in 0..<w {
          let p = (y * w + x) * 4
          let o = y * sy + x * sx
          for c in 0..<3 {
            let v = Float(src[p + c])
            dst[o + c * sc] = blazeface ? v / 127.5 - 1 : v
          }
        }
      }
    }
    let features = try MLDictionaryFeatureProvider(dictionary: [inputName: MLFeatureValue(multiArray: input)])
    let result = try model.prediction(from: features)
    let names = result.featureNames.sorted()
    let outs = names.compactMap { name in
      result.featureValue(for: name)?.multiArrayValue.map(floats)
    }
    // The first few runs say what came back, for the CI log.
    if logged < 8 {
      logged += 1
      var sum = 0, alpha = 0
      rgba.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        for p in stride(from: 0, to: raw.count, by: 4) {
          sum += Int(raw[p]) + Int(raw[p + 1]) + Int(raw[p + 2])
          alpha += Int(raw[p + 3])
        }
      }
      let px = max(1, w * h)
      var line = "TsInfer model \(id) \(w)x\(h) rgbMean=\(sum / (3 * px)) alphaMean=\(alpha / px):"
      for (k, name) in names.enumerated() {
        guard let a = result.featureValue(for: name)?.multiArrayValue, k < outs.count else { continue }
        let o = outs[k]
        line += " \(name) type=\(a.dataType.rawValue) shape=\(a.shape) strides=\(a.strides)"
        line += " min=\(o.min() ?? 0) max=\(o.max() ?? 0);"
      }
      NSLog("%@", line)
    }
    return outs
  }

  /// An output in plain row-major order. The Neural Engine and GPU hand
  /// back arrays whose rows are padded (a [1,512,1] score array can carry
  /// 64 bytes per row), so reading `count` floats straight from memory
  /// returns padding: every index is walked through the array's strides.
  private func floats(_ a: MLMultiArray) -> [Float] {
    let n = a.count
    let shape = a.shape.map { $0.intValue }
    let strides = a.strides.map { $0.intValue }
    var out = [Float](repeating: 0, count: n)
    if n == 0 { return out }
    var idx = [Int](repeating: 0, count: shape.count)
    func offset() -> Int {
      var off = 0
      for k in 0..<idx.count { off += idx[k] * strides[k] }
      return off
    }
    func step() {
      var k = idx.count - 1
      while k >= 0 {
        idx[k] += 1
        if idx[k] < shape[k] { return }
        idx[k] = 0
        k -= 1
      }
    }
    if a.dataType == .float32 {
      let p = a.dataPointer.assumingMemoryBound(to: Float.self)
      for i in 0..<n {
        out[i] = p[offset()]
        step()
      }
    } else if a.dataType == .double {
      let p = a.dataPointer.assumingMemoryBound(to: Double.self)
      for i in 0..<n {
        out[i] = Float(p[offset()])
        step()
      }
    } else {
      for i in 0..<n {
        out[i] = a[idx.map { NSNumber(value: $0) }].floatValue
        step()
      }
    }
    return out
  }

  private func u32(_ d: Data, _ at: Int) -> UInt32 {
    var v: UInt32 = 0
    for k in 0..<4 { v |= UInt32(d[d.startIndex + at + k]) << (8 * UInt32(k)) }
    return v
  }

  private func reply(_ reqId: UInt32, status: UInt32, outputs: [[Float]], elapsedUs: UInt32) -> Data {
    var out = Data()
    func put(_ v: UInt32) {
      var le = v.littleEndian
      withUnsafeBytes(of: &le) { out.append(contentsOf: $0) }
    }
    put(reqId)
    put(status)
    put(UInt32(outputs.count))
    put(elapsedUs)
    for o in outputs {
      put(UInt32(o.count * 4))
      o.withUnsafeBufferPointer { out.append(UnsafeBufferPointer(start: $0.baseAddress, count: $0.count)) }
    }
    return out
  }
}
#endif
