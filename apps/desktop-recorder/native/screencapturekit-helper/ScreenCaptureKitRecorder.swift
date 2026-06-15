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
  private var videoInput: AVAssetWriterInput?
  private var audioInput: AVAssetWriterInput?
  private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
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
    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 12_000_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
      ]
    ])
    videoInput.expectsMediaDataInRealTime = true
    guard writer.canAdd(videoInput) else {
      throw NSError(domain: "VideoBlitzerScreenCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot add video input to AVAssetWriter."])
    }
    writer.add(videoInput)

    let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVNumberOfChannelsKey: 2,
      AVSampleRateKey: 48_000,
      AVEncoderBitRateKey: 192_000
    ])
    audioInput.expectsMediaDataInRealTime = true
    if writer.canAdd(audioInput) {
      writer.add(audioInput)
      self.audioInput = audioInput
    }

    self.writer = writer
    self.videoInput = videoInput
    self.adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoInput, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height
    ])

    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(frameRate))
    configuration.queueDepth = 8
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.showsCursor = true
    configuration.capturesAudio = true
    configuration.excludesCurrentProcessAudio = true

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    if self.audioInput != nil {
      try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
    }
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
    videoInput?.markAsFinished()
    audioInput?.markAsFinished()
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
    guard CMSampleBufferIsValid(sampleBuffer), let writer else { return }
    if type == .screen {
      appendVideo(sampleBuffer, writer: writer)
    } else if type == .audio {
      appendAudio(sampleBuffer, writer: writer)
    }
  }

  private func appendVideo(_ sampleBuffer: CMSampleBuffer, writer: AVAssetWriter) {
    guard let videoInput, videoInput.isReadyForMoreMediaData else { return }
    let statusAttachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
    if let status = statusAttachments?.first?[SCStreamFrameInfo.status] as? Int,
       status != SCFrameStatus.complete.rawValue {
      return
    }

    guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    if firstPTS == nil {
      firstPTS = pts
      writer.startWriting()
      writer.startSession(atSourceTime: .zero)
    }
    guard let firstPTS else { return }
    let adjustedPTS = CMTimeSubtract(pts, firstPTS)
    if adaptor?.append(imageBuffer, withPresentationTime: adjustedPTS) != true {
      fputs("VIDEO_BLITZER_SCK_WARN frame append failed: \(writer.status.rawValue) \(writer.error?.localizedDescription ?? "unknown writer status")\n", stderr)
    }
  }

  private func appendAudio(_ sampleBuffer: CMSampleBuffer, writer: AVAssetWriter) {
    guard let audioInput, audioInput.isReadyForMoreMediaData, let firstPTS else { return }
    let adjustedPTS = CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(sampleBuffer), firstPTS)
    if adjustedPTS < .zero { return }
    var timing = CMSampleTimingInfo(
      duration: CMSampleBufferGetDuration(sampleBuffer),
      presentationTimeStamp: adjustedPTS,
      decodeTimeStamp: CMSampleBufferGetDecodeTimeStamp(sampleBuffer)
    )
    var retimedBuffer: CMSampleBuffer?
    let status = CMSampleBufferCreateCopyWithNewTiming(
      allocator: kCFAllocatorDefault,
      sampleBuffer: sampleBuffer,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleBufferOut: &retimedBuffer
    )
    guard status == noErr, let retimedBuffer else { return }
    if !audioInput.append(retimedBuffer) {
      fputs("VIDEO_BLITZER_SCK_WARN audio append failed: \(writer.status.rawValue) \(writer.error?.localizedDescription ?? "unknown writer status")\n", stderr)
    }
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

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let signalQueue = DispatchQueue(label: "com.videoblitzer.screencapturekit.signals")
let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
interruptSource.setEventHandler {
  Task { await recorder.stop(); Foundation.exit(0) }
}
interruptSource.resume()

let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
terminateSource.setEventHandler {
  Task { await recorder.stop(); Foundation.exit(0) }
}
terminateSource.resume()

Task {
  do {
    try await recorder.start()
  } catch {
    fputs("VIDEO_BLITZER_SCK_ERROR \(error.localizedDescription)\n", stderr)
    Foundation.exit(1)
  }
}

RunLoop.main.run()
