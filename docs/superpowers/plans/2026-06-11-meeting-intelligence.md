# Meeting Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect active Zoom meetings, accumulate a transcript from screen captions, and at meeting end summarize + save to the Anthropic Memory Store with a spoken recap.

**Architecture:** A `_meeting_loop()` coroutine added to `PerceptionService` polls `pgrep -x zoom.us` every 5s. A state machine (`idle → active → ended`) drives transcription: when active, `_screen_loop` switches to a meeting-specific vision prompt and appends lines to `PerceptionState.meeting_transcript`. At meeting end, a summariser calls Claude, a writer saves to `/episodes/meetings/YYYY-MM-DD-HH-MM.md`, and the SSE bus broadcasts a spoken recap.

**Tech Stack:** Python 3.12, asyncio, subprocess (pgrep), anthropic SDK, existing `memory_save()` from `memory.py`, existing SSE `bus.broadcast()` from `server.py`

**Prerequisites:**
1. `2026-06-11-langgraph-foundation.md` complete — `memory.py`, `bus`, and `PerceptionService` must exist.
2. `2026-06-11-vision-perception.md` complete — `PerceptionState`, `PerceptionService`, `_screen_loop`, vision API must be wired.

---

## File Map

| File | Responsibility |
|---|---|
| `agent/src/perception/meeting/__init__.py` | Empty package marker |
| `agent/src/perception/meeting/detector.py` | `zoom_is_running()` via `pgrep` |
| `agent/src/perception/meeting/transcriber.py` | `MEETING_SCREEN_PROMPT` + `append_transcript_line()` |
| `agent/src/perception/meeting/summarizer.py` | `summarise(client, transcript, model)` → Claude call |
| `agent/src/perception/meeting/writer.py` | `save_meeting_notes(client, store_id, start_time, summary)` |
| `agent/src/perception/service.py` | **Modify:** add `_meeting_loop()`, `_on_meeting_end()`, modify `_screen_loop()` |
| `agent/src/server.py` | **Modify:** pass `meeting_poll_interval`, `meeting_min_duration`, `bus`, `store_id` to `PerceptionService` |
| `agent/tests/test_meeting_detector.py` | Unit tests for `zoom_is_running()` |
| `agent/tests/test_meeting_transcriber.py` | Unit tests for prompt + `append_transcript_line()` |
| `agent/tests/test_meeting_summarizer.py` | Unit tests for Claude call + empty transcript handling |
| `agent/tests/test_meeting_writer.py` | Unit tests for `save_meeting_notes()` |
| `agent/tests/test_perception_service.py` | **Modify:** add meeting loop tests |

---

### Task 1: Zoom detector

**Files:**
- Create: `agent/src/perception/meeting/__init__.py`
- Create: `agent/src/perception/meeting/detector.py`
- Create: `agent/tests/test_meeting_detector.py`

- [ ] **Step 1: Write failing tests**

```python
# agent/tests/test_meeting_detector.py
from unittest.mock import patch, MagicMock
from agent.src.perception.meeting.detector import zoom_is_running


def test_returns_true_when_zoom_running():
    with patch("agent.src.perception.meeting.detector.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0)
        assert zoom_is_running() is True
        mock_run.assert_called_once_with(
            ["pgrep", "-x", "zoom.us"], capture_output=True
        )


def test_returns_false_when_zoom_not_running():
    with patch("agent.src.perception.meeting.detector.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1)
        assert zoom_is_running() is False


def test_returns_false_on_subprocess_exception():
    with patch("agent.src.perception.meeting.detector.subprocess.run") as mock_run:
        mock_run.side_effect = FileNotFoundError("pgrep not found")
        assert zoom_is_running() is False
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_meeting_detector.py -v
```

Expected: `ImportError: No module named 'agent.src.perception.meeting'`

- [ ] **Step 3: Create `agent/src/perception/meeting/__init__.py`** (empty)

- [ ] **Step 4: Create `agent/src/perception/meeting/detector.py`**

```python
from __future__ import annotations
import subprocess


def zoom_is_running() -> bool:
    """Return True if zoom.us process is active."""
    try:
        result = subprocess.run(["pgrep", "-x", "zoom.us"], capture_output=True)
        return result.returncode == 0
    except Exception:
        return False
```

