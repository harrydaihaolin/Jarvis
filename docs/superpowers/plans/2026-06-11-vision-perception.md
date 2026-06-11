# Vision Perception Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add always-on screen and camera awareness to the Python `agent/` service, injecting a live `<perception>` block into every supervisor turn.

**Architecture:** A `PerceptionService` runs two asyncio background loops (screen every 15s, camera every 8s) inside the existing FastAPI process. Blocking captures run in a `ThreadPoolExecutor`. A `PerceptionState` dataclass is updated in-place and injected into `build_system_prompt()` at every turn.

**Tech Stack:** Python 3.12, mss, opencv-python, Pillow, anthropic SDK (vision), pytest, pytest-asyncio

**Prerequisite:** `2026-06-11-langgraph-foundation.md` complete — `agent/src/` and `agent/tests/` must exist.

---

## File Map

| File | Responsibility |
|---|---|
| `agent/src/perception/__init__.py` | Empty package marker |
| `agent/src/perception/state.py` | `PerceptionState` dataclass + `to_context_string()` |
| `agent/src/perception/screen.py` | `capture_screen_jpeg()` using mss + Pillow |
| `agent/src/perception/camera.py` | `CameraCapture` class using OpenCV |
| `agent/src/perception/vision.py` | `analyse_screen()`, `analyse_camera()`, prompts |
| `agent/src/perception/service.py` | `PerceptionService`: loops, executor, state ownership |
| `agent/src/graph/supervisor.py` | **Modify:** `build_system_prompt()` gains `perception` param |
| `agent/src/server.py` | **Modify:** lifespan starts/stops `PerceptionService`; passes state to prompt |
| `agent/tests/test_perception_state.py` | Unit tests for `PerceptionState` |
| `agent/tests/test_perception_vision.py` | Unit tests for vision prompts + parsing |
| `agent/tests/test_perception_service.py` | Unit tests for `PerceptionService` lifecycle |

---

### Task 1: PerceptionState

**Files:**
- Create: `agent/src/perception/__init__.py`
- Create: `agent/src/perception/state.py`
- Create: `agent/tests/test_perception_state.py`

- [ ] **Step 1: Write failing tests**

```python
# agent/tests/test_perception_state.py
from agent.src.perception.state import PerceptionState


def test_to_context_string_empty():
    s = PerceptionState()
    assert s.to_context_string() == ""


def test_to_context_string_screen_only():
    s = PerceptionState(screen_description="VS Code open, editing agent.py")
    result = s.to_context_string()
    assert result == "Screen: VS Code open, editing agent.py"


def test_to_context_string_camera_fields():
    s = PerceptionState(
        face_emotion="focused",
        presence="at_desk",
        environment="home office",
        people_in_frame=0,
    )
    result = s.to_context_string()
    assert "Camera:" in result
    assert "Focused" in result
    assert "at desk" in result
    assert "home office" in result


def test_to_context_string_people_in_frame():
    s = PerceptionState(face_emotion="neutral", people_in_frame=2)
    result = s.to_context_string()
    assert "2 other(s) visible" in result


def test_to_context_string_both():
    s = PerceptionState(
        screen_description="Terminal running tests",
        face_emotion="focused",
        presence="at_desk",
        environment="desk",
    )
    lines = s.to_context_string().splitlines()
    assert lines[0].startswith("Screen:")
    assert lines[1].startswith("Camera:")


def test_meeting_fields_default():
    s = PerceptionState()
    assert s.in_meeting is False
    assert s.meeting_transcript == []
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_perception_state.py -v
```

Expected: `ImportError: No module named 'agent.src.perception'`

- [ ] **Step 3: Create `agent/src/perception/__init__.py`** (empty)

- [ ] **Step 4: Create `agent/src/perception/state.py`**

