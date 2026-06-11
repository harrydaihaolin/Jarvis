# Vision Perception Layer — Design Spec

**Date:** 2026-06-11
**Status:** Approved

## Goal

Give Jarvis always-on ambient awareness of what's on the screen and what the camera sees. A `perception/` module runs continuous background capture loops inside the existing Python `agent/` service. A `PerceptionState` object is updated continuously and injected into the supervisor system prompt at every conversation turn — no tool call required.

**Prerequisite:** LangGraph foundation plan (`2026-06-11-langgraph-foundation.md`) must be complete.

---

## Architecture

```
server.py lifespan
    └── PerceptionService.start()
            ├── _screen_loop()    every 15s  →  PerceptionState.screen_description
            └── _camera_loop()    every 8s   →  PerceptionState.{face_emotion, presence, environment, people_in_frame}

graph/supervisor.py  build_system_prompt()
    └── appends <perception> block from PerceptionState
```

All blocking work (screen grab, camera read, vision API call) runs in a `ThreadPoolExecutor` — never stalls the FastAPI event loop.

---

## Module Layout

```
agent/src/perception/
  __init__.py
  service.py      # PerceptionService: starts loops, owns PerceptionState
  state.py        # PerceptionState dataclass + to_context_string()
  screen.py       # mss screen capture → JPEG bytes
  camera.py       # OpenCV camera capture → JPEG bytes
  vision.py       # Anthropic vision API calls (screen + camera prompts)
```

---

## PerceptionState

```python
@dataclass
class PerceptionState:
    # Screen
    screen_description: str = ""
    screen_updated_at: float = 0.0

    # Camera
    face_emotion: str = ""       # focused | neutral | confused | tired | surprised | not_visible
    presence: str = ""           # at_desk | away | looking_away
    environment: str = ""        # one-sentence surroundings description
    people_in_frame: int = 0     # count of all visible people
    camera_updated_at: float = 0.0
```

`to_context_string()` returns the text injected into the system prompt:

```python
def to_context_string(self) -> str:
    parts = []
    if self.screen_description:
        parts.append(f"Screen: {self.screen_description}")
    camera_parts = []
    if self.face_emotion:
        camera_parts.append(self.face_emotion.capitalize())
    if self.presence:
        camera_parts.append(self.presence.replace("_", " "))
    if self.environment:
        camera_parts.append(self.environment)
    if self.people_in_frame:
        camera_parts.append(f"{self.people_in_frame} other(s) visible")
    if camera_parts:
        parts.append(f"Camera: {', '.join(camera_parts)}.")
    return "\n".join(parts)
```

Example output:
```
Screen: VS Code open, editing agent/src/perception/service.py in the Jarvis project.
Camera: Focused, at desk, home office clean desk natural light, 1 other(s) visible.
```

If a field is empty (camera unavailable, no screen yet) it is omitted from the string.

---

## Capture

### Screen — `screen.py`

Uses `mss` (primary monitor, `monitors[1]`). Frame is JPEG-compressed via Pillow before sending to the vision API to reduce token cost.

```python
import mss
from PIL import Image
import io

def capture_screen_jpeg(quality: int = 75) -> bytes:
    with mss.mss() as sct:
        img = sct.grab(sct.monitors[1])
        pil = Image.frombytes("RGB", img.size, img.bgra, "raw", "BGRX")
        buf = io.BytesIO()
        pil.save(buf, format="JPEG", quality=quality)
        return buf.getvalue()
```

### Camera — `camera.py`

Uses OpenCV `VideoCapture(0)`. The capture object is opened once at service start and kept open. If no camera device is available, `open()` returns `False` and the camera loop exits cleanly without affecting screen capture.

```python
import cv2

class CameraCapture:
    def __init__(self):
        self._cap: cv2.VideoCapture | None = None

    def open(self) -> bool:
        self._cap = cv2.VideoCapture(0)
        return self._cap.isOpened()

    def capture_jpeg(self, quality: int = 85) -> bytes | None:
        if not self._cap:
            return None
        ret, frame = self._cap.read()
        if not ret:
            return None
        _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        return buf.tobytes()

    def close(self):
        if self._cap:
            self._cap.release()
```

---

## Vision Analysis — `vision.py`

Direct `anthropic.AsyncAnthropic` call (same client already in `Providers`). Uses `claude-sonnet-4-6` (vision-capable). Max tokens kept low — outputs are short structured text.

### Screen prompt (max_tokens=150)

```
Describe what's on this screen in 1–2 concise sentences.
Focus on: which app is open, what the user appears to be doing,
any key text or content visible. Be brief and factual.
```

### Camera prompt (max_tokens=120)