- [ ] **Step 5: Run tests**

```bash
cd agent && uv run pytest tests/test_meeting_detector.py -v
```

Expected: 3 tests PASSED

- [ ] **Step 6: Commit**

```bash
git add agent/src/perception/meeting/ agent/tests/test_meeting_detector.py
git commit -m "feat(meeting): add Zoom process detector"
```

---

### Task 2: Meeting transcriber

**Files:**
- Create: `agent/src/perception/meeting/transcriber.py`
- Create: `agent/tests/test_meeting_transcriber.py`

- [ ] **Step 1: Write failing tests**

```python
# agent/tests/test_meeting_transcriber.py
from agent.src.perception.meeting.transcriber import (
    MEETING_SCREEN_PROMPT,
    append_transcript_line,
)


def test_meeting_screen_prompt_mentions_captions():
    assert "caption" in MEETING_SCREEN_PROMPT.lower() or "transcript" in MEETING_SCREEN_PROMPT.lower()
    assert len(MEETING_SCREEN_PROMPT) > 50


def test_append_transcript_line_basic():
    transcript: list[str] = []
    append_transcript_line(transcript, "Hello from the meeting", elapsed_minutes=1.0)
    assert len(transcript) == 1
    assert "1m" in transcript[0]
    assert "Hello from the meeting" in transcript[0]


def test_append_transcript_line_empty_text_is_skipped():
    transcript: list[str] = []
    append_transcript_line(transcript, "", elapsed_minutes=0.5)
    append_transcript_line(transcript, "   ", elapsed_minutes=1.0)
    assert len(transcript) == 0


def test_append_transcript_line_strips_whitespace():
    transcript: list[str] = []
    append_transcript_line(transcript, "  Hello  ", elapsed_minutes=2.0)
    assert "Hello" in transcript[0]
    assert "  Hello  " not in transcript[0]


def test_append_multiple_lines():
    transcript: list[str] = []
    append_transcript_line(transcript, "First line", elapsed_minutes=1.0)
    append_transcript_line(transcript, "Second line", elapsed_minutes=2.0)
    assert len(transcript) == 2
    assert "1m" in transcript[0]
    assert "2m" in transcript[1]
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_meeting_transcriber.py -v
```

Expected: `ImportError`

- [ ] **Step 3: Create `agent/src/perception/meeting/transcriber.py`**

```python
from __future__ import annotations

MEETING_SCREEN_PROMPT = (
    "This screen shows a Zoom meeting. Extract any visible text from:\n"
    "- Live captions or subtitles (include speaker name if shown)\n"
    "- Shared screen content that appears to be meeting material (slides, docs)\n"
    "- Zoom chat messages\n\n"
    "Return only the extracted text, one item per line. "
    "If nothing meeting-relevant is visible, return an empty string."
)


def append_transcript_line(
    transcript: list[str], text: str, elapsed_minutes: float
) -> None:
    """Append a timestamped transcript entry if text is non-empty."""
    stripped = text.strip()
    if stripped:
        transcript.append(f"[{elapsed_minutes:.0f}m] {stripped}")
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_meeting_transcriber.py -v
```

Expected: 5 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/perception/meeting/transcriber.py agent/tests/test_meeting_transcriber.py
git commit -m "feat(meeting): add meeting screen prompt and transcript accumulator"
```

---

### Task 3: Meeting summarizer

**Files:**
- Create: `agent/src/perception/meeting/summarizer.py`
- Create: `agent/tests/test_meeting_summarizer.py`

- [ ] **Step 1: Write failing tests**

```python
# agent/tests/test_meeting_summarizer.py
import pytest
from unittest.mock import AsyncMock, MagicMock
from agent.src.perception.meeting.summarizer import summarise, EMPTY_TRANSCRIPT_MESSAGE


async def test_summarise_calls_claude_with_transcript():
    client = MagicMock()
    client.messages.create = AsyncMock(return_value=MagicMock(
        content=[MagicMock(text="## Summary\n\nMeeting about roadmap.\n\n## Key Points\n\n- Point A\n")]
    ))
    result = await summarise(client, ["[1m] Hello", "[2m] Let's discuss roadmap"], "claude-sonnet-4-6")
    assert "Summary" in result or "roadmap" in result.lower()
    client.messages.create.assert_called_once()
    call_kwargs = client.messages.create.call_args.kwargs
    assert "[1m] Hello" in call_kwargs["messages"][0]["content"][0]["text"]


