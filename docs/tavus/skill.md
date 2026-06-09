---
name: Tavus
description: Use when building real-time conversational video interfaces with AI replicas, creating personas for video conversations, training custom digital humans, or integrating video interactions into web and mobile applications. Tavus is for agents building AI agents that see, hear, and respond naturally in video conversations.
metadata:
    mintlify-proj: tavus
    version: "1.0"
---

# Tavus Skill

## Product Summary

Tavus is a platform for building real-time conversational video interfaces (CVI) with AI replicas. It combines three core components: **Personas** (AI behavior and configuration), **Replicas** (photorealistic digital humans), and **Conversations** (live WebRTC video sessions). The end-to-end pipeline includes perception (Raven), conversational flow (Sparrow), speech recognition (STT), language models (LLM), text-to-speech (TTS), and real-time avatar rendering (Phoenix). Access the API at `https://tavusapi.com/v2/` with authentication via `x-api-key` header. Key files: API reference at `/api-reference/`, persona configuration at `/sections/conversational-video-interface/persona/`, replica training at `/sections/replica/`. Primary docs: https://docs.tavus.io

## When to Use

Reach for this skill when:
- **Building conversational AI agents** that need to see and respond to users in real-time video (e.g., sales coaches, customer support, interviewers, health advisors)
- **Creating or training custom replicas** from video or images for branded AI avatars
- **Configuring persona behavior** including system prompts, objectives, guardrails, knowledge bases, and conversational flow
- **Embedding video conversations** in web apps, React applications, or mobile interfaces
- **Integrating with custom LLMs** or existing conversational AI pipelines (LiveKit, Pipecat)
- **Managing conversations at scale** with per-session customization, recording, language support, or participant limits
- **Troubleshooting latency, turn-taking, or replica quality** issues in live conversations

## Quick Reference

### API Authentication
```bash
curl --request POST \
  --url https://tavusapi.com/v2/conversations \
  --header 'x-api-key: <api_key>' \
  --header 'Content-Type: application/json'
```
Generate API keys in the Developer Portal at https://platform.tavus.io/api-keys. Never expose keys in client-side code.

### Core API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v2/personas` | POST | Create a persona (behavior, prompt, layers) |
| `/v2/personas/{id}` | GET, PATCH, DELETE | Manage personas |
| `/v2/replicas` | POST | Train a custom replica from video or image |
| `/v2/replicas/{id}` | GET, PATCH, DELETE | Manage replicas |
| `/v2/conversations` | POST | Create a live video session |
| `/v2/conversations/{id}` | GET, END, DELETE | Manage conversations |
| `/v2/documents` | POST | Upload knowledge base documents |
| `/v2/objectives` | POST | Create goal-oriented conversation workflows |
| `/v2/guardrails` | POST | Define conversational boundaries |

### Persona Configuration Layers (in order)
1. **Perception** (`raven-1`) — Visual and audio analysis of user
2. **Conversational Flow** (`sparrow-1`) — Turn-taking, interruption handling
3. **Speech Recognition** (STT) — Transcribe user speech
4. **Language Model** (LLM) — Generate responses (Tavus-hosted or custom)
5. **Text-to-Speech** (TTS) — Convert text to speech (Cartesia, ElevenLabs, Azure)
6. **Replica Rendering** (Phoenix) — Real-time avatar video

### Stock Resources (No Training Required)
- **Stock Replicas**: 100+ pre-trained avatars (e.g., `r90bbd427f71` = Anna)
- **Stock Personas**: Pre-configured personas for common use cases (e.g., `pcb7a34da5fe` = Sales Development Rep)
- List with: `GET /v2/replicas?replica_type=system` and `GET /v2/personas?persona_type=system`

### Replica Training Paths

| Path | Input | Quality | Speed | Best For |
|------|-------|---------|-------|----------|
| **Video** | 1-min video (30s talking + 30s listening) | Highest | Slower | Custom branded avatars |
| **Image** | Single headshot photo | Medium | Fast | Quick prototyping |
| **Stock** | Pre-trained avatars | Good | Instant | Testing, demos |

### Conversation Customization Options
- `conversational_context` — Per-session data (user name, profile, history)
- `custom_greeting` — Personalized opening line
- `document_ids` or `document_tags` — Knowledge base references
- `language` — 42+ languages supported
- `audio_only` — Disable video for phone-like calls
- `max_duration_minutes` — Call time limit
- `background_customization` — Green screen or custom background
- `closed_captions` — Enable subtitles
- `recording_s3_bucket` — Store recordings in your S3