```python
from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class PerceptionState:
    # Screen
    screen_description: str = ""
    screen_updated_at: float = 0.0

    # Camera
    face_emotion: str = ""
    presence: str = ""
    environment: str = ""
    people_in_frame: int = 0
    camera_updated_at: float = 0.0

    # Meeting (used by meeting intelligence layer)
    in_meeting: bool = False
    meeting_start_time: float = 0.0
    meeting_transcript: list[str] = field(default_factory=list)

    def to_context_string(self) -> str:
        parts: list[str] = []
        if self.screen_description:
            parts.append(f"Screen: {self.screen_description}")
        camera_parts: list[str] = []
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

- [ ] **Step 5: Run tests**

```bash
cd agent && uv run pytest tests/test_perception_state.py -v
```

Expected: 6 tests PASSED

- [ ] **Step 6: Commit**

```bash
git add agent/src/perception/ agent/tests/test_perception_state.py
git commit -m "feat(perception): add PerceptionState dataclass"
```

---

### Task 2: Screen capture

**Files:**
- Create: `agent/src/perception/screen.py`
- Create: `agent/tests/test_perception_screen.py`

- [ ] **Step 1: Add mss + Pillow to deps**

In `agent/pyproject.toml`, add to `dependencies`:
```toml
"mss>=9.0",
"Pillow>=10.0",
```

Then:
```bash
cd agent && uv sync
```

- [ ] **Step 2: Write failing tests**

```python
# agent/tests/test_perception_screen.py
from unittest.mock import MagicMock, patch
from agent.src.perception.screen import capture_screen_jpeg


def test_capture_returns_bytes():
    mock_img = MagicMock()
    mock_img.size = (1920, 1080)
    mock_img.bgra = b"\x00" * (1920 * 1080 * 4)

    mock_sct = MagicMock()
    mock_sct.__enter__ = MagicMock(return_value=mock_sct)
    mock_sct.__exit__ = MagicMock(return_value=False)
    mock_sct.monitors = [None, MagicMock()]
    mock_sct.grab.return_value = mock_img

    with patch("agent.src.perception.screen.mss.mss", return_value=mock_sct):
        with patch("agent.src.perception.screen.Image") as mock_pil:
            mock_pil_img = MagicMock()
            mock_pil.frombytes.return_value = mock_pil_img
            mock_pil_img.save = MagicMock(side_effect=lambda buf, **kw: buf.write(b"FAKEJPEG"))
            result = capture_screen_jpeg()
    assert isinstance(result, bytes)
    assert len(result) > 0


def test_capture_falls_back_to_monitor_1_if_index_missing():
    mock_sct = MagicMock()
    mock_sct.__enter__ = MagicMock(return_value=mock_sct)
    mock_sct.__exit__ = MagicMock(return_value=False)
    mock_sct.monitors = [None, MagicMock()]  # only index 0+1 exist

    mock_img = MagicMock()
    mock_img.size = (800, 600)
    mock_img.bgra = b"\x00" * (800 * 600 * 4)
    mock_sct.grab.return_value = mock_img

    with patch("agent.src.perception.screen.mss.mss", return_value=mock_sct):
        with patch("agent.src.perception.screen.Image") as mock_pil:
            mock_pil_img = MagicMock()
            mock_pil.frombytes.return_value = mock_pil_img
            mock_pil_img.save = MagicMock(side_effect=lambda buf, **kw: buf.write(b"J"))
            capture_screen_jpeg(monitor_index=99)  # out-of-range → falls back to 1
    mock_sct.grab.assert_called_once_with(mock_sct.monitors[1])
```

- [ ] **Step 3: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_perception_screen.py -v
```

Expected: ImportError

- [ ] **Step 4: Create `agent/src/perception/screen.py`**

```python
from __future__ import annotations
import io
import mss
from PIL import Image


def capture_screen_jpeg(monitor_index: int = 1, quality: int = 75) -> bytes:
    """Capture a monitor and return JPEG-compressed bytes."""
    with mss.mss() as sct:
        if monitor_index >= len(sct.monitors):
            monitor_index = 1
        raw = sct.grab(sct.monitors[monitor_index])
        pil = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
        buf = io.BytesIO()
        pil.save(buf, format="JPEG", quality=quality)
        return buf.getvalue()
```

- [ ] **Step 5: Run tests**

```bash
cd agent && uv run pytest tests/test_perception_screen.py -v
```

Expected: 2 tests PASSED

- [ ] **Step 6: Commit**

```bash
git add agent/src/perception/screen.py agent/tests/test_perception_screen.py agent/pyproject.toml
git commit -m "feat(perception): add mss screen capture"
```

---

### Task 3: Camera capture

**Files:**
- Create: `agent/src/perception/camera.py`
- Create: `agent/tests/test_perception_camera.py`

- [ ] **Step 1: Add opencv-python to deps**

In `agent/pyproject.toml`, add to `dependencies`:
```toml
"opencv-python>=4.9",
```

```bash
cd agent && uv sync
```

- [ ] **Step 2: Write failing tests**

