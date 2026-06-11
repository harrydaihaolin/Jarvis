# Meeting Intelligence — Design Spec

**Date:** 2026-06-11
**Status:** Approved

## Goal

Detect when a Zoom meeting is active, accumulate a transcript by extracting Zoom live captions from the screen, and at meeting end generate a summary + action items saved to the Anthropic Memory Store. Jarvis speaks a brief recap when the meeting ends.

**Prerequisites:**
1. LangGraph foundation plan (`2026-06-11-langgraph-foundation.md`) must be complete.
2. Vision perception layer (`2026-06-11-vision-perception-design.md`) must be complete — meeting detection reuses the screen capture loop and `PerceptionState`.

---

## Architecture

```
PerceptionService._meeting_loop()   polls every 5s
    ├── zoom_is_running()            pgrep -x zoom.us
    ├── idle → active                sets state.in_meeting = True, records start time
    ├── while active:                _screen_loop uses meeting prompt → appends to state.meeting_transcript
    └── active → ended               fires MeetingEndHandler
                                         → summariser.summarise(transcript)
                                         → memory_save("/episodes/YYYY-MM-DD-HH-MM-meeting.md")
                                         → Jarvis speaks recap via TTS event
```

Meeting transcription reuses the existing `_screen_loop` in `PerceptionService`. When `state.in_meeting` is True, the screen loop switches to the meeting-specific vision prompt (more frequent — every 10s instead of 15s) and appends non-empty results to `state.meeting_transcript`.

---

## Module Layout

```
agent/src/perception/meeting/
  __init__.py
  detector.py       # zoom_is_running()
  transcriber.py    # MEETING_SCREEN_PROMPT constant + transcript accumulation helpers
  summarizer.py     # Claude call → summary + action items
  writer.py         # memory_save to Anthropic Memory Store
```

The meeting state machine and `_on_meeting_end()` handler live in `perception/service.py` — they are part of `PerceptionService._meeting_loop()`, not a separate class.

---

## Meeting Detection — `detector.py`

Zoom process detection via `pgrep`:

```python
import subprocess

def zoom_is_running() -> bool:
    return subprocess.run(
        ["pgrep", "-x", "zoom.us"],
        capture_output=True,
    ).returncode == 0
```

**State machine** (owned by `PerceptionService._meeting_loop`):

| Current state | Condition | Next state | Action |
|---|---|---|---|
| `idle` | Zoom detected | `active` | Set `state.in_meeting = True`, record `state.meeting_start_time` |
| `active` | Zoom still running | `active` | Screen loop accumulates transcript |
| `active` | Zoom gone | `ended` | Fire `MeetingEndHandler`, clear transcript |
| `ended` | — | `idle` | Reset |

Minimum meeting duration: 60 seconds. Shorter detections (Zoom opened/closed quickly) are ignored to avoid spurious notes.

---

## Transcription — `transcriber.py` + `service.py`

`transcriber.py` exports `MEETING_SCREEN_PROMPT` and `append_transcript_line()`. The switching logic lives in `PerceptionService._screen_loop()` in `service.py`: when `state.in_meeting` is True it uses `MEETING_SCREEN_PROMPT` at a 10s interval instead of the normal 15s screen prompt.

```
This screen shows a Zoom meeting. Extract any visible text from:
- Live captions or subtitles (include speaker name if shown)
- Shared screen content that appears to be meeting material (slides, docs)
- Zoom chat messages

Return only the extracted text, one item per line. If nothing meeting-relevant
is visible, return an empty string.
```

Each non-empty result is timestamped and appended to `state.meeting_transcript`:

```python
state.meeting_transcript.append(f"[{elapsed_minutes:.0f}m] {extracted_text}")
```

**Zoom live captions requirement:** Full participant dialogue requires Zoom live captions to be enabled (Zoom Settings → Accessibility → Enable live transcription). Without captions, Jarvis captures shared screen content and chat only. This limitation is documented in `AGENTS.md`.

---

## Summarisation — `summarizer.py`

Direct Claude call at meeting end. Uses the same `anthropic.AsyncAnthropic` client from `Providers`.

```python
SUMMARISE_PROMPT = """You are summarising a work meeting from raw screen-extracted notes.
Produce:

1. A 2–3 sentence summary of the meeting
2. Key points (bullet list, max 7)
3. Action items as a markdown checklist — include owner names if mentioned

Raw notes:
{transcript}

Format your response as markdown with these three sections only."""
```

If `state.meeting_transcript` is empty (captions were off, no visible content), summarisation is skipped. Jarvis still announces the meeting ended but says: *"I didn't capture enough content to generate notes — make sure Zoom live captions are enabled next time."*

---

## Memory Storage — `writer.py`

Saves the summary to the Anthropic Memory Store using the existing `memory_save()` from `memory.py`:

```python
async def save_meeting_notes(client, store_id: str, start_time: float, summary: str) -> str:
    dt = datetime.fromtimestamp(start_time).strftime("%Y-%m-%d-%H-%M")
    path = f"/episodes/meetings/{dt}.md"
    content = f"# Meeting — {datetime.fromtimestamp(start_time).strftime('%Y-%m-%d %H:%M')}\n\n{summary}"
    return await memory_save(client, store_id, path, content)
```

Memory path format: `/episodes/meetings/YYYY-MM-DD-HH-MM.md`

Jarvis can recall past meetings naturally: *"What did we decide in yesterday's meeting?"* → `memory_recall("meeting")` finds it.

---

## Jarvis Spoken Recap

After saving, the `MeetingEndHandler` broadcasts a TTS event directly to the SSE `/events` bus — the same mechanism used for all Jarvis speech:

```python
bus.broadcast({
    "type": "transcript",
    "role": "assistant",
    "text": "Your Zoom call just ended. I've saved the summary and action items to memory.",
})
```

If save fails: *"Your call ended. I tried to save notes but hit an error — check the logs."*

---

## Environment Variables

```
PERCEPTION_MEETING_POLL_INTERVAL_S=5    # how often to check for Zoom
PERCEPTION_MEETING_MIN_DURATION_S=60    # ignore meetings shorter than this
```

---

## What is NOT changing

- Notion — meeting notes go to Anthropic Memory Store, not Notion
- STT sidecar — meeting transcription uses screen capture, not the microphone STT
- LangGraph graph — meeting handling is entirely within PerceptionService, not in the graph
- Frontend — zero changes