async def test_summarise_returns_empty_message_for_empty_transcript():
    client = MagicMock()
    result = await summarise(client, [], "claude-sonnet-4-6")
    assert result == EMPTY_TRANSCRIPT_MESSAGE
    client.messages.create.assert_not_called()


async def test_summarise_returns_empty_message_for_whitespace_only():
    client = MagicMock()
    result = await summarise(client, ["   ", ""], "claude-sonnet-4-6")
    assert result == EMPTY_TRANSCRIPT_MESSAGE


def test_empty_transcript_message_mentions_captions():
    assert "caption" in EMPTY_TRANSCRIPT_MESSAGE.lower() or "live" in EMPTY_TRANSCRIPT_MESSAGE.lower()
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_meeting_summarizer.py -v
```

Expected: `ImportError`

- [ ] **Step 3: Create `agent/src/perception/meeting/summarizer.py`**

```python
from __future__ import annotations
import anthropic

EMPTY_TRANSCRIPT_MESSAGE = (
    "I didn't capture enough content to generate notes — "
    "make sure Zoom live captions are enabled next time."
)

_SUMMARISE_PROMPT = """\
You are summarising a work meeting from raw screen-extracted notes.
Produce:

1. A 2–3 sentence summary of the meeting
2. Key points (bullet list, max 7)
3. Action items as a markdown checklist — include owner names if mentioned

Raw notes:
{transcript}

Format your response as markdown with these three sections only."""


async def summarise(
    client: anthropic.AsyncAnthropic,
    transcript: list[str],
    model: str,
) -> str:
    """Summarise a meeting transcript. Returns EMPTY_TRANSCRIPT_MESSAGE if nothing was captured."""
    meaningful = [line for line in transcript if line.strip()]
    if not meaningful:
        return EMPTY_TRANSCRIPT_MESSAGE
    raw_notes = "\n".join(meaningful)
    response = await client.messages.create(
        model=model,
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": [{"type": "text", "text": _SUMMARISE_PROMPT.format(transcript=raw_notes)}],
        }],
    )
    return response.content[0].text
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_meeting_summarizer.py -v
```

Expected: 4 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/perception/meeting/summarizer.py agent/tests/test_meeting_summarizer.py
git commit -m "feat(meeting): add Claude-based meeting summarizer"
```

---

### Task 4: Meeting notes writer

**Files:**
- Create: `agent/src/perception/meeting/writer.py`
- Create: `agent/tests/test_meeting_writer.py`

- [ ] **Step 1: Write failing tests**

```python
# agent/tests/test_meeting_writer.py
import time
from unittest.mock import AsyncMock, MagicMock, patch
from agent.src.perception.meeting.writer import save_meeting_notes


async def test_save_meeting_notes_calls_memory_save():
    client = MagicMock()
    start_time = 1749650400.0  # 2025-06-11 14:00 UTC
    summary = "## Summary\n\nGreat meeting."

    with patch("agent.src.perception.meeting.writer.memory_save", new_callable=AsyncMock) as mock_save:
        mock_save.return_value = "/episodes/meetings/..."
        result = await save_meeting_notes(client, "store-123", start_time, summary)

    mock_save.assert_called_once()
    call_args = mock_save.call_args
    # positional: client, store_id, path, content
    assert call_args.args[1] == "store-123"
    path = call_args.args[2]
    assert path.startswith("/episodes/meetings/")
    assert path.endswith(".md")
    content = call_args.args[3]
    assert "## Summary" in content
    assert "Great meeting." in content


async def test_save_meeting_notes_path_includes_timestamp():
    client = MagicMock()
    start_time = 1749650400.0

    with patch("agent.src.perception.meeting.writer.memory_save", new_callable=AsyncMock) as mock_save:
        mock_save.return_value = "/episodes/meetings/2025-06-11-14-00.md"
        await save_meeting_notes(client, "store-123", start_time, "Notes here.")

    path = mock_save.call_args.args[2]
    # Path must contain a date-like string
    import re
    assert re.search(r"\d{4}-\d{2}-\d{2}", path), f"No date in path: {path}"
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_meeting_writer.py -v
```

Expected: `ImportError`

