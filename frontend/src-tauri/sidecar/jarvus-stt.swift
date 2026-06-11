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
    private var announcedListening = false // "listening" status sent for this start..stop span
    // Hardware echo cancellation: Apple's voice-processing I/O subtracts the
    // Mac's own audio output (Jarvis's TTS) from the mic, so we hear only the
    // user. On by default — without it Jarvis transcribes himself and replies
    // to his own speech. Set JARVUS_AEC=0 to disable if it misbehaves. Cleared
    // at runtime if the audio engine can't start with voice processing on.
    private var aecEnabled = ProcessInfo.processInfo.environment["JARVUS_AEC"] != "0"
    private var aecConfigured = false

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

        // Start the audio engine once and keep it hot across recognition
        // sessions — tearing it down on every ~1s "no speech" restart left a
        // deaf window in which a wake phrase could be clipped.
        if !engine.isRunning {
            let input = engine.inputNode
            if aecEnabled {
                if !aecConfigured {
                    do {
                        // macOS has separate input/output HAL units — voice
                        // processing must be enabled on BOTH for the duplex
                        // AEC unit to initialise.
                        try input.setVoiceProcessingEnabled(true)
                        try engine.outputNode.setVoiceProcessingEnabled(true)
                        aecConfigured = true
                        fputs("[stt] AEC: enabled\n", stderr)
                    } catch {
                        fputs("[stt] AEC: failed (\(error)) — continuing without\n", stderr)
                        aecEnabled = false
                    }
                }
                // The voice-processing I/O unit is duplex: it only renders input audio
                // if the output chain is also engaged. Touching mainMixerNode creates
                // the (silent) mainMixer→output connection so the unit runs.
                _ = engine.mainMixerNode
            }
            let format = input.outputFormat(forBus: 0)
            // Multi-mic arrays (e.g. MacBook's 3-mic input) make the voice-
            // processing unit expose a multichannel format the engine can't
            // start with (-10875); tap in mono at the same sample rate instead.
            let tapFormat = format.channelCount > 2
                ? (AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 1) ?? format)
                : format
            fputs("[stt] capture format: \(format.sampleRate)Hz \(format.channelCount)ch (tap: \(tapFormat.channelCount)ch)\n", stderr)
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: tapFormat) { [weak self] buffer, _ in
                self?.request?.append(buffer)
            }
            engine.prepare()
            do { try engine.start() } catch {
                if aecConfigured {
                    // AEC is incompatible with this audio device — drop it and
                    // retry plain capture rather than losing voice entirely.
                    fputs("[stt] AEC: engine failed (\(error.localizedDescription)) — retrying without AEC\n", stderr)
                    input.removeTap(onBus: 0)
                    try? input.setVoiceProcessingEnabled(false)
                    try? engine.outputNode.setVoiceProcessingEnabled(false)
                    aecConfigured = false
                    aecEnabled = false
                    request = nil
                    beginSession(recognizer)
                    return
                }
                emit(["type": "status", "state": "error", "detail": "audio engine: \(error.localizedDescription)"])
                return
            }
        }

        running = true
        // Only announce the listening→listening restarts once; the host treats
        // "listening" as a state, and per-second re-emits are just log noise.
        if !announcedListening {
            announcedListening = true
            emit(["type": "status", "state": "listening", "detail": ""])
        }

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                self.lastText = result.bestTranscription.formattedString
                self.emit(["type": "partial", "text": self.lastText])
                self.resetSilenceTimer()
                if result.isFinal { self.sessionEnded(emitFinal: true) }
            }
            if let error = error {
                let ns = error as NSError
                // kAFAssistantErrorDomain#1110 "No speech detected" is the normal
                // end of an idle session (~1s of silence) — not worth logging.
                if !(ns.domain == "kAFAssistantErrorDomain" && ns.code == 1110) {
                    fputs("[stt] recognition error: \(ns.domain)#\(ns.code): \(ns.localizedDescription)\n", stderr)
                }
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
    // then immediately start a fresh session — the audio engine stays hot so
    // there's no deaf window between sessions.
    private func sessionEnded(emitFinal: Bool) {
        let text = lastText.trimmingCharacters(in: .whitespacesAndNewlines)
        teardown(emitFinal: false, keepEngine: true)
        if emitFinal, !text.isEmpty { emit(["type": "final", "text": text]) }
        beginIfNeeded()
    }

    private func teardown(emitFinal: Bool, keepEngine: Bool = false) {
        silenceTimer?.invalidate(); silenceTimer = nil
        task?.cancel(); task = nil
        request = nil
        if !keepEngine {
            announcedListening = false
            if engine.isRunning {
                engine.inputNode.removeTap(onBus: 0)
                engine.stop()
            }
        }
        running = false
        if emitFinal {
            let text = lastText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { emit(["type": "final", "text": text]) }
        }
    }
}

// ── TCC responsibility disclaim ─────────────────────────────────────────────
// Child processes inherit their parent's "responsible process" for privacy
// permissions (TCC). Spawned from the app (or a terminal in dev), speech/mic
// access is attributed to that host — and if the host's Info.plist lacks
// NSSpeechRecognitionUsageDescription, TCC SIGABRTs this process the moment
// it calls SFSpeechRecognizer.requestAuthorization. Re-exec ourselves
// "disclaimed" (the LLDB/Chromium trick) so this binary is its own
// responsible process and TCC honours the Info.plist embedded in it.
func disclaimTCCResponsibility() {
    if ProcessInfo.processInfo.environment["JARVUS_DISCLAIMED"] == "1" { return }
    let RTLD_DEFAULT = UnsafeMutableRawPointer(bitPattern: -2)
    guard let sym = dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim") else { return }
    typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
    let setDisclaim = unsafeBitCast(sym, to: SetDisclaim.self)

    var attr: posix_spawnattr_t? = nil
    guard posix_spawnattr_init(&attr) == 0 else { return }
    defer { posix_spawnattr_destroy(&attr) }
    guard setDisclaim(&attr, 1) == 0,
          posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC)) == 0 else { return }

    var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
    argv.append(nil)
    var env = ProcessInfo.processInfo.environment
    env["JARVUS_DISCLAIMED"] = "1"
    var envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") }
    envp.append(nil)

    var pid: pid_t = 0
    // POSIX_SPAWN_SETEXEC replaces this process in place (stdio preserved);
    // on success this call never returns.
    _ = posix_spawn(&pid, CommandLine.arguments[0], nil, &attr, argv, envp)
    fputs("[stt] disclaim re-exec failed — continuing undisclaimed\n", stderr)
    for p in argv where p != nil { free(p) }
    for p in envp where p != nil { free(p) }
}

disclaimTCCResponsibility()

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
