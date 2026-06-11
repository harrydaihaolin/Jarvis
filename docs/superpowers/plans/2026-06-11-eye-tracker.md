# Eye Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Swift AVFoundation eye-tracking sidecar that drives JarvisFace eyeball animation and feeds real-time presence state into the Python `PerceptionService` via a dedicated Rust→agent HTTP path.

**Architecture:** Swift sidecar emits JSON face-position lines at ~10fps to stdout. Rust `eye_tracker.rs` reads them, emits a `face-position` Tauri event for animation, and POSTs `{detected, x, y}` to Python `POST /perception/eye` using a persistent `reqwest::Client`. Python `PerceptionService.update_eye()` writes `presence` directly to `PerceptionState` — replacing the slower 8s camera-loop Claude vision inference. Camera loop keeps `face_emotion`, `environment`, `people_in_frame` but drops `presence`.

**Tech Stack:** Swift (AVFoundation + Vision), Rust (tauri-plugin-shell, reqwest, serde_json), Python 3.12 (FastAPI, pydantic), pytest, pytest-asyncio

**Prerequisites:** `2026-06-11-vision-perception.md` complete — `PerceptionService`, `PerceptionState`, `_camera_loop`, and `CAMERA_PROMPT` must exist in `agent/src/perception/`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `frontend/src-tauri/sidecar/jarvus-eye-tracker.swift` | Create | AVFoundation + Vision face detect → JSON stdout at ~10fps |
| `scripts/build-sidecar.sh` | Create | Compile Swift sidecar → `binaries/jarvus-eye-tracker-<triple>` |
| `frontend/src-tauri/binaries/` | Create dir | Holds compiled sidecar binary (committed) |
| `frontend/src-tauri/src/eye_tracker.rs` | Create | Spawn sidecar, emit Tauri event, POST to Python |
| `frontend/src-tauri/src/lib.rs` | Modify | Register eye-tracking feature + plugin |
| `frontend/src-tauri/Cargo.toml` | Modify | Add `reqwest`, `tauri-plugin-shell`, `serde_json` as optional |
| `frontend/src-tauri/tauri.conf.json` | Modify | Add `externalBin` entry |
| `frontend/package.json` | Modify | Add `tauri:dev:full` + `tauri:build:full` scripts |
| `agent/src/perception/service.py` | Modify | Add `update_eye()`, `_eye_last_seen`, `_eye_away_threshold`; remove `presence` write from `_camera_loop` |
| `agent/src/perception/vision.py` | Modify | Remove `presence` from `CAMERA_PROMPT` |
| `agent/src/server.py` | Modify | Add `POST /perception/eye` endpoint + `EyePayload` model |
| `agent/tests/test_perception_eye.py` | Create | Unit tests for `update_eye()` + `/perception/eye` endpoint |
| `agent/tests/test_perception_vision.py` | Modify | Add assertion that `CAMERA_PROMPT` has no `presence` field |

---

### Task 1: Swift sidecar + build script

**Files:**
- Create: `frontend/src-tauri/sidecar/jarvus-eye-tracker.swift`
- Create: `scripts/build-sidecar.sh`
- Create dir: `frontend/src-tauri/binaries/`

- [ ] **Step 1: Create the Swift sidecar**

```swift
// frontend/src-tauri/sidecar/jarvus-eye-tracker.swift
import AVFoundation
import Vision
import Foundation

func emit(_ json: String) {
    FileHandle.standardOutput.write(Data((json + "\n").utf8))
}

class EyeTracker: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "eye-tracker.capture")

    override init() {
        super.init()
        session.sessionPreset = .low
        guard
            let device = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device)
        else {
            fputs("[eye-tracker] no camera available\n", stderr)
            return
        }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.setSampleBufferDelegate(self, queue: queue)
        output.alwaysDiscardsLateVideoFrames = true
        session.addOutput(output)
    }

    func start() {
        session.startRunning()
        dispatchMain()
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let request = VNDetectFaceRectanglesRequest { req, error in
            guard error == nil,
                  let results = req.results as? [VNFaceObservation],
                  let face = results.max(by: { $0.boundingBox.width < $1.boundingBox.width })
            else {
                emit("{\"detected\":false,\"x\":null,\"y\":null}")
                return
            }
            // Vision uses bottom-left origin; convert Y to top-left origin
            let cx = face.boundingBox.midX
            let cy = 1.0 - face.boundingBox.midY
            emit(String(format: "{\"detected\":true,\"x\":%.3f,\"y\":%.3f}", cx, cy))
        }

        let handler = VNImageRequestHandler(cvPixelBuffer: imageBuffer, options: [:])
        try? handler.perform([request])
    }
}

let tracker = EyeTracker()
tracker.start()
```