- [ ] **Step 3: Create `agent/src/perception/meeting/writer.py`**

```python
from __future__ import annotations
from datetime import datetime
import anthropic

from agent.src.memory import memory_save  # existing helper from langgraph foundation


async def save_meeting_notes(
    client: anthropic.AsyncAnthropic,
    store_id: str,
    start_time: float,
    summary: str,
) -> str:
    """Save meeting summary to Anthropic Memory Store. Returns the saved path."""
    dt = datetime.fromtimestamp(start_time)
    slug = dt.strftime("%Y-%m-%d-%H-%M")
    header = f"# Meeting — {dt.strftime('%Y-%m-%d %H:%M')}"
    content = f"{header}\n\n{summary}"
    path = f"/episodes/meetings/{slug}.md"
    return await memory_save(client, store_id, path, content)
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_meeting_writer.py -v
```

Expected: 2 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add agent/src/perception/meeting/writer.py agent/tests/test_meeting_writer.py
git commit -m "feat(meeting): add meeting notes writer to Anthropic Memory Store"
```

---

### Task 5: Meeting loop in PerceptionService

**Files:**
- Modify: `agent/src/perception/service.py`
- Modify: `agent/tests/test_perception_service.py`

This is the state machine and the plumbing that wires all four meeting modules together.

- [ ] **Step 1: Write failing tests**

Add to `agent/tests/test_perception_service.py`:

```python
import time
from unittest.mock import AsyncMock, MagicMock, patch, call
from agent.src.perception.service import PerceptionService


async def test_meeting_loop_sets_in_meeting_when_zoom_starts():
    client = MagicMock()
    bus = MagicMock()
    bus.broadcast = MagicMock()

    zoom_calls = [True]  # Zoom running from first poll

    with patch("agent.src.perception.service.zoom_is_running", side_effect=zoom_calls * 10):
        with patch("agent.src.perception.service.CameraCapture") as mock_cam_cls:
            mock_cam_cls.return_value.open.return_value = False
            svc = PerceptionService(
                client,
                screen_interval=999,
                camera_interval=999,
                camera_enabled=False,
                meeting_poll_interval=0.05,
                meeting_min_duration=0,
                bus=bus,
                memory_store_id="store-123",
            )
            await svc.start()
            await asyncio.sleep(0.15)
            await svc.stop()

    assert svc.state.in_meeting is True


async def test_meeting_loop_fires_on_meeting_end():
    import asyncio
    client = MagicMock()
    bus = MagicMock()
    bus.broadcast = MagicMock()

    # Zoom: on → on → off
    poll_iter = iter([True, True, False, False, False])

    def zoom_side_effect():
        try:
            return next(poll_iter)
        except StopIteration:
            return False

    with patch("agent.src.perception.service.zoom_is_running", side_effect=zoom_side_effect):
        with patch("agent.src.perception.service.summarise", new_callable=AsyncMock) as mock_sum:
            mock_sum.return_value = "## Summary\n\nTest meeting."
            with patch("agent.src.perception.service.save_meeting_notes", new_callable=AsyncMock) as mock_save:
                mock_save.return_value = "/episodes/meetings/test.md"
                with patch("agent.src.perception.service.CameraCapture") as mock_cam_cls:
                    mock_cam_cls.return_value.open.return_value = False
                    svc = PerceptionService(
                        client,
                        screen_interval=999,
                        camera_interval=999,
                        camera_enabled=False,
                        meeting_poll_interval=0.05,
                        meeting_min_duration=0,
                        bus=bus,
                        memory_store_id="store-123",
                    )
                    await svc.start()
                    await asyncio.sleep(0.4)
                    await svc.stop()

    mock_sum.assert_called_once()
    mock_save.assert_called_once()
    bus.broadcast.assert_called()