```python
# agent/tests/test_perception_camera.py
from unittest.mock import MagicMock, patch
import numpy as np
from agent.src.perception.camera import CameraCapture


def test_open_returns_false_when_no_camera():
    with patch("agent.src.perception.camera.cv2.VideoCapture") as mock_vc:
        mock_vc.return_value.isOpened.return_value = False
        cam = CameraCapture()
        assert cam.open() is False


def test_open_returns_true_when_camera_available():
    with patch("agent.src.perception.camera.cv2.VideoCapture") as mock_vc:
        mock_vc.return_value.isOpened.return_value = True
        cam = CameraCapture()
        assert cam.open() is True


def test_capture_jpeg_returns_none_when_not_opened():
    cam = CameraCapture()
    # _cap is None (never opened)
    assert cam.capture_jpeg() is None


def test_capture_jpeg_returns_bytes():
    fake_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    with patch("agent.src.perception.camera.cv2.VideoCapture") as mock_vc:
        instance = mock_vc.return_value
        instance.isOpened.return_value = True
        instance.read.return_value = (True, fake_frame)
        with patch("agent.src.perception.camera.cv2.imencode") as mock_enc:
            mock_enc.return_value = (True, MagicMock(tobytes=lambda: b"FAKEJPEG"))
            cam = CameraCapture()
            cam.open()
            result = cam.capture_jpeg()
    assert result == b"FAKEJPEG"


def test_close_releases_capture():
    with patch("agent.src.perception.camera.cv2.VideoCapture") as mock_vc:
        instance = mock_vc.return_value
        instance.isOpened.return_value = True
        cam = CameraCapture()
        cam.open()
        cam.close()
        instance.release.assert_called_once()
```

- [ ] **Step 3: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_perception_camera.py -v
```

Expected: ImportError

- [ ] **Step 4: Create `agent/src/perception/camera.py`**

```python
from __future__ import annotations
import cv2


class CameraCapture:
    def __init__(self, device_index: int = 0) -> None:
        self._device_index = device_index
        self._cap: cv2.VideoCapture | None = None

    def open(self) -> bool:
        """Open camera device. Returns True if successful."""
        self._cap = cv2.VideoCapture(self._device_index)
        return self._cap is not None and self._cap.isOpened()

    def capture_jpeg(self, quality: int = 85) -> bytes | None:
        """Capture one frame and return JPEG bytes, or None if unavailable."""
        if self._cap is None or not self._cap.isOpened():
            return None
        ret, frame = self._cap.read()
        if not ret or frame is None:
            return None
        _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        return buf.tobytes()

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None
```

- [ ] **Step 5: Run tests**

```bash
cd agent && uv run pytest tests/test_perception_camera.py -v
```

Expected: 5 tests PASSED

- [ ] **Step 6: Commit**

```bash
git add agent/src/perception/camera.py agent/tests/test_perception_camera.py agent/pyproject.toml
git commit -m "feat(perception): add OpenCV camera capture"
```

---

### Task 4: Vision API

**Files:**
- Create: `agent/src/perception/vision.py`
- Create: `agent/tests/test_perception_vision.py`

- [ ] **Step 1: Write failing tests**

```python
# agent/tests/test_perception_vision.py
import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from agent.src.perception.vision import analyse_screen, analyse_camera, SCREEN_PROMPT, CAMERA_PROMPT


async def test_analyse_screen_returns_string():
    client = MagicMock()
    client.messages.create = AsyncMock(return_value=MagicMock(
        content=[MagicMock(text="VS Code is open with a Python file.")]
    ))
    result = await analyse_screen(client, b"FAKEJPEG", "claude-sonnet-4-6")
    assert result == "VS Code is open with a Python file."
    client.messages.create.assert_called_once()


async def test_analyse_camera_parses_json():
    payload = {
        "face_emotion": "focused",
        "presence": "at_desk",
        "people_in_frame": 0,
        "environment": "home office",
    }
    client = MagicMock()
    client.messages.create = AsyncMock(return_value=MagicMock(
        content=[MagicMock(text=json.dumps(payload))]
    ))
    result = await analyse_camera(client, b"FAKEJPEG", "claude-sonnet-4-6")
    assert result["face_emotion"] == "focused"
    assert result["people_in_frame"] == 0


async def test_analyse_camera_raises_on_invalid_json():
    client = MagicMock()
    client.messages.create = AsyncMock(return_value=MagicMock(
        content=[MagicMock(text="not json")]
    ))
    with pytest.raises(Exception):
        await analyse_camera(client, b"FAKEJPEG", "claude-sonnet-4-6")