- [ ] **Step 2: Create the build script**

```bash
#!/usr/bin/env bash
# scripts/build-sidecar.sh
set -euo pipefail

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin" ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

SRC="frontend/src-tauri/sidecar/jarvus-eye-tracker.swift"
OUT="frontend/src-tauri/binaries/jarvus-eye-tracker-${TRIPLE}"

mkdir -p frontend/src-tauri/binaries
swiftc -O "$SRC" -o "$OUT"
chmod +x "$OUT"
echo "Built: $OUT"
```

```bash
chmod +x scripts/build-sidecar.sh
```

- [ ] **Step 3: Build the sidecar**

```bash
./scripts/build-sidecar.sh
```

Expected output:
```
Built: frontend/src-tauri/binaries/jarvus-eye-tracker-aarch64-apple-darwin
```

- [ ] **Step 4: Smoke-test the binary**

```bash
timeout 3 frontend/src-tauri/binaries/jarvus-eye-tracker-aarch64-apple-darwin || true
```

Expected: lines of JSON printed to stdout before timeout kills it:
```
{"detected":true,"x":0.512,"y":0.348}
{"detected":true,"x":0.511,"y":0.350}
```
(or `{"detected":false,"x":null,"y":null}` if no face in frame — both are correct)

- [ ] **Step 5: Commit**

```bash
git add frontend/src-tauri/sidecar/jarvus-eye-tracker.swift \
        frontend/src-tauri/binaries/ \
        scripts/build-sidecar.sh
git commit -m "feat(eye-tracker): add Swift AVFoundation sidecar + build script"
```

---

### Task 2: Rust `eye_tracker.rs` + Tauri wiring

**Files:**
- Create: `frontend/src-tauri/src/eye_tracker.rs`
- Modify: `frontend/src-tauri/Cargo.toml`
- Modify: `frontend/src-tauri/tauri.conf.json`
- Modify: `frontend/src-tauri/src/lib.rs`
- Modify: `frontend/package.json`

- [ ] **Step 1: Add Rust dependencies to `Cargo.toml`**

Open `frontend/src-tauri/Cargo.toml`. Add the following to `[dependencies]` (keep existing entries):

```toml
tauri-plugin-shell = { version = "2", optional = true }
reqwest = { version = "0.12", features = ["json"], optional = true }
serde_json = { version = "1", optional = true }
```

Add or extend the `[features]` section:

```toml
[features]
# existing features (wake-word etc.) remain unchanged — only add eye-tracking
eye-tracking = ["dep:tauri-plugin-shell", "dep:reqwest", "dep:serde_json"]
```

- [ ] **Step 2: Verify default build still passes**

```bash
cd frontend && cargo build 2>&1 | tail -5
```

Expected: `Finished dev [unoptimized + debuginfo] target(s) in ...` — no errors. The `eye-tracking` feature must not affect the default build.

- [ ] **Step 3: Add `externalBin` to `tauri.conf.json`**

Find the `"bundle"` object in `frontend/src-tauri/tauri.conf.json` and add `"externalBin"`:

```json
"bundle": {
  "externalBin": ["binaries/jarvus-eye-tracker"],
  ...existing fields...
}
```

- [ ] **Step 4: Create `frontend/src-tauri/src/eye_tracker.rs`**

