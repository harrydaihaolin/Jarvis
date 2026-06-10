import AVFoundation
import Vision
import Foundation

// Coarse face-position detector: opens the default camera, runs
// VNDetectFaceRectanglesRequest at ~10 fps, and prints JSON lines to stdout:
//   {"x":0.52,"y":0.41}  — normalised face-centre (0-1, origin top-left)
//   {"x":null,"y":null}  — no face detected
// Tauri reads stdout and emits "face-position" events to the webview.

class EyeTracker: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private var frameCount = 0
    private let out = FileHandle.standardOutput

    func start() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            fputs("[eye-tracker] no camera\n", stderr); return
        }
        guard let input = try? AVCaptureDeviceInput(device: device) else {
            fputs("[eye-tracker] camera input failed\n", stderr); return
        }
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.setSampleBufferDelegate(self, queue: DispatchQueue(label: "jarvus.eye"))
        session.sessionPreset = .vga640x480
        session.addInput(input)
        session.addOutput(output)
        session.startRunning()
        fputs("[eye-tracker] listening\n", stderr)
        RunLoop.main.run()
    }

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        frameCount += 1
        guard frameCount % 3 == 0 else { return }  // sample at ~10 fps

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        try? handler.perform([request])

        let line: String
        if let face = request.results?.first {
            let box = face.boundingBox
            // Vision origin is bottom-left; convert to top-left for consistency with CSS
            let x = Double(box.midX)
            let y = 1.0 - Double(box.midY)
            line = String(format: "{\"x\":%.3f,\"y\":%.3f}\n", x, y)
        } else {
            line = "{\"x\":null,\"y\":null}\n"
        }
        out.write(Data(line.utf8))
    }
}

EyeTracker().start()
