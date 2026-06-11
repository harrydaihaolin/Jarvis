# Eye Tracker — Design Spec

**Date:** 2026-06-11
**Status:** Approved

## Goal

Make the JarvisFace eyeballs track the user's face in real-time, and feed live presence state (`at_desk` / `looking_away` / `away`) into `PerceptionState` on the Python agent — replacing the slower camera-loop Claude vision inference for presence.

**Prerequisites:**
1. `2026-06-11-vision-perception-design.md` complete — `PerceptionService` and `PerceptionState` must exist.
2. Tauri app must be running (frontend, Rust, Swift sidecar all in one process).

---

## Architecture

Two parallel pipelines from the Swift sidecar:

```
jarvus-eye-tracker.swift  (~10fps JSON stdout)
        │
eye_tracker.rs  (Rust, one persistent reqwest::Client)
        ├── emit face-position Tauri event → App.tsx → JarvisFace   (animation)
        └── POST /perception/eye {detected, x, y} → Python server   (presence)

Python PerceptionService.update_eye()
        └── sets state.presence:
                at_desk      — face detected, x in [0.15, 0.85]
                looking_away — face detected, x < 0.15 or x > 0.85
                away         — no face detected for > eye_away_threshold seconds
```

The Tauri event path and the HTTP path are fully independent. If the Python agent is not running, animation works normally — the POST silently fails and is dropped.

---

## Module Layout

```
frontend/src-tauri/sidecar/
  jarvus-eye-tracker.swift         # AVFoundation + Vision face detect → JSON stdout

scripts/
  build-sidecar.sh                 # compile swift → binaries/jarvus-eye-tracker-<triple>

frontend/src-tauri/binaries/
  jarvus-eye-tracker-aarch64-apple-darwin   # compiled binary (committed)

frontend/src-tauri/src/
  eye_tracker.rs                   # spawn sidecar, emit Tauri event + reqwest POST
  lib.rs                           # Modify: register eye-tracking feature

frontend/src-tauri/
  Cargo.toml                       # Modify: add reqwest, tauri-plugin-shell (optional)
  tauri.conf.json                  # Modify: add externalBin

agent/src/
  server.py                        # Modify: add POST /perception/eye endpoint
  perception/
    service.py                     # Modify: add update_eye(), _eye_last_seen, _eye_away_threshold
    vision.py                      # Modify: remove "presence" from CAMERA_PROMPT
```

---

## Swift Sidecar — `jarvus-eye-tracker.swift`

AVFoundation capture + `VNDetectFaceRectanglesRequest` at ~10fps. Prints one JSON line per frame to stdout:

```json
{"detected": true, "x": 0.52, "y": 0.41}
{"detected": false, "x": null, "y": null}
```

Coordinates are normalized 0–1, top-left origin. `x` and `y` are the center of the largest detected face bounding box.

**Camera permission:** the sidecar is a separate binary from the webview and may need its own TCC grant. Works reliably from the packaged `.app` (which carries `NSCameraUsageDescription`). Two processes sharing the camera (webview `getUserMedia` + the sidecar) is allowed by macOS.

---

## Build Script — `scripts/build-sidecar.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
TRIPLE="aarch64-apple-darwin"  # change to x86_64-apple-darwin on Intel
OUT="frontend/src-tauri/binaries/jarvus-eye-tracker-${TRIPLE}"
swiftc -O frontend/src-tauri/sidecar/jarvus-eye-tracker.swift -o "$OUT"
chmod +x "$OUT"
echo "Built: $OUT"
```

The compiled binary is committed under `binaries/` (use `git add -f` if gitignored). `build-sidecar.sh` regenerates it on any machine.

---

## Rust — `eye_tracker.rs`

Spawns the sidecar via `tauri-plugin-shell`. For each stdout line:

1. Parse JSON → `{detected: bool, x: f64?, y: f64?}`
2. Emit `face-position` Tauri event (for `JarvisFace` animation — unchanged)
3. POST `{detected, x, y}` to `http://localhost:8787/perception/eye` via a persistent `reqwest::Client` (created once at startup). Fire-and-forget — `.send().await` result is dropped.

```rust
// Presence POST — fire and forget
let _ = client
    .post("http://localhost:8787/perception/eye")
    .json(&payload)
    .send()
    .await;
```