async def test_meeting_loop_ignores_short_meetings():
    import asyncio
    client = MagicMock()
    bus = MagicMock()
    bus.broadcast = MagicMock()

    poll_iter = iter([True, False, False])

    def zoom_side_effect():
        try:
            return next(poll_iter)
        except StopIteration:
            return False

    with patch("agent.src.perception.service.zoom_is_running", side_effect=zoom_side_effect):
        with patch("agent.src.perception.service.summarise", new_callable=AsyncMock) as mock_sum:
            with patch("agent.src.perception.service.save_meeting_notes", new_callable=AsyncMock) as mock_save:
                with patch("agent.src.perception.service.CameraCapture") as mock_cam_cls:
                    mock_cam_cls.return_value.open.return_value = False
                    svc = PerceptionService(
                        client,
                        screen_interval=999,
                        camera_interval=999,
                        camera_enabled=False,
                        meeting_poll_interval=0.05,
                        meeting_min_duration=9999,  # very large → meeting too short
                        bus=bus,
                        memory_store_id="store-123",
                    )
                    await svc.start()
                    await asyncio.sleep(0.3)
                    await svc.stop()

    mock_sum.assert_not_called()
    mock_save.assert_not_called()
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd agent && uv run pytest tests/test_perception_service.py -k "meeting" -v
```

Expected: `TypeError: PerceptionService.__init__() got an unexpected keyword argument 'meeting_poll_interval'`

- [ ] **Step 3: Update `PerceptionService.__init__` in `agent/src/perception/service.py`**

Add the new parameters to `__init__`, import the meeting modules at the top, and add `_meeting_loop` + `_on_meeting_end`. The full updated `service.py`:

```python
from __future__ import annotations
import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING

import anthropic

from .camera import CameraCapture
from .screen import capture_screen_jpeg
from .state import PerceptionState
from .vision import analyse_screen, analyse_camera, SCREEN_PROMPT
from .meeting.detector import zoom_is_running
from .meeting.transcriber import MEETING_SCREEN_PROMPT, append_transcript_line
from .meeting.summarizer import summarise
from .meeting.writer import save_meeting_notes

log = logging.getLogger(__name__)

_MEETING_SCREEN_INTERVAL = 10.0  # faster interval during meetings


class PerceptionService:
    def __init__(
        self,
        anthropic_client: anthropic.AsyncAnthropic,
        screen_interval: float = 15.0,
        camera_interval: float = 8.0,
        vision_model: str = "claude-sonnet-4-6",
        screen_enabled: bool = True,
        camera_enabled: bool = True,
        meeting_poll_interval: float = 5.0,
        meeting_min_duration: float = 60.0,
        bus=None,
        memory_store_id: str = "",
    ) -> None:
        self.state = PerceptionState()
        self._client = anthropic_client
        self._screen_interval = screen_interval
        self._camera_interval = camera_interval
        self._vision_model = vision_model
        self._screen_enabled = screen_enabled
        self._camera_enabled = camera_enabled
        self._meeting_poll_interval = meeting_poll_interval
        self._meeting_min_duration = meeting_min_duration
        self._bus = bus
        self._memory_store_id = memory_store_id
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
        tasks.append(asyncio.create_task(self._meeting_loop()))
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
                interval = _MEETING_SCREEN_INTERVAL if self.state.in_meeting else self._screen_interval
                img = await loop.run_in_executor(self._executor, capture_screen_jpeg)
                if self.state.in_meeting:
                    raw = await analyse_screen(self._client, img, self._vision_model)
                    elapsed = (time.monotonic() - self.state.meeting_start_time) / 60.0
                    append_transcript_line(self.state.meeting_transcript, raw, elapsed)
                else:
                    desc = await analyse_screen(self._client, img, self._vision_model)
                    self.state.screen_description = desc
                    self.state.screen_updated_at = time.monotonic()
            except Exception as exc:
                log.warning("[perception] screen error: %s", exc)
                interval = self._screen_interval
            await asyncio.sleep(interval)

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

    async def _meeting_loop(self) -> None:
        while True:
            try:
                running = zoom_is_running()
                if running and not self.state.in_meeting:
                    self.state.in_meeting = True
                    self.state.meeting_start_time = time.monotonic()
                    self.state.meeting_transcript = []
                    log.info("[perception] meeting started")
                elif not running and self.state.in_meeting:
                    duration = time.monotonic() - self.state.meeting_start_time
                    self.state.in_meeting = False
                    if duration >= self._meeting_min_duration:
                        await self._on_meeting_end(self.state.meeting_start_time)
                    else:
                        log.info("[perception] meeting too short (%.0fs) — skipping notes", duration)
                    self.state.meeting_transcript = []
            except Exception as exc:
                log.warning("[perception] meeting loop error: %s", exc)
            await asyncio.sleep(self._meeting_poll_interval)

    async def _on_meeting_end(self, start_time: float) -> None:
        transcript = list(self.state.meeting_transcript)
        try:
            summary = await summarise(self._client, transcript, self._vision_model)
            if self._memory_store_id:
                await save_meeting_notes(self._client, self._memory_store_id, start_time, summary)
            recap = "Your Zoom call just ended. I've saved the summary and action items to memory."
            if not self._memory_store_id:
                recap = "Your Zoom call just ended. (Memory store not configured — notes not saved.)"
        except Exception as exc:
            log.error("[perception] meeting end handler failed: %s", exc)
            recap = "Your call ended. I tried to save notes but hit an error — check the logs."
        if self._bus:
            self._bus.broadcast({"type": "transcript", "role": "assistant", "text": recap})