```rust
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FacePayload {
    detected: bool,
    x: Option<f64>,
    y: Option<f64>,
}

pub fn spawn_eye_tracker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();

        let sidecar = match app.shell().sidecar("jarvus-eye-tracker") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[eye-tracker] sidecar not found: {e}");
                return;
            }
        };

        let (mut rx, _child) = match sidecar.spawn() {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[eye-tracker] spawn failed: {e}");
                return;
            }
        };

        eprintln!("[eye-tracker] sidecar started");
        let mut buf = String::new();

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(pos) = buf.find('\n') {
                        let line = buf[..pos].trim().to_string();
                        buf = buf[pos + 1..].to_string();
                        if line.is_empty() {
                            continue;
                        }
                        let Ok(payload) = serde_json::from_str::<FacePayload>(&line) else {
                            continue;
                        };
                        // 1. Drive face animation
                        let _ = app.emit("face-position", &payload);
                        // 2. Update Python PerceptionState (fire-and-forget)
                        let _ = client
                            .post("http://localhost:8787/perception/eye")
                            .json(&payload)
                            .send()
                            .await;
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[eye-tracker] {}", String::from_utf8_lossy(&bytes));
                }
                _ => {}
            }
        }
        eprintln!("[eye-tracker] sidecar exited");
    });
}
```

- [ ] **Step 5: Wire into `lib.rs`**

In `frontend/src-tauri/src/lib.rs`, add the module declaration and startup call. Find the existing `#[cfg(feature = "wake-word")]` block for reference — add the eye-tracking block in the same pattern:

```rust
#[cfg(feature = "eye-tracking")]
mod eye_tracker;
```

Inside the `setup` closure (where wake-word is also wired), add:

```rust
#[cfg(feature = "eye-tracking")]
{
    app.handle().plugin(tauri_plugin_shell::init())?;
    eye_tracker::spawn_eye_tracker(app.handle().clone());
}
```

- [ ] **Step 6: Update `package.json` scripts**

In `frontend/package.json`, add or update the full-feature scripts:

```json
"tauri:dev:full":   "tauri dev --features wake-word,eye-tracking",
"tauri:build:full": "tauri build --features wake-word,eye-tracking"
```

- [ ] **Step 7: Build with eye-tracking feature**

```bash
cd frontend && cargo build --features eye-tracking 2>&1 | tail -5
```

Expected: `Finished dev [unoptimized + debuginfo] target(s) in ...` — no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src-tauri/src/eye_tracker.rs \
        frontend/src-tauri/src/lib.rs \
        frontend/src-tauri/Cargo.toml \
        frontend/src-tauri/Cargo.lock \
        frontend/src-tauri/tauri.conf.json \
        frontend/package.json
git commit -m "feat(eye-tracker): add Rust sidecar spawner with Tauri event + reqwest POST"
```

---

### Task 3: Python `update_eye()` + presence logic

**Files:**
- Modify: `agent/src/perception/service.py`
- Create: `agent/tests/test_perception_eye.py`

- [ ] **Step 1: Write failing tests**

```python
# agent/tests/test_perception_eye.py
import time
from unittest.mock import MagicMock, patch
from agent.src.perception.service import PerceptionService


def _make_service() -> PerceptionService:
    client = MagicMock()
    with patch("agent.src.perception.service.CameraCapture") as mock_cam:
        mock_cam.return_value.open.return_value = False
        svc = PerceptionService(
            client,
            screen_interval=999,
            camera_interval=999,
            camera_enabled=False,
        )
    return svc


def test_update_eye_at_desk_center():
    svc = _make_service()
    svc.update_eye(True, 0.5, 0.5)
    assert svc.state.presence == "at_desk"


def test_update_eye_at_desk_left_boundary():
    svc = _make_service()
    svc.update_eye(True, 0.15, 0.5)
    assert svc.state.presence == "at_desk"


def test_update_eye_at_desk_right_boundary():
    svc = _make_service()
    svc.update_eye(True, 0.85, 0.5)
    assert svc.state.presence == "at_desk"


def test_update_eye_looking_away_left():
    svc = _make_service()
    svc.update_eye(True, 0.10, 0.5)
    assert svc.state.presence == "looking_away"


def test_update_eye_looking_away_right():
    svc = _make_service()
    svc.update_eye(True, 0.90, 0.5)
    assert svc.state.presence == "looking_away"