### LLM Model Selection

| Model | Speed | Intelligence | Best For |
|-------|-------|--------------|----------|
| `tavus-gpt-oss` | ⚡⚡⚡ | 🧠 | Low-latency, snappy responses |
| `tavus-gemini-2.5-flash` | ⚡⚡ | 🧠🧠 | Balanced latency + reasoning |
| `tavus-claude-haiku-4.5` | ⚡⚡ | 🧠🧠 | Grounded, fewer hallucinations |
| `tavus-gemini-3-flash` | ⚡ | 🧠🧠🧠 | Highest intelligence, lower speed |
| Custom (OpenAI-compatible) | Varies | Varies | Your own LLM backend |

**Context limit**: Keep prompts under 5,000 tokens for optimal performance (max 32,000 supported).

## Decision Guidance

### When to Reuse Personas vs. Create Per-Session

| Scenario | Approach | Why |
|----------|----------|-----|
| **Same behavior, different user data** (e.g., one sales coach, many prospects) | Reuse persona + `conversational_context` | Low API overhead, centralized updates |
| **Different behavior per session** (e.g., different voice, objectives, or guardrails per demo) | Create persona per session, delete after | Full isolation, no cross-session contamination |
| **Combination** (e.g., different voice AND different user data) | Create persona per session + `conversational_context` | Maximum flexibility with per-session data |

### Pipeline Mode Selection

| Mode | Use Case | Tradeoff |
|------|----------|----------|
| **Full Pipeline** (default) | Real-time conversations with perception, turn-taking, rendering | Best latency and naturalness |
| **Echo Mode** | Send text/audio directly for playback, bypass STT/LLM | Lowest latency, no AI reasoning |
| **Custom LLM** | Integrate your own LLM backend | Adds latency, full control |
| **LiveKit Agent** | Use Tavus avatar in LiveKit Agents pipeline | Only rendering, not full CVI |

### Knowledge Base Retrieval Strategy

| Strategy | Speed | Quality | Use When |
|----------|-------|---------|----------|
| `speed` | Fastest | Lower | Real-time, latency-critical |
| `balanced` | Medium | Medium | Most conversations |
| `quality` (default) | Slower | Highest | Accuracy critical (support, legal) |

## Workflow

### 1. Create a Persona
Define the AI's behavior, voice, and conversational configuration:
```bash
curl --request POST \
  --url https://tavusapi.com/v2/personas \
  --header 'x-api-key: <api_key>' \
  --data '{
    "persona_name": "Sales Coach",
    "system_prompt": "You are an expert sales coach...",
    "pipeline_mode": "full",
    "default_replica_id": "r90bbd427f71",
    "layers": {
      "perception": {"perception_model": "raven-1"},
      "conversational_flow": {
        "turn_detection_model": "sparrow-1",
        "turn_taking_patience": "high"
      },
      "llm": {"model": "tavus-gpt-oss"},
      "tts": {"engine": "cartesia"}
    }
  }'
```
Save the returned `persona_id`.

### 2. (Optional) Train a Custom Replica
If using stock replicas, skip this. Otherwise, train from video or image:
```bash
curl --request POST \
  --url https://tavusapi.com/v2/replicas \
  --header 'x-api-key: <api_key>' \
  --data '{
    "replica_name": "My Avatar",
    "training_video_url": "https://your-bucket.s3.amazonaws.com/video.mp4"
  }'
```
Wait for processing (5-10 minutes). Check status with `GET /v2/replicas/{replica_id}`.

### 3. (Optional) Upload Knowledge Base Documents
If your persona needs to reference documents:
```bash
curl --request POST \
  --url https://tavusapi.com/v2/documents \
  --header 'x-api-key: <api_key>' \
  --data '{
    "document_name": "Product FAQ",
    "document_url": "https://your-bucket.s3.amazonaws.com/faq.pdf",
    "tags": ["sales"]
  }'
```
Wait for processing. Use returned `document_id` in conversation creation.