def test_screen_prompt_is_concise():
    assert len(SCREEN_PROMPT) < 300


def test_camera_prompt_requests_json():
    assert "JSON" in CAMERA_PROMPT
    assert "face_emotion" in CAMERA_PROMPT
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_perception_vision.py -v
```

Expected: ImportError

- [ ] **Step 3: Create `agent/src/perception/vision.py`**

```python
from __future__ import annotations
import base64
import json
import anthropic

SCREEN_PROMPT = (
    "Describe what's on this screen in 1–2 concise sentences. "
    "Focus on: which app is open, what the user appears to be doing, "
    "any key text or content visible. Be brief and factual."
)

CAMERA_PROMPT = (
    "Analyze this camera frame. Respond with JSON only, no explanation:\n"
    "{\n"
    '  "face_emotion": "<focused|neutral|confused|tired|surprised|not_visible>",\n'
    '  "presence": "<at_desk|away|looking_away>",\n'
    '  "people_in_frame": <integer>,\n'
    '  "environment": "<one sentence describing visible surroundings>"\n'
    "}"
)


async def _call_vision(
    client: anthropic.AsyncAnthropic,
    image_bytes: bytes,
    prompt: str,
    max_tokens: int,
    model: str,
) -> str:
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


async def analyse_screen(
    client: anthropic.AsyncAnthropic, image_bytes: bytes, model: str
) -> str:
    return (await _call_vision(client, image_bytes, SCREEN_PROMPT, 150, model)).strip()


async def analyse_camera(
    client: anthropic.AsyncAnthropic, image_bytes: bytes, model: str
) -> dict:
    raw = await _call_vision(client, image_bytes, CAMERA_PROMPT, 120, model)
    return json.loads(raw)
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_perception_vision.py -v
```

Expected: 5 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/perception/vision.py agent/tests/test_perception_vision.py
git commit -m "feat(perception): add vision API calls (screen + camera analysis)"
```

---

### Task 5: PerceptionService

**Files:**
- Create: `agent/src/perception/service.py`
- Create: `agent/tests/test_perception_service.py`

- [ ] **Step 1: Write failing tests**

```python
# agent/tests/test_perception_service.py
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from agent.src.perception.service import PerceptionService
from agent.src.perception.state import PerceptionState


@pytest.fixture
def mock_client():
    return MagicMock()


async def test_service_start_stop(mock_client):
    with patch("agent.src.perception.service.CameraCapture") as mock_cam_cls:
        mock_cam_cls.return_value.open.return_value = False  # no camera
        svc = PerceptionService(mock_client, screen_interval=999, camera_interval=999)
        await svc.start()
        assert isinstance(svc.state, PerceptionState)
        await svc.stop()


async def test_screen_loop_updates_state(mock_client):
    with patch("agent.src.perception.service.capture_screen_jpeg", return_value=b"IMG"):
        with patch("agent.src.perception.service.analyse_screen", new_callable=AsyncMock) as mock_analyse:
            mock_analyse.return_value = "Terminal running tests"
            with patch("agent.src.perception.service.CameraCapture") as mock_cam_cls:
                mock_cam_cls.return_value.open.return_value = False
                svc = PerceptionService(
                    mock_client,
                    screen_interval=0.05,
                    camera_interval=999,
                    camera_enabled=False,
                )
                await svc.start()
                await asyncio.sleep(0.15)
                await svc.stop()
    assert svc.state.screen_description == "Terminal running tests"


async def test_camera_loop_updates_state(mock_client):
    fake_parsed = {
        "face_emotion": "focused",
        "presence": "at_desk",
        "people_in_frame": 1,
        "environment": "home office",
    }
    with patch("agent.src.perception.service.capture_screen_jpeg", return_value=b"IMG"):
        with patch("agent.src.perception.service.analyse_screen", new_callable=AsyncMock):
            with patch("agent.src.perception.service.analyse_camera", new_callable=AsyncMock) as mock_cam:
                mock_cam.return_value = fake_parsed
                with patch("agent.src.perception.service.CameraCapture") as mock_cam_cls:
                    instance = mock_cam_cls.return_value
                    instance.open.return_value = True
                    instance.capture_jpeg.return_value = b"CAMIMG"
                    svc = PerceptionService(
                        mock_client,
                        screen_interval=999,
                        camera_interval=0.05,
                    )
                    await svc.start()
                    await asyncio.sleep(0.15)
                    await svc.stop()
    assert svc.state.face_emotion == "focused"
    assert svc.state.people_in_frame == 1


async def test_screen_loop_continues_on_error(mock_client):
    call_count = 0

    async def flaky_analyse(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("vision API down")
        return "Back online"

    with patch("agent.src.perception.service.capture_screen_jpeg", return_value=b"IMG"):
        with patch("agent.src.perception.service.analyse_screen", side_effect=flaky_analyse):
            with patch("agent.src.perception.service.CameraCapture") as mock_cam_cls:
                mock_cam_cls.return_value.open.return_value = False
                svc = PerceptionService(
                    mock_client,
                    screen_interval=0.05,
                    camera_interval=999,
                    camera_enabled=False,
                )
                await svc.start()
                await asyncio.sleep(0.2)
                await svc.stop()
    assert svc.state.screen_description == "Back online"
    assert call_count >= 2
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_perception_service.py -v
```