def test_update_eye_away_after_threshold():
    svc = _make_service()
    svc._eye_away_threshold = 3.0
    svc._eye_last_seen = time.monotonic() - 5.0  # 5s ago → over threshold
    svc.update_eye(False, None, None)
    assert svc.state.presence == "away"


def test_update_eye_not_away_before_threshold():
    svc = _make_service()
    svc._eye_away_threshold = 3.0
    svc._eye_last_seen = time.monotonic() - 1.0  # 1s ago → under threshold
    svc.state.presence = "at_desk"
    svc.update_eye(False, None, None)
    assert svc.state.presence == "at_desk"  # unchanged


def test_update_eye_detected_resets_last_seen():
    svc = _make_service()
    svc._eye_last_seen = 0.0
    svc.update_eye(True, 0.5, 0.5)
    assert svc._eye_last_seen > 0.0
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_perception_eye.py -v
```

Expected: `AttributeError: 'PerceptionService' object has no attribute 'update_eye'`

- [ ] **Step 3: Add `update_eye()` and new `__init__` fields to `service.py`**

In `agent/src/perception/service.py`, add to `__init__` (after existing fields):

```python
self._eye_last_seen: float = 0.0
self._eye_away_threshold: float = float(os.getenv("PERCEPTION_EYE_AWAY_S", "3"))
```

Add `import os` at the top if not already present.

Add the method to `PerceptionService` (after `stop()`):

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

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_perception_eye.py -v
```

Expected: 8 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/perception/service.py agent/tests/test_perception_eye.py
git commit -m "feat(eye-tracker): add PerceptionService.update_eye() with presence logic"
```

---

### Task 4: Python `/perception/eye` endpoint

**Files:**
- Modify: `agent/src/server.py`
- Modify: `agent/tests/test_perception_eye.py`

- [ ] **Step 1: Write failing tests**

Add to `agent/tests/test_perception_eye.py`:

```python
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient
from agent.src.server import app


