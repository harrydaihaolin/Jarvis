import Foundation
import Speech
import AVFoundation

// macOS on-device speech-to-text sidecar for Jarvis.
//
// Protocol (line-based over stdio):
//   stdin  "start\n"  → begin a listening session
//   stdin  "stop\n"   → end the current session immediately (forces a final)
//   stdout {"type":"status","state":"ready|listening|stopped|denied|error","detail":"…"}
//   stdout {"type":"partial","text":"…"}   — live transcription as you speak
//   stdout {"type":"final","text":"…"}     — emitted on a ~1.2s pause or on "stop"
//
// Uses SFSpeechRecognizer with on-device recognition (free, offline). The host
// (Rust) sends "start" on the wake word or a mic-button press, reads stdout, and
// forwards "final" transcripts to the webview to fill the input and auto-send.

final class STT: NSObject {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var lastText = ""
    private var listening = false

    func emit(_ obj: [String: String]) {
        if let data = try? JSONSerialization.data(withJSONObject: obj),
           let s = String(data: data, encoding: .utf8) {
            print(s); fflush(stdout)
        }
    }

    func requestAuth(_ done: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async { done(status == .authorized) }
        }
    }

    func start() {
        guard !listening else { return }
        guard let recognizer = recognizer, recognizer.isAvailable else {
            emit(["type": "status", "state": "error", "detail": "recognizer unavailable"]); return
        }
        requestAuth { ok in
            guard ok else {
                self.emit(["type": "status", "state": "denied",
                           "detail": "Speech recognition not authorized"]); return
            }
            self.beginSession(recognizer)
        }
    }

    private func beginSession(_ recognizer: SFSpeechRecognizer) {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        lastText = ""

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        fputs("[stt] input format: \(format.sampleRate)Hz \(format.channelCount)ch\n", stderr)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch {
            emit(["type": "status", "state": "error", "detail": "audio engine: \(error.localizedDescription)"])
            return
        }

        listening = true
        emit(["type": "status", "state": "listening", "detail": ""])

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                self.lastText = result.bestTranscription.formattedString
                self.emit(["type": "partial", "text": self.lastText])
                self.resetSilenceTimer()
                if result.isFinal { self.finish() }
            }
            if let error = error {
                // Surface WHY the session ended (e.g. no audio / assets / auth).
                self.emit(["type": "status", "state": "error",
                           "detail": "recognition: \(error.localizedDescription)"])
                self.finish()
            }
        }
    }

    private func resetSilenceTimer() {
        DispatchQueue.main.async {
            self.silenceTimer?.invalidate()
            self.silenceTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { [weak self] _ in
                self?.request?.endAudio()   // force a final result after a pause
            }
        }
    }

    func stop() {
        request?.endAudio()
    }

    private func finish() {
        guard listening else { return }
        listening = false
        silenceTimer?.invalidate(); silenceTimer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        task?.cancel(); task = nil
        request = nil
        let text = lastText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { emit(["type": "final", "text": text]) }
        emit(["type": "status", "state": "stopped", "detail": ""])
    }
}

let stt = STT()
stt.emit(["type": "status", "state": "ready", "detail": "send 'start' to listen"])

// Read stdin commands on a background thread; run the main RunLoop for audio + timers.
DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
        switch line.trimmingCharacters(in: .whitespaces) {
        case "start": DispatchQueue.main.async { stt.start() }
        case "stop":  DispatchQueue.main.async { stt.stop() }
        case "quit":  exit(0)
        default: break
        }
    }
    exit(0)
}

RunLoop.main.run()
