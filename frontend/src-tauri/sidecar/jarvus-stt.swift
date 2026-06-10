import Foundation
import Speech
import AVFoundation

// Always-on macOS speech-to-text sidecar for Jarvis (Tavus-style continuous
// listening). It transcribes continuously, emitting a "final" on each ~1.2s
// pause, then immediately restarts — so the host gets a stream of utterances
// without any button. The host pauses it while Jarvis is speaking (echo guard).
//
// Protocol (line-based over stdio):
//   stdin  "start\n"   → begin continuous listening
//   stdin  "pause\n"   → suspend (no audio captured; stays armed)
//   stdin  "resume\n"  → resume listening
//   stdin  "stop\n"    → stop entirely
//   stdin  "quit\n"    → exit the process
//   stdout {"type":"status","state":"ready|listening|paused|stopped|denied|error","detail":"…"}
//   stdout {"type":"partial","text":"…"}
//   stdout {"type":"final","text":"…"}

final class STT: NSObject {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var lastText = ""

    private var active = false   // host wants us listening (start..stop)
    private var paused = false   // temporarily suspended (during TTS)
    private var running = false  // a recognition session is currently live
    private var aecConfigured = false // hardware echo cancellation enabled once

    func emit(_ obj: [String: String]) {
        if let data = try? JSONSerialization.data(withJSONObject: obj),
           let s = String(data: data, encoding: .utf8) {
            print(s); fflush(stdout)
        }
    }

    // ── Commands ───────────────────────────────────────────────────────────
    func start() { active = true; paused = false; beginIfNeeded() }
    func pause() { paused = true; teardown(emitFinal: false); emit(["type": "status", "state": "paused", "detail": ""]) }
    func resume() { paused = false; beginIfNeeded() }
    func stop() { active = false; paused = false; teardown(emitFinal: false); emit(["type": "status", "state": "stopped", "detail": ""]) }

    private func beginIfNeeded() {
        guard active, !paused, !running else { return }
        guard let recognizer = recognizer, recognizer.isAvailable else {
            emit(["type": "status", "state": "error", "detail": "recognizer unavailable"]); return
        }
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    self.active = false
                    self.emit(["type": "status", "state": "denied",
                               "detail": "Speech recognition not authorized"])
                    return
                }
                self.beginSession(recognizer)
            }
        }
    }

    private func beginSession(_ recognizer: SFSpeechRecognizer) {
        guard active, !paused, !running else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        lastText = ""

        let input = engine.inputNode
        // Hardware echo cancellation: lets the user barge in while Jarvis speaks
        // without the mic transcribing his own TTS. Configure once.
        if !aecConfigured {
            do { try input.setVoiceProcessingEnabled(true); aecConfigured = true }
            catch { fputs("[stt] echo cancellation unavailable: \(error)\n", stderr) }
        }
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch {
            emit(["type": "status", "state": "error", "detail": "audio engine: \(error.localizedDescription)"])
            return
        }

        running = true
        emit(["type": "status", "state": "listening", "detail": ""])

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                self.lastText = result.bestTranscription.formattedString
                self.emit(["type": "partial", "text": self.lastText])
                self.resetSilenceTimer()
                if result.isFinal { self.sessionEnded(emitFinal: true) }
            }
            if let error = error {
                // "Siri and Dictation are disabled" surfaces here; report it once.
                let msg = error.localizedDescription
                if msg.range(of: "Dictation", options: .caseInsensitive) != nil {
                    self.active = false
                    self.emit(["type": "status", "state": "error", "detail": "recognition: \(msg)"])
                    self.teardown(emitFinal: false)
                } else {
                    self.sessionEnded(emitFinal: true)
                }
            }
        }
    }

    private func resetSilenceTimer() {
        DispatchQueue.main.async {
            self.silenceTimer?.invalidate()
            self.silenceTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { [weak self] _ in
                self?.request?.endAudio()   // force a final after a pause
            }
        }
    }

    // A session finished (silence, final, or the ~1-min limit). Emit the text,
    // tear down, then immediately restart so listening is continuous.
    private func sessionEnded(emitFinal: Bool) {
        let text = lastText.trimmingCharacters(in: .whitespacesAndNewlines)
        teardown(emitFinal: false)
        if emitFinal, !text.isEmpty { emit(["type": "final", "text": text]) }
        beginIfNeeded()
    }

    private func teardown(emitFinal: Bool) {
        silenceTimer?.invalidate(); silenceTimer = nil
        if running {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        task?.cancel(); task = nil
        request = nil
        running = false
        if emitFinal {
            let text = lastText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { emit(["type": "final", "text": text]) }
        }
    }
}

let stt = STT()
stt.emit(["type": "status", "state": "ready", "detail": "send 'start' to listen"])

DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
        switch line.trimmingCharacters(in: .whitespaces) {
        case "start":  DispatchQueue.main.async { stt.start() }
        case "pause":  DispatchQueue.main.async { stt.pause() }
        case "resume": DispatchQueue.main.async { stt.resume() }
        case "stop":   DispatchQueue.main.async { stt.stop() }
        case "quit":   exit(0)
        default: break
        }
    }
    exit(0)
}

RunLoop.main.run()