`reqwest::Client` reuses the TCP connection across frames. After the first handshake to localhost, each POST is a write + read with no connection overhead — well inside the 100ms frame budget.

`CommandEvent::Stdout` payload is `Vec<u8>`. Lines must be split on `\n` and partial buffers accumulated — a single `Stdout` event may contain multiple frames or a partial frame.

**Feature flag:** the entire module is gated behind the `eye-tracking` cargo feature. Default `cargo build` is unaffected.

---

## Tauri Config Changes

**`Cargo.toml`:**
```toml
[dependencies]
tauri-plugin-shell = { version = "2", optional = true }
reqwest = { version = "0.12", features = ["json"], optional = true }

[features]
eye-tracking = ["dep:tauri-plugin-shell", "dep:reqwest"]
```

**`tauri.conf.json`** — add under `"bundle"`:
```json
"externalBin": ["binaries/jarvus-eye-tracker"]
```

**`lib.rs`** — register the plugin and call `spawn_eye_tracker`:
```rust
#[cfg(feature = "eye-tracking")]
mod eye_tracker;

// inside setup:
#[cfg(feature = "eye-tracking")]
{
    app.handle().plugin(tauri_plugin_shell::init())?;
    eye_tracker::spawn_eye_tracker(app.handle().clone());
}
```

**`package.json`** — extend existing full-feature scripts:
```json
"tauri:dev:full":   "tauri dev --features wake-word,eye-tracking",
"tauri:build:full": "tauri build --features wake-word,eye-tracking"
```

---

## Python — `/perception/eye` Endpoint

Added to `agent/src/server.py`:

```python
class EyePayload(BaseModel):
    detected: bool
    x: float | None = None
    y: float | None = None

@app.post("/perception/eye")
async def perception_eye(payload: EyePayload):
    if perception_service:
        perception_service.update_eye(payload.detected, payload.x, payload.y)
    return {"ok": True}
```

---

## Python — `PerceptionService.update_eye()`

Added to `agent/src/perception/service.py`. Called synchronously from the FastAPI handler (no `await` needed — pure in-memory write):

```python
def update_eye(self, detected: bool, x: float | None, y: float | None) -> None:
    now = time.monotonic()
    if detected:
        self._eye_last_seen = now
        if x is not None and (x < 0.15 or x > 0.85):
            self.state.presence = "looking_away"
        else:
            self.state.presence = "at_desk"
    elif now - self._eye_last_seen > self._eye_away_threshold:
        self.state.presence = "away"
```

**New `__init__` fields:**
```python
self._eye_last_seen: float = 0.0
self._eye_away_threshold: float = float(os.getenv("PERCEPTION_EYE_AWAY_S", "3"))
```

---

## Camera Loop Deconfliction

`CAMERA_PROMPT` in `agent/src/perception/vision.py` currently asks Claude to infer `presence`. The eye tracker now owns that field, so it is removed from the prompt:

**Before:**
```
{
  "face_emotion": "...",
  "presence": "<at_desk|away|looking_away>",
  "people_in_frame": <int>,
  "environment": "..."
}
```

**After:**
```
{
  "face_emotion": "...",
  "people_in_frame": <int>,
  "environment": "..."
}
```

`PerceptionService._camera_loop()` in `service.py` no longer writes `self.state.presence` — that line is deleted. `analyse_camera()` in `vision.py` is unchanged (it returns `json.loads(raw)` as-is); Claude simply won't include `presence` in its response since the prompt no longer asks for it. This saves ~$0.03/min in vision API calls and removes the 8s lag on presence detection.

---

## Environment Variables

```
PERCEPTION_EYE_AWAY_S=3    # seconds without face detection before presence → "away"
```

---

## Build Commands

```bash
# Build the Swift sidecar
./scripts/build-sidecar.sh

# Dev run with eye tracking
npm run tauri:dev:full

# Verify
# Move face left/right → JarvisFace eyes follow
# Walk away → PerceptionState.presence = "away" within 3s
# Return → presence = "at_desk"
```

---

## What Is NOT Changing

- `PerceptionState` fields — `presence` already exists; no new fields added
- `to_context_string()` — already renders `presence`; no changes
- `JarvisFace` component — already wired to `eyePosition` prop; no changes
- `App.tsx` face-position event listener — still needed for animation; no changes
- Meeting intelligence, screen capture, camera emotion — unchanged