```

- [ ] **Step 4: Run tests**

```bash
cd agent && uv run pytest tests/test_perception_service.py -v
```

Expected: all tests PASSED (including the 4 from the previous plan)

- [ ] **Step 5: Commit**

```bash
git add agent/src/perception/service.py agent/tests/test_perception_service.py
git commit -m "feat(meeting): add _meeting_loop + _on_meeting_end to PerceptionService"
```

---

### Task 6: Wire meeting params into server

**Files:**
- Modify: `agent/src/server.py`

- [ ] **Step 1: Update `PerceptionService` constructor call in lifespan**

In `agent/src/server.py`, find the `PerceptionService(...)` instantiation added in the vision-perception plan (Task 7, Step 1 of that plan) and extend it with the meeting params:

```python
        perception_service = PerceptionService(
            anthropic_client=providers.anthropic_client,
            screen_interval=float(os.getenv("PERCEPTION_SCREEN_INTERVAL_S", "15")),
            camera_interval=float(os.getenv("PERCEPTION_CAMERA_INTERVAL_S", "8")),
            vision_model=os.getenv("PERCEPTION_VISION_MODEL", "claude-sonnet-4-6"),
            screen_enabled=os.getenv("PERCEPTION_SCREEN_ENABLED", "true") != "false",
            camera_enabled=os.getenv("PERCEPTION_CAMERA_ENABLED", "true") != "false",
            meeting_poll_interval=float(os.getenv("PERCEPTION_MEETING_POLL_INTERVAL_S", "5")),
            meeting_min_duration=float(os.getenv("PERCEPTION_MEETING_MIN_DURATION_S", "60")),
            bus=bus,
            memory_store_id=os.getenv("MEMORY_STORE_ID", ""),
        )
```

- [ ] **Step 2: Add env vars to `.env.example`**

```bash
# Meeting intelligence
PERCEPTION_MEETING_POLL_INTERVAL_S=5
PERCEPTION_MEETING_MIN_DURATION_S=60
```

- [ ] **Step 3: Run full test suite**

```bash
cd agent && uv run pytest -v
```

Expected: all tests PASSED

- [ ] **Step 4: Smoke test**

```bash
npm run agent
# In another terminal:
curl -s http://localhost:8787/health
```

Expected: `{"status":"ok"}` with no errors in the log. With PERCEPTION_ENABLED=true, logs should show:
```
[perception] started (screen=True camera=True/False)
```

Open Zoom (or simulate: `PERCEPTION_MEETING_MIN_DURATION_S=0 npm run agent`, then `pgrep -x zoom.us` returns 0). Wait for meeting detection log: `[perception] meeting started`.

- [ ] **Step 5: Document Zoom live captions requirement**

Add to `AGENTS.md` (or `README.md` if AGENTS.md doesn't exist yet):

```markdown
## Meeting Intelligence

Jarvis captures meeting content from Zoom screen captions.

**Required:** Enable Zoom live captions (Zoom → Settings → Accessibility → "Enable live transcription"). Without captions, only shared screen content and chat are captured.

Meeting notes are saved to the Anthropic Memory Store at `/episodes/meetings/YYYY-MM-DD-HH-MM.md` and can be recalled: *"What did we decide in yesterday's meeting?"*
```

- [ ] **Step 6: Commit**

```bash
git add agent/src/server.py .env.example AGENTS.md
git commit -m "feat(meeting): wire meeting params + bus into PerceptionService in server lifespan"
```