### 4. Create a Conversation
Start a live video session:
```bash
curl --request POST \
  --url https://tavusapi.com/v2/conversations \
  --header 'x-api-key: <api_key>' \
  --data '{
    "persona_id": "<persona_id>",
    "conversation_name": "Sales Call",
    "conversational_context": "User is a prospect interested in enterprise plans",
    "document_ids": ["<document_id>"]
  }'
```
Receive `conversation_url` (WebRTC room). Embed in iframe or pass to user.

### 5. Embed in Your App
For web apps, embed the returned URL in an iframe:
```html
<iframe 
  src="https://tavus.daily.co/c123456"
  allow="camera; microphone; fullscreen; display-capture; autoplay"
  style="width: 100%; height: 640px;"
/>
```
Or use the React component library (`@tavus/cvi-ui`) for Tavus-provided UI.

### 6. End the Conversation
When the user leaves or session completes:
```bash
curl --request POST \
  --url https://tavusapi.com/v2/conversations/<conversation_id>/end \
  --header 'x-api-key: <api_key>'
```
Stops billing and frees concurrency slots.

## Common Gotchas

- **API key exposure**: Never send `x-api-key` from browser code. Keep it server-side only. Use a backend route to create conversations.
- **Replica not joining**: Rare internal issue. Check https://status.tavus.io for system status. Retry conversation creation.
- **Poor replica quality**: Training video must be exactly 1 minute (30s talking + 30s listening). Lips must fully close during talking. Avoid AI-generated videos.
- **Replica responding to background noise**: Enable `voice_isolation: "near"` in the Conversational Flow layer to filter background audio.
- **Latency issues**: Use `tavus-gpt-oss` model for fastest responses. Enable `speculative_inference: true` (default) to start LLM processing before user finishes speaking.
- **Knowledge base not working**: Documents must be text-based (not scanned PDFs). Keep documents focused on single topics. Avoid large "all-in-one" manuals. Wait 5-10 minutes for processing before using in conversations.
- **Objectives not triggering**: Ensure system prompt does not conflict with objective instructions. Plan entire workflow upfront. Test with `test_mode: true` first.
- **Persona changes affecting live sessions**: When using Approach A (reuse personas), a PATCH to the persona affects all current conversations. Use Approach B (create per-session) if you need isolation.
- **File size limits**: Training videos and audio files must be under 750 MB. Use H.264 codec. Compress if needed.
- **Billing surprises**: Conversations start billing when created (replica joins room). Use `test_mode: true` for validation. Always call `/end` to stop billing.

## Verification Checklist

Before submitting work with Tavus:

- [ ] API key is stored server-side, never in client code or `.env` files committed to git
- [ ] Persona has a clear `system_prompt` aligned with the use case (no conflicting instructions)
- [ ] If using custom replica, training video is exactly 1 minute (30s talking + 30s listening) with clear consent statement
- [ ] If using knowledge base, documents are text-based, focused on single topics, and processing is complete (check status)
- [ ] Conversation creation includes `persona_id` or `replica_id` (or both); never neither
- [ ] For web apps, `conversation_url` is embedded in iframe with correct `allow` attributes (`camera`, `microphone`, `fullscreen`, `display-capture`, `autoplay`)
- [ ] Conversations are ended with `/end` endpoint when user leaves or session completes
- [ ] For production, test with `test_mode: true` first to validate flow without billing
- [ ] If using objectives, test branching logic and confirm all paths are covered
- [ ] If using custom LLM, verify endpoint is OpenAI-compatible and streamable (SSE)
- [ ] Latency is acceptable: measure utterance-to-utterance round-trip time; if slow, switch to faster LLM or enable `speculative_inference`

## Resources

- **Comprehensive page index**: https://docs.tavus.io/llms.txt (use for agent navigation)
- **Full bundled docs**: https://docs.tavus.io/llms-full.txt
- **OpenAPI specification**: https://docs.tavus.io/openapi.yaml

**Critical documentation pages**:
1. [What is CVI?](https://docs.tavus.io/sections/conversational-video-interface/overview-cvi) — Architecture, layers, and pipeline overview
2. [API Conversation Quickstart](https://docs.tavus.io/sections/conversational-video-interface/quickstart/cvi-quickstart) — Step-by-step API flow
3. [CVI App Quickstart](https://docs.tavus.io/sections/conversational-video-interface/quickstart/build-first-app) — Full web app example with backend and frontend

---

> For additional documentation and navigation, see: https://docs.tavus.io/llms.txt