import AppKit
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

final class ScreenRecorder: NSObject, SCStreamDelegate, SCStreamOutput {
  private let outputURL: URL
  private let displayID: CGDirectDisplayID?
  private let frameRate: Int
  private let queue = DispatchQueue(label: "com.videoblitzer.screencapturekit.frames")
  private var stream: SCStream?
  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var firstPTS: CMTime?
  private var isStopping = false

  init(outputURL: URL, displayID: CGDirectDisplayID?, frameRate: Int) {
    self.outputURL = outputURL
    self.displayID = displayID
    self.frameRate = max(1, min(frameRate, 120))
  }

  func start() async throws {
    if FileManager.default.fileExists(atPath: outputURL.path) {
      try FileManager.default.removeItem(at: outputURL)
    }

    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { displayID == nil || $0.displayID == displayID }) ?? content.displays.first else {
      throw NSError(domain: "VideoBlitzerScreenCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "No capturable displays returned by ScreenCaptureKit."])
    }

    let width = max(2, display.width)
    let height = max(2, display.height)

    let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 12_000_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
      ]
    ])
    input.expectsMediaDataInRealTime = true
    guard writer.canAdd(input) else {
      throw NSError(domain: "VideoBlitzerScreenCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot add video input to AVAssetWriter."])
    }
    writer.add(input)
    self.writer = writer
    self.input = input

    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(frameRate))
    configuration.queueDepth = 8
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.showsCursor = true

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    self.stream = stream
    try await stream.startCapture()

    print("VIDEO_BLITZER_SCK_STARTED \(display.displayID) \(width)x\(height)")
    fflush(stdout)
  }

  func stop() async {
    if isStopping { return }
    isStopping = true
    if let stream {
      try? await stream.stopCapture()
    }
    input?.markAsFinished()
    await withCheckedContinuation { continuation in
      writer?.finishWriting {
        continuation.resume()
      }
    }
    print("VIDEO_BLITZER_SCK_STOPPED \(outputURL.path)")
    fflush(stdout)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fputs("VIDEO_BLITZER_SCK_ERROR \(error.localizedDescription)\n", stderr)
    Task { await stop(); Foundation.exit(1) }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, CMSampleBufferIsValid(sampleBuffer), let input, let writer else { return }
    guard input.isReadyForMoreMediaData else { return }

    let statusAttachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
    if let status = statusAttachments?.first?[SCStreamFrameInfo.status] as? Int,
       status != SCFrameStatus.complete.rawValue {
      return
    }

    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    if firstPTS == nil {
      firstPTS = pts
      writer.startWriting()
      writer.startSession(atSourceTime: pts)
    }
    input.append(sampleBuffer)
  }
}

func argumentValue(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), args.indices.contains(index + 1) else { return nil }
  return args[index + 1]
}

let outputPath = argumentValue("--output") ?? ""
guard !outputPath.isEmpty else {
  fputs("Usage: VideoBlitzerScreenCapture --output /path/file.mp4 [--display-id 1] [--fps 60]\n", stderr)
  Foundation.exit(64)
}

let displayID = argumentValue("--display-id").flatMap { CGDirectDisplayID($0) }
let frameRate = argumentValue("--fps").flatMap { Int($0) } ?? 60
let recorder = ScreenRecorder(outputURL: URL(fileURLWithPath: outputPath), displayID: displayID, frameRate: frameRate)

signal(SIGINT) { _ in Task { await recorder.stop(); Foundation.exit(0) } }
signal(SIGTERM) { _ in Task { await recorder.stop(); Foundation.exit(0) } }

Task {
  do {
    try await recorder.start()
  } catch {
    fputs("VIDEO_BLITZER_SCK_ERROR \(error.localizedDescription)\n", stderr)
    Foundation.exit(1)
  }
}

RunLoop.main.run()
