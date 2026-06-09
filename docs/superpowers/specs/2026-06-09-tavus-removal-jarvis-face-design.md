# Jarvis Face — Remove Tavus, Add Animated Face + Local Voice

**Date:** 2026-06-09
**Status:** Approved for implementation

## Summary

Remove Tavus CVI (the $59/mo video-avatar service) and replace it with:
- An animated robotic face rendered in the Tauri webview (inspired by NIO's NOMI)
- Web SpeechSynthesis for voice output
- macOS Vision (via Rust/objc2) for coarse face-position eye tracking
- A text input for v1 turn-taking (STT added later)

The proxy, agent console, conversation memory, heartbeat, and Picovoice wake word are **unchanged**.

---

## Architecture

```
[Camera] → [EyeTracker Rust] → Tauri "face-position" event → [JarvisFace eyes]
[Picovoice]                  → Tauri "wake-word" event     → [TextInput focus]
[TextInput] → POST /v1/chat/completions → [Local Proxy :8787] → Claude API
[Proxy SSE /events]          → EventSource                 → [AgentConsole]
[Proxy streaming text]       → [SpeechSynthesis]           → [JarvisFace emotion/mouth]
```

No public tunnel or ngrok required — app talks to `localhost:8787` directly.

---

## Layout

**Layout A** — same split as today:
- **Left panel** (`flex: 1`): JarvisFace centred, camera preview PiP bottom-left, text input below face
- **Right panel** (`380px`): AgentConsole — transcript, tool activity, citations, media (unchanged)

The `callRoot` / `callMain` / `--console-width` CSS variables in `App.css` are reused as-is.

---

## Components

### 1. `JarvisFace` (`frontend/src/components/JarvisFace.tsx` + `.css`)

Animated SVG/CSS face. Self-contained; receives props, emits no callbacks.

**Props:**
```ts
interface JarvisFaceProps {
  emotion: 'idle' | 'speaking' | 'thinking' | 'happy' | 'surprised'
  eyePosition: { x: number; y: number } | null  // normalised 0–1 from Vision
}
```

**Visual spec (from v3 prototype):**
- Round dark face shell, subtle radial gradient, faint border
- Two floating eyeballs — no socket ring. Eyeball layers: dark iris, limbal ring, grey-white sclera, dual glints (primary top-left, secondary bottom-right)
- Eyes translate up to 7 px in the direction of `eyePosition`; smooth `transition: transform 0.1s`
- Auto-blink every 2.6–6s, 140 ms duration, random timing
- **Mouth shapes** (CSS-only, transition on opacity):
  - `idle` — thin grey horizontal line
  - `speaking` — 7-bar waveform animated with `scaleY`, driven by SpeechSynthesis boundary events
  - `happy` — arc smile, border-bottom rounded
  - `thinking` — 3 bouncing dots
  - `surprised` — oval `border` circle; pupils widen to 38 px
- **Speaking state**: outer ring — two counter-rotating conic-gradient arcs (`1.8s` + `3s`) + slow pulse glow. Only visible when `emotion === 'speaking'`.
- Emotion changes transition glow colour on the face shell border.

**Eye tracking mapping:**
- `eyePosition.x` maps to horizontal pupil offset: `0 → -7px`, `0.5 → 0px`, `1 → +7px`
- `eyePosition.y` maps to vertical offset: `0 → -7px` (top), `1 → +7px` (bottom)
- When `eyePosition` is `null` (no face detected), pupils drift back to centre over 0.5s

### 2. `VoiceOutput` (`frontend/src/voiceOutput.ts`)

Thin wrapper around `window.speechSynthesis`.

```ts
interface VoiceOutput {
  speak(text: string, onStart: () => void, onEnd: () => void): void
  cancel(): void
}
```

- Strips `<emotion …/>` tags before speaking (same as `cleanSpokenText` in the proxy)
- Fires `onStart` → sets `emotion = 'speaking'`; fires `onEnd` → sets `emotion = 'idle'`
- Uses `SpeechSynthesisUtterance.onboundary` to pulse the waveform bars during speech
- Voice: first available `en` voice; falls back to system default
- Works in WKWebView on macOS 12+ (confirmed supported)

### 3. `ChatSession` (`frontend/src/chatSession.ts`)

Replaces the Tavus `createConversation` / `endConversation` flow.

```ts
interface ChatSession {
  send(text: string): Promise<void>  // POST to proxy, stream response, call VoiceOutput.speak()
  abort(): void
}
```

- `POST http://localhost:8787/v1/chat/completions` (streaming SSE)
- Auth: `Authorization: Bearer ${VITE_PROXY_API_KEY}` (env var, build-time)
- Maintains conversation history in memory (rolling, last 40 turns)
- On response: calls `VoiceOutput.speak()` → drives emotion state
- On `tool_call` event from proxy SSE: sets `emotion = 'thinking'`
- On `transcript assistant` event: sets `emotion = 'idle'` (after speaking ends)

### 4. `EyeTracker` (Rust — `frontend/src-tauri/src/eye_tracker.rs`)

Feature-gated behind `eye-tracking` cargo feature (same pattern as `wake-word`).

**Implementation:**
- `objc2-av-foundation`: open default camera input, `AVCaptureSession` at 640×480 30fps
- Sample every 3rd frame (~10fps) to keep CPU low
- `objc2-vision`: `VNDetectFaceRectanglesRequest` on each sampled frame
- Extract `boundingBox` of first detected face → centre `{x, y}` normalised (Vision uses bottom-left origin; flip Y)
- Emit Tauri event `"face-position"` with `{x: f32, y: f32}` or `{x: null, y: null}` when no face
- Runs on a dedicated background thread; gracefully stops when `AppHandle` is dropped

**Cargo deps (optional):**
```toml
objc2-av-foundation = { version = "0.3", optional = true }
objc2-vision        = { version = "0.3", optional = true }
```

**Feature flag:** `eye-tracking = ["dep:objc2-av-foundation", "dep:objc2-vision"]`

**npm scripts:**
```
tauri:dev:full   = tauri dev --features wake-word,eye-tracking
tauri:build:full = tauri build --features wake-word,eye-tracking
```

### 5. `TextInput` (inline in `App.tsx`)

Simple controlled `<input type="text">` + submit button (or Enter key).

- Placeholder: `"Message Jarvis…"`
- Focused automatically on `"wake-word"` Tauri event
- Disabled while `ChatSession` is streaming a response
- Cleared on submit
- Sits below the face in the left panel, above the camera PiP

### 6. `CameraPreview` (inline in left panel)

`<video>` element fed from `getUserMedia({ video: true, audio: false })`.

- Fixed size: `120×90px`, bottom-left of face panel
- `object-fit: cover`, `border-radius: 8px`, `opacity: 0.75`
- Camera stream is shared: EyeTracker (Rust) opens its own `AVCaptureSession` independently; the webview `getUserMedia` is display-only
- If `getUserMedia` is denied, hide silently (eye tracking still works via Rust session)

---

## Files Changed

### Removed
- `frontend/src/components/cvi/` — entire Daily/CVI component tree
- `frontend/src/api.ts` — `createConversation`, `endConversation`, `onWakeWord` (wake word now wired directly in `App.tsx`)
- `frontend/src-tauri/src/tavus.rs` — Tavus API client
- `frontend/server.mjs` — dev backend that created Tavus conversations
- `lib/tavus.mjs`, `scripts/setup-tavus.mjs` — Tavus CLI helpers
- `docs/tavus/` — vendored Tavus references

### Added
- `frontend/src/components/JarvisFace.tsx` + `JarvisFace.css`
- `frontend/src/voiceOutput.ts`
- `frontend/src/chatSession.ts`
- `frontend/src-tauri/src/eye_tracker.rs`

### Modified
- `frontend/src/App.tsx` — replace CVI wiring with JarvisFace + ChatSession + TextInput + EyeTracker events
- `frontend/src/App.css` — remove Tavus-specific styles, keep layout shell
- `frontend/src-tauri/Cargo.toml` — add `eye-tracking` feature + objc2 optional deps
- `frontend/src-tauri/src/lib.rs` — spawn `eye_tracker::spawn` alongside wake word
- `frontend/package.json` — remove `@daily-co/*`, add `tauri:dev:full` / `tauri:build:full` scripts
- `README.md` — already updated (Mermaid diagram)
- `.env` / `.env.example` — remove `TAVUS_*`, `PUBLIC_PROXY_BASE_URL`, `NGROK_AUTHTOKEN`

### Unchanged
- `proxy/` — entirely unchanged
- `frontend/src/AgentConsole.tsx` + `AgentConsole.css`
- `frontend/src/agentEvents.ts`
- `frontend/src-tauri/src/wake_word.rs`
- `frontend/src-tauri/src/session.rs`
- `frontend/src-tauri/vendor/pv_porcupine-3.0.0/`

---

## Emotion State Machine

```
idle ──[send message]──► thinking ──[first token]──► speaking ──[utterance end]──► idle
idle ──[wake word]──────────────────────────────────────────────────────────────► idle (focus input)
speaking ──[user sends new message]──► abort speech ──► thinking
```

`AgentConsole` `tool_call` events → `thinking`; `tool_result` events → no change (stay in current state)

---

## Not in Scope (v1)

- Voice input / STT (type-to-talk only)
- Custom "Hey Jarvus" keyword (built-in "Jarvis" Picovoice keyword used)
- Lip sync tied to phonemes (waveform bars only)
- Windows / Linux support for eye tracking (macOS Vision only)
- Pausing wake-word listener during active chat

---

## Open Questions (resolved)

| Question | Decision |
|---|---|
| Face style | Black & white, round, NOMI-inspired (v3 prototype) |
| Eye tracking source | Mouse cursor → **macOS Vision face detection** |
| Eye tracking precision | Coarse face-position (~10fps), not iris gaze |
| Voice output | Web SpeechSynthesis (works in WKWebView) |
| v1 input | Text only; STT later |
| Layout | A — face left, console right |
| Tavus hosted LLM | Dropped entirely |
| Public tunnel | Not needed — proxy is local |