Expected: ImportError

- [ ] **Step 3: Create `agent/src/perception/service.py`**

```python
from __future__ import annotations
import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor

import anthropic

from .camera import CameraCapture
from .screen import capture_screen_jpeg
from .state import PerceptionState
from .vision import analyse_screen, analyse_camera

log = logging.getLogger(__name__)


class PerceptionService:
    def __init__(
        self,
        anthropic_client: anthropic.AsyncAnthropic,
        screen_interval: float = 15.0,
        camera_interval: float = 8.0,
        vision_model: str = "claude-sonnet-4-6",
        screen_enabled: bool = True,
        camera_enabled: bool = True,
    ) -> None:
        self.state = PerceptionState()
        self._client = anthropic_client
        self._screen_interval = screen_interval
        self._camera_interval = camera_interval
        self._vision_model = vision_model
        self._screen_enabled = screen_enabled
        self._camera_enabled = camera_enabled
        self._camera = CameraCapture()
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="perception")
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        if self._camera_enabled:
            if not self._camera.open():
                log.warning("[perception] no camera device — camera loop disabled")
                self._camera_enabled = False
        tasks: list[asyncio.Task] = []
        if self._screen_enabled:
            tasks.append(asyncio.create_task(self._screen_loop()))
        if self._camera_enabled:
            tasks.append(asyncio.create_task(self._camera_loop()))
        self._tasks = tasks

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._camera.close()
        self._executor.shutdown(wait=False)

    async def _screen_loop(self) -> None:
        loop = asyncio.get_event_loop()
        while True:
            try:
                img = await loop.run_in_executor(self._executor, capture_screen_jpeg)
                desc = await analyse_screen(self._client, img, self._vision_model)
                self.state.screen_description = desc
                self.state.screen_updated_at = time.monotonic()
            except Exception as exc:
                log.warning("[perception] screen error: %s", exc)
            await asyncio.sleep(self._screen_interval)

    async def _camera_loop(self) -> None:
        loop = asyncio.get_event_loop()
        while True:
            try:
                img = await loop.run_in_executor(self._executor, self._camera.capture_jpeg)
                if img:
                    parsed = await analyse_camera(self._client, img, self._vision_model)
                    self.state.face_emotion = parsed.get("face_emotion", "")
                    self.state.presence = parsed.get("presence", "")
                    self.state.people_in_frame = int(parsed.get("people_in_frame", 0))
                    self.state.environment = parsed.get("environment", "")
                    self.state.camera_updated_at = time.monotonic()
            except Exception as exc:
                log.warning("[perception] camera error: %s", exc)
            await asyncio.sleep(self._camera_interval)
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_perception_service.py -v
```

Expected: 4 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/perception/service.py agent/tests/test_perception_service.py
git commit -m "feat(perception): add PerceptionService with screen + camera loops"
```

---

### Task 6: Supervisor injection

**Files:**
- Modify: `agent/src/graph/supervisor.py`
- Modify: `agent/tests/test_supervisor.py`

- [ ] **Step 1: Write new failing test**

Add to `agent/tests/test_supervisor.py`:

```python
from agent.src.perception.state import PerceptionState


def test_system_prompt_includes_perception_block():
    state = PerceptionState(
        screen_description="VS Code open",
        face_emotion="focused",
        presence="at_desk",
        environment="home office",
    )
    prompt = build_system_prompt("You are Jarvis", perception=state)
    assert "<perception>" in prompt
    assert "VS Code open" in prompt
    assert "Focused" in prompt