```
Analyze this camera frame. Respond with JSON only, no explanation:
{
  "face_emotion": "<focused|neutral|confused|tired|surprised|not_visible>",
  "presence": "<at_desk|away|looking_away>",
  "people_in_frame": <integer>,
  "environment": "<one sentence describing visible surroundings>"
}
```

JSON is parsed into `PerceptionState` fields. On parse failure the previous state is kept and the error is logged — the agent turn continues normally.

### Image encoding

Both screen and camera frames are sent as base64-encoded JPEG:

```python
import base64
import anthropic

async def call_vision(client: anthropic.AsyncAnthropic, image_bytes: bytes, prompt: str, max_tokens: int, model: str) -> str:
    response = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": base64.standard_b64encode(image_bytes).decode(),
                    },
                },
                {"type": "text", "text": prompt},
            ],
        }],
    )
    return response.content[0].text
```

---

## PerceptionService — `service.py`

```python
class PerceptionService:
    def __init__(self, anthropic_client, screen_interval: float, camera_interval: float, vision_model: str):
        self.state = PerceptionState()
        self._client = anthropic_client
        self._screen_interval = screen_interval
        self._camera_interval = camera_interval
        self._vision_model = vision_model
        self._camera = CameraCapture()
        self._executor = ThreadPoolExecutor(max_workers=2)
        self._tasks: list[asyncio.Task] = []

    async def start(self):
        if not self._camera.open():
            log.warning("[perception] no camera device found — camera loop disabled")
        self._tasks = [
            asyncio.create_task(self._screen_loop()),
            asyncio.create_task(self._camera_loop()),
        ]

    async def stop(self):
        for t in self._tasks:
            t.cancel()
        self._camera.close()

    async def _screen_loop(self):
        loop = asyncio.get_event_loop()
        while True:
            try:
                img = await loop.run_in_executor(self._executor, capture_screen_jpeg)
                desc = await call_vision(self._client, img, SCREEN_PROMPT, 150, self._vision_model)
                self.state.screen_description = desc.strip()
                self.state.screen_updated_at = time.monotonic()
            except Exception as e:
                log.warning("[perception] screen error: %s", e)
            await asyncio.sleep(self._screen_interval)

    async def _camera_loop(self):
        loop = asyncio.get_event_loop()
        while True:
            try:
                img = await loop.run_in_executor(self._executor, self._camera.capture_jpeg)
                if img:
                    raw = await call_vision(self._client, img, CAMERA_PROMPT, 120, self._vision_model)
                    parsed = json.loads(raw)
                    self.state.face_emotion = parsed.get("face_emotion", "")
                    self.state.presence = parsed.get("presence", "")
                    self.state.people_in_frame = int(parsed.get("people_in_frame", 0))
                    self.state.environment = parsed.get("environment", "")
                    self.state.camera_updated_at = time.monotonic()
            except Exception as e:
                log.warning("[perception] camera error: %s", e)
            await asyncio.sleep(self._camera_interval)
```

---

## Context Injection

In `graph/supervisor.py`, `build_system_prompt()` accepts an optional `PerceptionState`:

```python
def build_system_prompt(user_system: str | None, memory_context: str = "", perception: PerceptionState | None = None) -> str:
    ...
    if perception:
        ctx = perception.to_context_string()
        if ctx:
            prompt += f"\n\n<perception>\n{ctx}\n</perception>"
    return prompt
```

`server.py` passes `perception_service.state` into `build_system_prompt()` on every turn. No cache control on the perception block — it changes every 8–15 seconds.

---

## Cost Estimate

| Capture | Interval | Tokens/call | Calls/min | Cost/min (Sonnet) |
|---|---|---|---|---|
| Screen | 15s | ~1,800 | 4 | ~$0.02 |
| Camera | 8s | ~1,200 | 7.5 | ~$0.03 |
| **Total** | | | **~11.5** | **~$0.05/min** |

Intervals are configurable — raising them to 30s/15s roughly halves cost.

---

## Environment Variables

```
PERCEPTION_ENABLED=true
PERCEPTION_SCREEN_ENABLED=true
PERCEPTION_CAMERA_ENABLED=true
PERCEPTION_SCREEN_INTERVAL_S=15
PERCEPTION_CAMERA_INTERVAL_S=8
PERCEPTION_VISION_MODEL=claude-sonnet-4-6
```

---

## New Dependencies

Add to `agent/pyproject.toml`:

```toml
"mss>=9.0",
"opencv-python>=4.9",
"Pillow>=10.0",
```

---

## What is NOT changing

- Tauri frontend — zero changes
- LangGraph graph structure — perception is injected at the prompt level only
- Memory store — perception state is ephemeral (not persisted across sessions)
- TTS / STT — unchanged