def test_perception_eye_endpoint_calls_update_eye():
    mock_svc = MagicMock()
    with patch("agent.src.server.perception_service", mock_svc):
        client = TestClient(app)
        resp = client.post(
            "/perception/eye",
            json={"detected": True, "x": 0.5, "y": 0.4},
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    mock_svc.update_eye.assert_called_once_with(True, 0.5, 0.4)


def test_perception_eye_endpoint_no_crash_when_service_none():
    with patch("agent.src.server.perception_service", None):
        client = TestClient(app)
        resp = client.post(
            "/perception/eye",
            json={"detected": False, "x": None, "y": None},
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_perception_eye_endpoint_rejects_missing_detected():
    client = TestClient(app)
    resp = client.post("/perception/eye", json={"x": 0.5, "y": 0.4})
    assert resp.status_code == 422
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_perception_eye.py::test_perception_eye_endpoint_calls_update_eye -v
```

Expected: `404 Not Found` — endpoint doesn't exist yet.

- [ ] **Step 3: Add endpoint to `server.py`**

Add the Pydantic model and endpoint to `agent/src/server.py`. Place the model near other Pydantic models, and the endpoint near other routes:

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

Ensure `from pydantic import BaseModel` is already imported (it will be, from existing models).

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_perception_eye.py -v
```

Expected: all tests PASSED (8 from Task 3 + 3 from this task = 11 total)

- [ ] **Step 5: Commit**

```bash
git add agent/src/server.py agent/tests/test_perception_eye.py
git commit -m "feat(eye-tracker): add POST /perception/eye endpoint"
```

---

### Task 5: Camera loop deconfliction

**Files:**
- Modify: `agent/src/perception/vision.py`
- Modify: `agent/src/perception/service.py`
- Modify: `agent/tests/test_perception_vision.py`

Eye tracker now owns `presence`. Remove it from the camera path so the two don't race.

- [ ] **Step 1: Write failing test**

Add to `agent/tests/test_perception_vision.py`:

```python
def test_camera_prompt_has_no_presence_field():
    from agent.src.perception.vision import CAMERA_PROMPT
    assert '"presence"' not in CAMERA_PROMPT
    assert "at_desk" not in CAMERA_PROMPT
    assert "looking_away" not in CAMERA_PROMPT
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd agent && uv run pytest tests/test_perception_vision.py::test_camera_prompt_has_no_presence_field -v
```

Expected: FAIL — `presence` still in prompt.

- [ ] **Step 3: Update `CAMERA_PROMPT` in `vision.py`**

Replace the full `CAMERA_PROMPT` constant:

```python
CAMERA_PROMPT = (
    "Analyze this camera frame. Respond with JSON only, no explanation:\n"
    "{\n"
    '  "face_emotion": "<focused|neutral|confused|tired|surprised|not_visible>",\n'
    '  "people_in_frame": <integer>,\n'
    '  "environment": "<one sentence describing visible surroundings>"\n'
    "}"
)
```

- [ ] **Step 4: Remove `presence` write from `_camera_loop()` in `service.py`**

Find this line in `_camera_loop()`:

```python
self.state.presence = parsed.get("presence", "")
```

Delete it. The method should now only write `face_emotion`, `people_in_frame`, `environment`, and `camera_updated_at`.

- [ ] **Step 5: Run all perception tests**

```bash
cd agent && uv run pytest tests/test_perception_vision.py tests/test_perception_eye.py tests/test_perception_service.py -v
```

Expected: all tests PASSED.

- [ ] **Step 6: Run full test suite**

```bash
cd agent && uv run pytest -v
```

Expected: all tests PASSED.

- [ ] **Step 7: Add env var to `.env.example`**

```bash
# Eye tracker presence timeout
PERCEPTION_EYE_AWAY_S=3
```

- [ ] **Step 8: Commit**

```bash
git add agent/src/perception/vision.py \
        agent/src/perception/service.py \
        agent/tests/test_perception_vision.py \
        .env.example
git commit -m "feat(eye-tracker): deconflict camera loop — eye tracker owns presence field"
```

---

### Task 6: Full smoke test

**Verify the complete pipeline end-to-end.**

- [ ] **Step 1: Build sidecar (or confirm it's current)**

```bash
./scripts/build-sidecar.sh
```

Expected: `Built: frontend/src-tauri/binaries/jarvus-eye-tracker-aarch64-apple-darwin`

- [ ] **Step 2: Start the Python agent**

```bash
npm run agent
```

Expected: server starts on port 8787 with no errors. Log should show:
```
[perception] started (screen=True camera=True/False)
```

- [ ] **Step 3: Simulate an eye-tracker POST manually**

```bash
curl -s -X POST http://localhost:8787/perception/eye \
  -H "Content-Type: application/json" \
  -d '{"detected": true, "x": 0.52, "y": 0.41}'
```

Expected: `{"ok":true}`

- [ ] **Step 4: Verify presence updated**

```bash
curl -s http://localhost:8787/health
```

Check logs — `PerceptionState.presence` should be `at_desk` (not checked via health but visible if the agent adds a debug endpoint — check server logs instead).

Alternatively: send a chat message and observe the `<perception>` block in the system prompt (add `log.debug` temporarily if needed).

- [ ] **Step 5: Test away detection**

```bash
curl -s -X POST http://localhost:8787/perception/eye \
  -H "Content-Type: application/json" \
  -d '{"detected": false, "x": null, "y": null}'
sleep 4
curl -s -X POST http://localhost:8787/perception/eye \
  -H "Content-Type: application/json" \
  -d '{"detected": false, "x": null, "y": null}'
```

After 4s with no face, presence should transition to `away`.

- [ ] **Step 6: Launch full Tauri app with eye-tracking**

```bash
npm run tauri:dev:full
```

Expected:
- App launches
- Console log shows `[eye-tracker] sidecar started`
- Move your face left/right → JarvisFace eyeballs track
- Walk away from camera → after ~3s, `PerceptionState.presence = "away"` (visible in next agent turn's system prompt)

- [ ] **Step 7: Commit binary**

```bash
git add -f frontend/src-tauri/binaries/
git commit -m "feat(eye-tracker): commit compiled sidecar binary"
```