def test_system_prompt_no_perception_when_state_empty():
    state = PerceptionState()  # all fields empty
    prompt = build_system_prompt("You are Jarvis", perception=state)
    assert "<perception>" not in prompt


def test_system_prompt_no_perception_when_none():
    prompt = build_system_prompt("You are Jarvis", perception=None)
    assert "<perception>" not in prompt
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_supervisor.py -v
```

Expected: `TypeError: build_system_prompt() got an unexpected keyword argument 'perception'`

- [ ] **Step 3: Update `build_system_prompt` in `agent/src/graph/supervisor.py`**

Find the existing `build_system_prompt` function and replace it:

```python
from agent.src.perception.state import PerceptionState  # add this import at top


def build_system_prompt(
    user_system: str | None,
    memory_context: str = "",
    perception: PerceptionState | None = None,
) -> str:
    today = date.today().strftime("%A, %B %-d, %Y")
    date_line = f"\n\nToday's date is {today}. Use it when reasoning about current events and web searches."
    base = user_system or "You are Jarvus, a helpful voice agent."
    prompt = f"{base}{AGENT_ADDENDUM}{date_line}"
    if memory_context and memory_context.strip():
        prompt += f"\n\n<memory>\n{memory_context.strip()}\n</memory>"
    if perception:
        ctx = perception.to_context_string()
        if ctx:
            prompt += f"\n\n<perception>\n{ctx}\n</perception>"
    return prompt
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_supervisor.py -v
```

Expected: all tests PASSED (including the 3 pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add agent/src/graph/supervisor.py agent/tests/test_supervisor.py
git commit -m "feat(perception): inject PerceptionState into supervisor system prompt"
```

---

### Task 7: Wire into server

**Files:**
- Modify: `agent/src/server.py`

- [ ] **Step 1: Add env var parsing + PerceptionService startup to lifespan**

In `agent/src/server.py`, add the import at the top (with other imports):

```python
from .perception.service import PerceptionService
```

Add `perception_service: PerceptionService | None = None` alongside the other globals near the top of the file:

```python
perception_service: PerceptionService | None = None
```

In the `lifespan` function, add after `providers = create_providers()`:

```python
    global perception_service
    perception_enabled = os.getenv("PERCEPTION_ENABLED", "true") != "false"
    if perception_enabled:
        perception_service = PerceptionService(
            anthropic_client=providers.anthropic_client,
            screen_interval=float(os.getenv("PERCEPTION_SCREEN_INTERVAL_S", "15")),
            camera_interval=float(os.getenv("PERCEPTION_CAMERA_INTERVAL_S", "8")),
            vision_model=os.getenv("PERCEPTION_VISION_MODEL", "claude-sonnet-4-6"),
            screen_enabled=os.getenv("PERCEPTION_SCREEN_ENABLED", "true") != "false",
            camera_enabled=os.getenv("PERCEPTION_CAMERA_ENABLED", "true") != "false",
        )
        await perception_service.start()
        log.info("[perception] started (screen=%s camera=%s)",
                 perception_service._screen_enabled, perception_service._camera_enabled)
```

Add before `yield` at the end of `lifespan`:

```python
    yield

    if perception_service:
        await perception_service.stop()
```

- [ ] **Step 2: Pass perception state into build_system_prompt**

In `server.py`, find the line that calls `build_system_prompt(...)` and update it:

```python
    system_prompt = build_system_prompt(
        user_system,
        memory_context,
        perception=perception_service.state if perception_service else None,
    )
```

- [ ] **Step 3: Add env vars to `.env.example`**

```bash
# Vision perception
PERCEPTION_ENABLED=true
PERCEPTION_SCREEN_ENABLED=true
PERCEPTION_CAMERA_ENABLED=true
PERCEPTION_SCREEN_INTERVAL_S=15
PERCEPTION_CAMERA_INTERVAL_S=8
PERCEPTION_VISION_MODEL=claude-sonnet-4-6
```

- [ ] **Step 4: Run full test suite**

```bash
cd agent && uv run pytest -v
```

Expected: all tests PASSED

- [ ] **Step 5: Smoke test**

```bash
npm run agent
# In another terminal:
curl -s http://localhost:8787/health
```

Expected: `{"status":"ok","model":"..."}` — service starts without error, perception loops running in background.

- [ ] **Step 6: Commit**

```bash
git add agent/src/server.py .env.example
git commit -m "feat(perception): wire PerceptionService into server lifespan; inject state into prompts"
```
