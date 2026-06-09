# Jarvis Face — Remove Tavus, Add Animated Face + Local Voice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tavus CVI with an animated robotic face (NIO NOMI-inspired), Web SpeechSynthesis voice output, and macOS Vision eye tracking — keeping the Claude proxy and agent console intact.

**Architecture:** The Tauri webview renders a CSS-animated `JarvisFace` component (emotions, blinking, speaking ring). The user types messages; `ChatSession` streams them through the local proxy to Claude; `VoiceOutput` speaks the reply and drives the face emotion state. A Swift sidecar uses AVFoundation + Vision to detect face position and emits `face-position` Tauri events that move the eyeballs.

**Tech Stack:** React 19 + TypeScript, Tauri v2 (Rust), Web SpeechSynthesis API, Swift sidecar (AVFoundation + Vision), Vitest (frontend tests), `tauri-plugin-shell` (sidecar IPC).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/components/cvi/` | **Delete** | All Daily/WebRTC/Tavus UI |
| `frontend/server.mjs` | **Delete** | Tavus dev backend |
| `frontend/src-tauri/src/tavus.rs` | **Delete** | Tavus API client |
| `frontend/src-tauri/src/session.rs` | **Delete** | Tavus billing session |
| `frontend/src/api.ts` | **Delete** | Tavus conversation helpers |
| `lib/tavus.mjs` | **Delete** | Shared Tavus client |
| `scripts/setup-tavus.mjs` | **Delete** | Tavus CLI |
| `docs/tavus/` | **Delete** | Vendored Tavus docs |
| `frontend/src/voiceOutput.ts` | **Create** | Web SpeechSynthesis wrapper |
| `frontend/src/voiceOutput.test.ts` | **Create** | Vitest tests |
| `frontend/src/chatSession.ts` | **Create** | Proxy SSE streaming + history |
| `frontend/src/chatSession.test.ts` | **Create** | Vitest tests |
| `frontend/src/components/JarvisFace.tsx` | **Create** | Animated face component |
| `frontend/src/components/JarvisFace.css` | **Create** | Face styles + emotion states |
| `frontend/src-tauri/sidecar/jarvus-eye-tracker.swift` | **Create** | AVFoundation + Vision face detect |
| `scripts/build-sidecar.sh` | **Create** | Compile Swift → binary |
| `frontend/src-tauri/src/eye_tracker.rs` | **Create** | Spawn sidecar, emit events |
| `frontend/src/App.tsx` | **Rewrite** | New layout A, wired to all pieces |
| `frontend/src/App.css` | **Modify** | Add face panel + input styles |
| `frontend/src-tauri/src/lib.rs` | **Modify** | Remove Tavus, add eye tracker |
| `frontend/src-tauri/Cargo.toml` | **Modify** | Add tauri-plugin-shell + eye-tracking feature |
| `frontend/src-tauri/tauri.conf.json` | **Modify** | Add externalBin for sidecar |
| `frontend/package.json` | **Modify** | Remove @daily-co, add vitest |
| `.env.example` | **Modify** | Remove TAVUS_*, keep proxy vars |

---

## Task 1: Strip Tavus — delete files, remove deps, verify clean build

**Files:**
- Delete: `frontend/src/components/cvi/`
- Delete: `frontend/server.mjs`
- Delete: `frontend/src-tauri/src/tavus.rs`
- Delete: `frontend/src-tauri/src/session.rs`
- Delete: `frontend/src/api.ts`
- Delete: `lib/tavus.mjs`
- Delete: `scripts/setup-tavus.mjs`
- Delete: `docs/tavus/`
- Modify: `frontend/package.json`
- Modify: `frontend/src-tauri/src/lib.rs`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Delete Tavus source files**

```bash
rm -rf frontend/src/components/cvi
rm -f frontend/server.mjs
rm -f frontend/src-tauri/src/tavus.rs
rm -f frontend/src-tauri/src/session.rs
rm -f frontend/src/api.ts
rm -f lib/tavus.mjs
rm -f scripts/setup-tavus.mjs
rm -rf docs/tavus
```

- [ ] **Step 2: Remove Daily deps from package.json**

In `frontend/package.json`, remove these two lines from `"dependencies"`:
```json
"@daily-co/daily-js": "^0.90.0",
"@daily-co/daily-react": "^0.25.2",
```

- [ ] **Step 3: Rewrite lib.rs — remove Tavus, keep wake word + tray**

Replace the entire contents of `frontend/src-tauri/src/lib.rs`:

```rust
mod wake_word;

#[cfg(feature = "eye-tracking")]
mod eye_tracker;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let open = MenuItemBuilder::with_id("open", "Open Jarvus").build(app)?;
      let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
      let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;
      let _tray = TrayIconBuilder::with_id("jarvus-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
          "open" => {
            if let Some(window) = app.get_webview_window("main") {
              let _ = window.show();
              let _ = window.set_focus();
            }
          }
          "quit" => app.exit(0),
          _ => {}
        })
        .build(app)?;

      wake_word::spawn_wake_word_listener(app.handle().clone());

      #[cfg(feature = "eye-tracking")]
      eye_tracker::spawn_eye_tracker(app.handle().clone());

      Ok(())
    })
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        let _ = window.hide();
        api.prevent_close();
      }
    })
    .invoke_handler(tauri::generate_handler![])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
```

- [ ] **Step 4: Rewrite App.tsx — minimal placeholder so build passes**

Replace the entire contents of `frontend/src/App.tsx`:

```tsx
import './App.css'

function App() {
  return (
    <div className="callRoot">
      <div className="callMain" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#080808' }}>
        <p style={{ color: '#555', fontFamily: 'monospace' }}>Jarvis loading…</p>
      </div>
    </div>
  )
}

export default App
```

- [ ] **Step 5: Remove unused imports from App.css**

In `frontend/src/App.css`, delete the `.landing`, `.card`, `.card h1`, `.subtitle`, `.startButton`, `.error`, `.footnote` blocks (the landing page styles). Keep `.callRoot`, `.callMain`, `.testBadge`.

- [ ] **Step 6: Install deps and verify frontend builds**

```bash
cd frontend && npm install && npm run build 2>&1 | tail -20
```

Expected: build completes with no errors. Warnings about unused CSS variables are OK.

- [ ] **Step 7: Remove reqwest from Cargo.toml (no longer needed without Tavus HTTP calls)**

In `frontend/src-tauri/Cargo.toml`, remove:
```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
```

- [ ] **Step 8: Verify Rust builds**

```bash
cd frontend && PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^error|Finished"
```

Expected: `Finished 'dev' profile`

- [ ] **Step 9: Commit clean slate**

```bash
cd /path/to/Jarvis
git add -A
git commit -m "Remove Tavus CVI — strip Daily deps, tavus.rs, session.rs, cvi components"
```

---

## Task 2: VoiceOutput module (TDD)

**Files:**
- Create: `frontend/src/voiceOutput.ts`
- Create: `frontend/src/voiceOutput.test.ts`
- Modify: `frontend/package.json` (add vitest)

- [ ] **Step 1: Add vitest to frontend**

In `frontend/package.json`, add to `"devDependencies"`:
```json
"vitest": "^3.0.0"
```

Add to `"scripts"`:
```json
"test": "vitest run"
```

Run `cd frontend && npm install`.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/voiceOutput.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createVoiceOutput, stripEmotionTags } from './voiceOutput'

describe('stripEmotionTags', () => {
  it('removes <emotion value="x"/> tags', () => {
    expect(stripEmotionTags('<emotion value="happy"/> Hello there.')).toBe('Hello there.')
  })
  it('removes inline emotion tags mid-sentence', () => {
    expect(stripEmotionTags('Sure!<emotion value="excited"/> Let me check.')).toBe('Sure! Let me check.')
  })
  it('passes plain text unchanged', () => {
    expect(stripEmotionTags('Hello world')).toBe('Hello world')
  })
})

describe('createVoiceOutput', () => {
  let mockSpeechSynthesis: {
    cancel: ReturnType<typeof vi.fn>
    speak: ReturnType<typeof vi.fn>
    getVoices: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    mockSpeechSynthesis = {
      cancel: vi.fn(),
      speak: vi.fn(),
      getVoices: vi.fn().mockReturnValue([]),
    }
    vi.stubGlobal('speechSynthesis', mockSpeechSynthesis)
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      voice: unknown = null
      onstart: (() => void) | null = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(public text: string) {}
    })
  })

  it('calls speechSynthesis.speak with cleaned text', () => {
    const vo = createVoiceOutput()
    vo.speak('<emotion value="happy"/> Hello!', () => {}, () => {})
    expect(mockSpeechSynthesis.speak).toHaveBeenCalledOnce()
    const utt = mockSpeechSynthesis.speak.mock.calls[0][0]
    expect(utt.text).toBe('Hello!')
  })

  it('calls onEnd when utterance ends', () => {
    const vo = createVoiceOutput()
    const onEnd = vi.fn()
    vo.speak('Hello', () => {}, onEnd)
    const utt = mockSpeechSynthesis.speak.mock.calls[0][0]
    utt.onend()
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('skips speaking empty text and calls onEnd immediately', () => {
    const vo = createVoiceOutput()
    const onEnd = vi.fn()
    vo.speak('<emotion value="x"/>', () => {}, onEnd)
    expect(mockSpeechSynthesis.speak).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('cancel calls speechSynthesis.cancel', () => {
    const vo = createVoiceOutput()
    vo.cancel()
    expect(mockSpeechSynthesis.cancel).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 3: Run — verify tests fail**

```bash
cd frontend && npm test -- voiceOutput 2>&1 | tail -20
```

Expected: fails with `Cannot find module './voiceOutput'`

- [ ] **Step 4: Implement voiceOutput.ts**

Create `frontend/src/voiceOutput.ts`:

```typescript
export function stripEmotionTags(text: string): string {
  return text
    .replace(/<emotion\b[^>]*\/?>/gi, ' ')
    .replace(/<\/emotion>/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export interface VoiceOutput {
  speak(text: string, onStart: () => void, onEnd: () => void): void
  cancel(): void
}

export function createVoiceOutput(): VoiceOutput {
  return {
    speak(text, onStart, onEnd) {
      window.speechSynthesis.cancel()
      const clean = stripEmotionTags(text)
      if (!clean) { onEnd(); return }

      const utt = new SpeechSynthesisUtterance(clean)
      const voices = window.speechSynthesis.getVoices()
      const en = voices.find(v => v.lang.startsWith('en'))
      if (en) utt.voice = en

      utt.onstart = onStart
      utt.onend = () => onEnd()
      utt.onerror = () => onEnd()
      window.speechSynthesis.speak(utt)
    },
    cancel() {
      window.speechSynthesis.cancel()
    },
  }
}
```

- [ ] **Step 5: Run — verify tests pass**

```bash
cd frontend && npm test -- voiceOutput 2>&1 | tail -10
```

Expected: all 7 tests pass, 0 failures.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/voiceOutput.ts src/voiceOutput.test.ts package.json package-lock.json
git commit -m "Add VoiceOutput — Web SpeechSynthesis wrapper with emotion tag stripping"
```

---

## Task 3: ChatSession module (TDD)

**Files:**
- Create: `frontend/src/chatSession.ts`
- Create: `frontend/src/chatSession.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/chatSession.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createChatSession } from './chatSession'

const PROXY = 'http://localhost:8787'

function makeStream(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(ctrl) {
      for (const chunk of chunks) ctrl.enqueue(encoder.encode(chunk))
      ctrl.close()
    },
  })
  return new Response(stream, { status: 200 })
}

function sseChunks(texts: string[]): string[] {
  return texts.map(t =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`
  ).concat(['data: [DONE]\n\n'])
}

describe('createChatSession', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('import.meta', { env: { VITE_PROXY_URL: PROXY, VITE_PROXY_API_KEY: 'test-key' } })
  })
  afterEach(() => vi.restoreAllMocks())

  it('sends user message to proxy and returns assistant text', async () => {
    vi.mocked(fetch).mockResolvedValue(makeStream(sseChunks(['Hello', ' world'])))
    const session = createChatSession()
    const result = await session.send('hi')
    expect(result).toBe('Hello world')
  })

  it('adds Bearer token to Authorization header', async () => {
    vi.mocked(fetch).mockResolvedValue(makeStream(sseChunks(['ok'])))
    const session = createChatSession()
    await session.send('test')
    const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key')
  })

  it('accumulates conversation history across turns', async () => {
    vi.mocked(fetch).mockResolvedValue(makeStream(sseChunks(['reply'])))
    const session = createChatSession()
    await session.send('first')
    expect(session.history).toHaveLength(2) // user + assistant
    expect(session.history[0]).toEqual({ role: 'user', content: 'first' })
    expect(session.history[1]).toEqual({ role: 'assistant', content: 'reply' })
  })

  it('trims history to 40 messages', async () => {
    vi.mocked(fetch).mockResolvedValue(makeStream(sseChunks(['r'])))
    const session = createChatSession()
    for (let i = 0; i < 25; i++) {
      vi.mocked(fetch).mockResolvedValue(makeStream(sseChunks(['r'])))
      await session.send(`msg${i}`)
    }
    expect(session.history.length).toBeLessThanOrEqual(40)
  })
})
```

- [ ] **Step 2: Run — verify tests fail**

```bash
cd frontend && npm test -- chatSession 2>&1 | tail -10
```

Expected: fails with `Cannot find module './chatSession'`

- [ ] **Step 3: Implement chatSession.ts**

Create `frontend/src/chatSession.ts`:

```typescript
const PROXY_URL = (import.meta.env.VITE_PROXY_URL as string | undefined) ?? 'http://localhost:8787'
const PROXY_API_KEY = (import.meta.env.VITE_PROXY_API_KEY as string | undefined) ?? ''

export interface Message { role: 'user' | 'assistant'; content: string }

export interface ChatSession {
  send(text: string): Promise<string>
  abort(): void
  history: Message[]
}

export function createChatSession(): ChatSession {
  const history: Message[] = []
  let controller: AbortController | null = null

  return {
    history,

    abort() {
      controller?.abort()
      controller = null
    },

    async send(text) {
      controller?.abort()
      controller = new AbortController()

      history.push({ role: 'user', content: text })
      if (history.length > 40) history.splice(0, history.length - 40)

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (PROXY_API_KEY) headers['Authorization'] = `Bearer ${PROXY_API_KEY}`

      const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({ model: 'claude-sonnet-4-6', stream: true, messages: history }),
      })

      if (!res.ok) throw new Error(`Proxy ${res.status}`)
      if (!res.body) throw new Error('No body')

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let assistantText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of dec.decode(value).split('\n')) {
          const data = line.replace(/^data:\s*/, '').trim()
          if (!data || data === '[DONE]') continue
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta?.content
            if (delta) assistantText += delta
          } catch { /* ignore */ }
        }
      }

      history.push({ role: 'assistant', content: assistantText })
      controller = null
      return assistantText
    },
  }
}
```

- [ ] **Step 4: Run — verify tests pass**

```bash
cd frontend && npm test -- chatSession 2>&1 | tail -10
```

Expected: all 4 tests pass.

- [ ] **Step 5: Run full test suite**

```bash
cd frontend && npm test 2>&1 | grep -E "Tests|passed|failed"
```

Expected: all tests pass (voiceOutput + chatSession combined).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/chatSession.ts frontend/src/chatSession.test.ts
git commit -m "Add ChatSession — streaming proxy client with rolling conversation history"
```

---

## Task 4: JarvisFace component

**Files:**
- Create: `frontend/src/components/JarvisFace.tsx`
- Create: `frontend/src/components/JarvisFace.css`

- [ ] **Step 1: Create JarvisFace.css**

Create `frontend/src/components/JarvisFace.css`:

```css
/* ── Outer rings (speaking only) ── */
.jf-shell { position: relative; display: flex; align-items: center; justify-content: center; width: 260px; height: 260px; }

.jf-ring-outer, .jf-ring-outer-2 {
  position: absolute; border-radius: 50%; pointer-events: none;
  opacity: 0; transition: opacity 0.5s ease;
}
.jf-ring-outer  { width: 268px; height: 268px; }
.jf-ring-outer-2{ width: 282px; height: 282px; }

.jf-shell.speaking .jf-ring-outer {
  opacity: 1;
  background: conic-gradient(from 0deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.55) 18%, rgba(255,255,255,0) 36%, rgba(255,255,255,0) 54%, rgba(255,255,255,0.3) 72%, rgba(255,255,255,0) 90%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #fff calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #fff calc(100% - 2px));
  animation: jf-spin 1.8s linear infinite;
}
.jf-shell.speaking .jf-ring-outer-2 {
  opacity: 1;
  background: conic-gradient(from 180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.2) 25%, rgba(255,255,255,0) 50%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #fff calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #fff calc(100% - 2px));
  animation: jf-spin 3s linear infinite reverse;
}
@keyframes jf-spin { to { transform: rotate(360deg); } }

/* ── Face shell ── */
.jf-face {
  width: 240px; height: 240px; border-radius: 50%;
  background: radial-gradient(circle at 38% 30%, #202020 0%, #111111 45%, #060606 100%);
  border: 1.5px solid #1e1e1e;
  box-shadow: 0 0 0 1px rgba(255,255,255,0.03), inset 0 0 60px rgba(0,0,0,0.9);
  position: relative; overflow: hidden;
  transition: border-color 0.4s;
  z-index: 1;
}
.jf-face::before {
  content: '';
  position: absolute; top: 18px; left: 36px; width: 64px; height: 32px;
  background: radial-gradient(ellipse, rgba(255,255,255,0.05), transparent 70%);
  border-radius: 50%; transform: rotate(-25deg); pointer-events: none;
}
.jf-shell.speaking .jf-face  { border-color: #2a2a2a; }
.jf-shell.happy    .jf-face  { border-color: #2c2c2c; }
.jf-shell.surprised .jf-face { border-color: #333; }

/* ── Eyes ── */
.jf-eyes {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -58%);
  display: flex; gap: 44px; align-items: center;
}
.jf-eye-track { width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; position: relative; }
.jf-pupil {
  width: 34px; height: 34px; border-radius: 50%;
  background: radial-gradient(circle at 50% 50%, #0a0a0a 0%, #1c1c1c 28%, #2e2e2e 46%, #3a3a3a 60%, #111111 74%, #d0d0d0 76%, #aaaaaa 88%, #666666 100%);
  box-shadow: 0 2px 14px rgba(0,0,0,0.9), 0 0 0 1px rgba(0,0,0,0.6);
  will-change: transform;
  transition: width 0.25s ease, height 0.25s ease, transform 0.1s ease;
  position: relative;
}
.jf-pupil::before {
  content: ''; position: absolute; top: 5px; left: 8px; width: 9px; height: 7px;
  background: radial-gradient(ellipse, rgba(255,255,255,0.88), transparent 70%);
  border-radius: 50%; pointer-events: none;
}
.jf-pupil::after {
  content: ''; position: absolute; bottom: 6px; right: 7px; width: 5px; height: 4px;
  background: radial-gradient(ellipse, rgba(255,255,255,0.22), transparent 70%);
  border-radius: 50%; pointer-events: none;
}
.jf-eyelid {
  position: absolute; inset: 0; border-radius: 50%; background: #0c0c0c;
  clip-path: inset(0 0 100% 0); transition: clip-path 0.13s ease; z-index: 2; pointer-events: none;
}
.jf-eye-track.blink .jf-eyelid { clip-path: inset(0 0 0% 0); }

/* emotion pupil shapes */
.jf-shell.thinking  .jf-pupil { width: 24px; height: 24px; }
.jf-shell.surprised .jf-pupil { width: 38px; height: 38px; }
.jf-shell.happy     .jf-pupil { width: 32px; height: 38px; border-radius: 50% 50% 50% 50% / 38% 38% 62% 62%; }

/* ── Mouth ── */
.jf-mouth {
  position: absolute; top: 61%; left: 50%; transform: translateX(-50%);
  width: 90px; height: 34px; display: flex; align-items: center; justify-content: center;
}
.jf-mouth-line {
  width: 46px; height: 2px; border-radius: 1px;
  background: linear-gradient(90deg, transparent, #3a3a3a 20%, #555 50%, #3a3a3a 80%, transparent);
  transition: opacity 0.3s;
}
.jf-wave-bars {
  display: flex; align-items: center; gap: 3px; height: 34px;
  opacity: 0; transition: opacity 0.3s; position: absolute;
}
.jf-shell.speaking .jf-wave-bars { opacity: 1; }
.jf-shell.speaking .jf-mouth-line { opacity: 0; }
.jf-wave-bar { width: 4px; border-radius: 2px; background: linear-gradient(180deg, #aaa, #555); animation: jf-wave 0.85s ease-in-out infinite; }
.jf-wave-bar:nth-child(1){ height:6px;  animation-delay:0.00s; }
.jf-wave-bar:nth-child(2){ height:14px; animation-delay:0.10s; }
.jf-wave-bar:nth-child(3){ height:22px; animation-delay:0.20s; }
.jf-wave-bar:nth-child(4){ height:30px; animation-delay:0.15s; }
.jf-wave-bar:nth-child(5){ height:22px; animation-delay:0.25s; }
.jf-wave-bar:nth-child(6){ height:14px; animation-delay:0.10s; }
.jf-wave-bar:nth-child(7){ height:6px;  animation-delay:0.00s; }
@keyframes jf-wave { 0%,100% { transform: scaleY(0.3); opacity: 0.4; } 50% { transform: scaleY(1); opacity: 1; } }

.jf-mouth-smile {
  width: 52px; height: 22px;
  border: 2.5px solid transparent; border-bottom-color: #888;
  border-radius: 0 0 28px 28px;
  opacity: 0; transition: opacity 0.3s; position: absolute;
}
.jf-shell.happy .jf-mouth-smile { opacity: 1; }
.jf-shell.happy .jf-mouth-line  { opacity: 0; }

.jf-mouth-dots { display: flex; gap: 8px; opacity: 0; transition: opacity 0.3s; position: absolute; }
.jf-shell.thinking .jf-mouth-dots { opacity: 1; }
.jf-shell.thinking .jf-mouth-line { opacity: 0; }
.jf-tdot { width: 6px; height: 6px; border-radius: 50%; background: #666; animation: jf-tdot 1.1s ease-in-out infinite; }
.jf-tdot:nth-child(2){ animation-delay: 0.18s; }
.jf-tdot:nth-child(3){ animation-delay: 0.36s; }
@keyframes jf-tdot { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }

.jf-mouth-o {
  width: 22px; height: 24px; border-radius: 50%;
  border: 2.5px solid #777;
  opacity: 0; transition: opacity 0.3s; position: absolute;
}
.jf-shell.surprised .jf-mouth-o   { opacity: 1; }
.jf-shell.surprised .jf-mouth-line { opacity: 0; }

/* ── Status label ── */
.jf-status {
  font-size: 0.62rem; letter-spacing: 0.14em; text-transform: uppercase;
  color: #2a2a2a; position: absolute; bottom: 20px; left: 50%;
  transform: translateX(-50%); white-space: nowrap; font-weight: 600; transition: color 0.4s;
}
.jf-shell.speaking  .jf-status { color: #444; }
.jf-shell.happy     .jf-status { color: #3a3a3a; }
.jf-shell.surprised .jf-status { color: #555; }
```

- [ ] **Step 2: Create JarvisFace.tsx**

Create `frontend/src/components/JarvisFace.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import './JarvisFace.css'

export type Emotion = 'idle' | 'speaking' | 'thinking' | 'happy' | 'surprised'

interface Props {
  emotion: Emotion
  eyePosition: { x: number; y: number } | null
}

const MAX_EYE_TRAVEL = 7 // px

export function JarvisFace({ emotion, eyePosition }: Props) {
  const pupilLRef = useRef<HTMLDivElement>(null)
  const pupilRRef = useRef<HTMLDivElement>(null)
  const eyeLRef = useRef<HTMLDivElement>(null)
  const eyeRRef = useRef<HTMLDivElement>(null)
  const [blinking, setBlinking] = useState(false)

  // Scheduled random blink
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>
    function schedBlink() {
      timeoutId = setTimeout(() => {
        setBlinking(true)
        setTimeout(() => {
          setBlinking(false)
          schedBlink()
        }, 140)
      }, 2600 + Math.random() * 3400)
    }
    schedBlink()
    return () => clearTimeout(timeoutId)
  }, [])

  // Eye position → pupil translation
  useEffect(() => {
    const x = eyePosition ? (eyePosition.x - 0.5) * 2 * MAX_EYE_TRAVEL : 0
    const y = eyePosition ? (eyePosition.y - 0.5) * 2 * MAX_EYE_TRAVEL : 0
    for (const ref of [pupilLRef, pupilRRef]) {
      if (ref.current) {
        ref.current.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
      }
    }
  }, [eyePosition])

  const eyeClass = `jf-eye-track${blinking ? ' blink' : ''}`

  return (
    <div className={`jf-shell ${emotion}`}>
      <div className="jf-ring-outer" />
      <div className="jf-ring-outer-2" />
      <div className="jf-face">
        <div className="jf-eyes">
          <div className={eyeClass} ref={eyeLRef}>
            <div className="jf-pupil" ref={pupilLRef} />
            <div className="jf-eyelid" />
          </div>
          <div className={eyeClass} ref={eyeRRef}>
            <div className="jf-pupil" ref={pupilRRef} />
            <div className="jf-eyelid" />
          </div>
        </div>

        <div className="jf-mouth">
          <div className="jf-mouth-line" />
          <div className="jf-wave-bars">
            {[0, 1, 2, 3, 4, 5, 6].map(i => <div key={i} className="jf-wave-bar" />)}
          </div>
          <div className="jf-mouth-smile" />
          <div className="jf-mouth-dots">
            <div className="jf-tdot" /><div className="jf-tdot" /><div className="jf-tdot" />
          </div>
          <div className="jf-mouth-o" />
        </div>

        <div className="jf-status">{emotion.toUpperCase()}</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Smoke-test by mounting the face in App.tsx**

Replace the placeholder content in `frontend/src/App.tsx` with:

```tsx
import { useState } from 'react'
import { JarvisFace, type Emotion } from './components/JarvisFace'
import './App.css'

const EMOTIONS: Emotion[] = ['idle', 'speaking', 'thinking', 'happy', 'surprised']

function App() {
  const [emotion, setEmotion] = useState<Emotion>('idle')
  return (
    <div style={{ background: '#080808', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
      <JarvisFace emotion={emotion} eyePosition={{ x: 0.5, y: 0.5 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        {EMOTIONS.map(e => (
          <button key={e} onClick={() => setEmotion(e)}
            style={{ padding: '6px 14px', borderRadius: 999, border: '1px solid #333', background: emotion === e ? '#222' : '#111', color: '#ccc', cursor: 'pointer' }}>
            {e}
          </button>
        ))}
      </div>
    </div>
  )
}

export default App
```

- [ ] **Step 4: Launch and verify face renders**

```bash
cd frontend && set -a && . ../.env && set +a && PATH="$HOME/.cargo/bin:$PATH" npm run tauri:dev > /tmp/jarvus-dev.log 2>&1 &
```

Open the window — you should see the animated face, blink every few seconds, and emotion buttons that switch states. The speaking state should show the spinning rings + waveform. Move mouse (eye position is fixed at 0.5,0.5 for now — that's fine).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/JarvisFace.tsx frontend/src/components/JarvisFace.css
git commit -m "Add JarvisFace component — animated B&W face with emotions and eye tracking props"
```

---

## Task 5: Rewrite App.tsx — full layout A wired

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.css`

- [ ] **Step 1: Add face panel styles to App.css**

Append to `frontend/src/App.css`:

```css
/* ── JarvisFace panel (left of console) ── */
.jf-panel {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  background: #080808;
}

.jf-bottom-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 72%;
  max-width: 520px;
}

.jf-cam-preview {
  width: 112px;
  height: 84px;
  object-fit: cover;
  border-radius: 8px;
  opacity: 0.7;
  flex-shrink: 0;
  background: #111;
}

.jf-text-input {
  flex: 1;
  height: 40px;
  border-radius: 10px;
  border: 1px solid #1e1e1e;
  background: #0e0e0e;
  color: #e6e8ee;
  padding: 0 14px;
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.2s;
}

.jf-text-input:focus  { border-color: #2e2e2e; }
.jf-text-input:disabled { opacity: 0.45; cursor: not-allowed; }
```

- [ ] **Step 2: Rewrite App.tsx**

Replace the entire contents of `frontend/src/App.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { JarvisFace, type Emotion } from './components/JarvisFace'
import { AgentConsole } from './AgentConsole'
import { createVoiceOutput } from './voiceOutput'
import { createChatSession } from './chatSession'
import { openAgentEvents } from './agentEvents'
import './App.css'

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function tauriListen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(event, e => cb(e.payload))
}

export default function App() {
  const [emotion, setEmotion] = useState<Emotion>('idle')
  const [eyePos, setEyePos] = useState<{ x: number; y: number } | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const voiceOutput = useMemo(() => createVoiceOutput(), [])
  const chatSession = useMemo(() => createChatSession(), [])

  // Camera preview (display only — eye tracker opens its own AVCapture session)
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: false })
      .then(stream => { if (videoRef.current) videoRef.current.srcObject = stream })
      .catch(() => { /* permission denied — hide silently */ })
  }, [])

  // Wake word → focus input
  useEffect(() => {
    let dispose: (() => void) | undefined
    tauriListen<void>('wake-word', () => inputRef.current?.focus()).then(fn => { dispose = fn })
    return () => dispose?.()
  }, [])

  // Eye tracker → move face eyeballs
  useEffect(() => {
    let dispose: (() => void) | undefined
    tauriListen<{ x: number | null; y: number | null }>('face-position', pos => {
      setEyePos(pos.x != null && pos.y != null ? { x: pos.x, y: pos.y } : null)
    }).then(fn => { dispose = fn })
    return () => dispose?.()
  }, [])

  // AgentConsole tool events → thinking emotion
  useEffect(() => {
    return openAgentEvents(e => {
      if (e.type === 'tool_call')   setEmotion('thinking')
      if (e.type === 'tool_result') setEmotion(prev => prev === 'thinking' ? 'idle' : prev)
    })
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setEmotion('thinking')
    voiceOutput.cancel()
    try {
      const reply = await chatSession.send(text)
      setEmotion('speaking')
      voiceOutput.speak(
        reply,
        () => setEmotion('speaking'),
        () => { setEmotion('idle'); setBusy(false) },
      )
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setEmotion('idle')
        setBusy(false)
      }
    }
  }, [input, busy, chatSession, voiceOutput])

  return (
    <div className="callRoot">
      <div className="callMain">
        <div className="jf-panel">
          <JarvisFace emotion={emotion} eyePosition={eyePos} />
          <div className="jf-bottom-bar">
            <video ref={videoRef} autoPlay muted playsInline className="jf-cam-preview" />
            <input
              ref={inputRef}
              className="jf-text-input"
              type="text"
              placeholder="Message Jarvis…"
              value={input}
              disabled={busy}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void send() }}
            />
          </div>
        </div>
      </div>
      <AgentConsole />
    </div>
  )
}
```

- [ ] **Step 3: Build and verify**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: TypeScript compilation passes with no errors.

- [ ] **Step 4: Run and manually test the full flow**

```bash
cd frontend && set -a && . ../.env && set +a && PATH="$HOME/.cargo/bin:$PATH" npm run tauri:dev:wake > /tmp/jarvus-dev.log 2>&1 &
```

Verify:
- Face renders centred in the left panel, agent console on the right
- Camera preview appears bottom-left of face panel
- Typing a message and pressing Enter sends it (proxy must be running: `cd proxy && npm start`)
- Face switches to `thinking` while waiting, then `speaking` while voice plays, then `idle`
- AgentConsole shows transcript and tool events

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/App.css
git commit -m "Rewrite App.tsx — layout A with JarvisFace, ChatSession, VoiceOutput wired"
```

---

## Task 6: Eye tracker Swift sidecar

**Files:**
- Create: `frontend/src-tauri/sidecar/jarvus-eye-tracker.swift`
- Create: `scripts/build-sidecar.sh`
- Create: `frontend/src-tauri/src/eye_tracker.rs`
- Modify: `frontend/src-tauri/Cargo.toml`
- Modify: `frontend/src-tauri/tauri.conf.json`
- Modify: `frontend/src-tauri/src/lib.rs` (already has the `#[cfg]` stub from Task 1)
- Modify: `frontend/package.json`

- [ ] **Step 1: Write the Swift sidecar source**

Create `frontend/src-tauri/sidecar/jarvus-eye-tracker.swift`:

```swift
import AVFoundation
import Vision
import Foundation

// Coarse face-position detector: opens the default camera, runs
// VNDetectFaceRectanglesRequest at ~10 fps, and prints JSON lines to stdout:
//   {"x":0.52,"y":0.41}  — normalised face-centre (0-1, origin top-left)
//   {"x":null,"y":null}  — no face detected
// Tauri reads stdout and emits "face-position" events to the webview.

class EyeTracker: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private var frameCount = 0
    private let out = FileHandle.standardOutput

    func start() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            fputs("[eye-tracker] no camera\n", stderr); return
        }
        guard let input = try? AVCaptureDeviceInput(device: device) else {
            fputs("[eye-tracker] camera input failed\n", stderr); return
        }
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.setSampleBufferDelegate(self, queue: DispatchQueue(label: "jarvus.eye"))
        session.sessionPreset = .vga640x480
        session.addInput(input)
        session.addOutput(output)
        session.startRunning()
        fputs("[eye-tracker] listening\n", stderr)
        RunLoop.main.run()
    }

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        frameCount += 1
        guard frameCount % 3 == 0 else { return }  // sample at ~10 fps

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        try? handler.perform([request])

        let line: String
        if let face = request.results?.first {
            let box = face.boundingBox
            // Vision origin is bottom-left; convert to top-left for consistency with CSS
            let x = Double(box.midX)
            let y = 1.0 - Double(box.midY)
            line = String(format: "{\"x\":%.3f,\"y\":%.3f}\n", x, y)
        } else {
            line = "{\"x\":null,\"y\":null}\n"
        }
        out.write(Data(line.utf8))
    }
}

EyeTracker().start()
```

- [ ] **Step 2: Write the build script**

Create `scripts/build-sidecar.sh` (make executable):

```bash
#!/usr/bin/env bash
set -euo pipefail
ARCH=$(uname -m)
TRIPLE="${ARCH/arm64/aarch64}-apple-darwin"
TRIPLE="${TRIPLE/x86_64/x86_64}"
DEST="frontend/src-tauri/binaries/jarvus-eye-tracker-${TRIPLE}"
mkdir -p frontend/src-tauri/binaries
swiftc -O \
  frontend/src-tauri/sidecar/jarvus-eye-tracker.swift \
  -o "$DEST"
echo "Built $DEST"
```

```bash
chmod +x scripts/build-sidecar.sh
```

- [ ] **Step 3: Build the sidecar binary**

```bash
./scripts/build-sidecar.sh
```

Expected output: `Built frontend/src-tauri/binaries/jarvus-eye-tracker-aarch64-apple-darwin` (or x86_64 on Intel Mac).

- [ ] **Step 4: Smoke-test the sidecar binary directly**

```bash
TRIPLE=$(uname -m | sed 's/arm64/aarch64/')-apple-darwin
timeout 4 frontend/src-tauri/binaries/jarvus-eye-tracker-$TRIPLE 2>/dev/null | head -5
```

Expected: lines of `{"x":0.51,"y":0.38}` or `{"x":null,"y":null}` (depends on whether the camera sees your face).

- [ ] **Step 5: Configure the sidecar in tauri.conf.json**

In `frontend/src-tauri/tauri.conf.json`, inside `"bundle"`, add `"externalBin"`:

```json
"bundle": {
  "active": true,
  "targets": "all",
  "externalBin": ["binaries/jarvus-eye-tracker"],
  "resources": ["resources/*"],
  ...
}
```

- [ ] **Step 6: Add tauri-plugin-shell to Cargo.toml and add eye-tracking feature**

In `frontend/src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
tauri-plugin-shell = { version = "2", optional = true }
objc2-av-foundation = { version = "0.3.2", optional = true }
```

Update `[features]`:

```toml
wake-word   = ["dep:cpal", "dep:pv_porcupine"]
eye-tracking = ["dep:tauri-plugin-shell"]
```

- [ ] **Step 7: Create eye_tracker.rs**

Create `frontend/src-tauri/src/eye_tracker.rs`:

```rust
use serde::Deserialize;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

#[derive(Deserialize, serde::Serialize, Clone)]
pub struct FacePosition {
    pub x: Option<f32>,
    pub y: Option<f32>,
}

pub fn spawn_eye_tracker(app: tauri::AppHandle) {
    let shell = match app.shell() {
        s => s,
    };
    let sidecar = match shell.sidecar("jarvus-eye-tracker") {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[eye-tracker] sidecar not found: {e}");
            return;
        }
    };
    let (mut rx, _child) = match sidecar.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            log::warn!("[eye-tracker] spawn failed: {e}");
            return;
        }
    };
    log::info!("[eye-tracker] sidecar started");
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    if let Ok(pos) = serde_json::from_slice::<FacePosition>(&line) {
                        let _ = app.emit("face-position", pos);
                    }
                }
                CommandEvent::Stderr(line) => {
                    let _ = std::str::from_utf8(&line).map(|s| log::debug!("[eye-tracker] {s}"));
                }
                CommandEvent::Terminated(_) => {
                    log::info!("[eye-tracker] sidecar terminated");
                    break;
                }
                _ => {}
            }
        }
    });
}
```

- [ ] **Step 8: Register plugin in lib.rs setup**

In `frontend/src-tauri/src/lib.rs`, inside the `.setup(|app| {` block, add after the log plugin:

```rust
      #[cfg(feature = "eye-tracking")]
      app.handle().plugin(tauri_plugin_shell::init())?;
```

The file already has `eye_tracker::spawn_eye_tracker(app.handle().clone());` from Task 1 Step 3.

- [ ] **Step 9: Add npm scripts for full-feature build**

In `frontend/package.json` scripts, add:

```json
"tauri:dev:full": "tauri dev --features wake-word,eye-tracking",
"tauri:build:full": "tauri build --features wake-word,eye-tracking"
```

- [ ] **Step 10: Build with eye-tracking feature**

```bash
cd frontend && PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml --features wake-word,eye-tracking 2>&1 | grep -E "^error|Finished"
```

Expected: `Finished 'dev' profile`

- [ ] **Step 11: Launch and verify eye tracking**

Kill any running dev instance, then:

```bash
pkill -f "tauri dev" 2>/dev/null; pkill -f "target/debug/app" 2>/dev/null; sleep 2
cd frontend && set -a && . ../.env && set +a && PATH="$HOME/.cargo/bin:$PATH" npm run tauri:dev:full > /tmp/jarvus-dev.log 2>&1 &
```

After the window opens: move your face left → the eyeballs should drift left. Move right → drift right. Move out of frame → eyes return to centre.

Check the log: `grep "eye-tracker" /tmp/jarvus-dev.log | head`

Expected: `[eye-tracker] sidecar started`

- [ ] **Step 12: Commit**

```bash
git add \
  frontend/src-tauri/sidecar/jarvus-eye-tracker.swift \
  frontend/src-tauri/src/eye_tracker.rs \
  frontend/src-tauri/Cargo.toml \
  frontend/src-tauri/Cargo.lock \
  frontend/src-tauri/tauri.conf.json \
  frontend/src-tauri/src/lib.rs \
  frontend/package.json \
  frontend/package-lock.json \
  scripts/build-sidecar.sh
git commit -m "Add eye tracker — Swift AVFoundation+Vision sidecar, Rust spawn, face-position events"
```

---

## Task 7: Cleanup + commit remaining session work

**Files:**
- Modify: `.env.example`
- Modify: `AGENTS.md`

- [ ] **Step 1: Clean up .env.example — remove Tavus vars**

Replace the contents of `.env.example`:

```bash
# Anthropic
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6
ANTHROPIC_MAX_TOKENS=1024

# Proxy
PROXY_PORT=8787
PROXY_API_KEY=
PROXY_ALLOW_UNAUTHENTICATED=false
VITE_PROXY_URL=http://localhost:8787
VITE_PROXY_API_KEY=

# Agent capabilities
AGENT_ENABLE_WEB_SEARCH=true
WEB_SEARCH_MAX_USES=5
AGENT_ENABLE_COMMANDS=false
AGENT_MAX_TOOL_ITERATIONS=8
AGENT_WORKSPACE=./workspace

# Long-term memory (Anthropic managed memory)
AGENT_ENABLE_MEMORY=true
JARVIS_MEMORY_STORE_NAME=jarvis-memory
JARVIS_MEMORY_STORE_ID=

# Notion integration (optional)
NOTION_TOKEN=
NOTION_DATABASE_ID=

# Wake word (Picovoice — free key at https://console.picovoice.ai)
PICOVOICE_ACCESS_KEY=
```

- [ ] **Step 2: Add VITE_PROXY_API_KEY to root .env**

```bash
grep -q "VITE_PROXY_API_KEY" .env || echo "VITE_PROXY_API_KEY=$(grep '^PROXY_API_KEY=' .env | cut -d= -f2-)" >> .env
```

- [ ] **Step 3: Commit all uncommitted session work**

This commits the proxy fixes, wake-word vendor, conversation memory, heartbeat, and CSS changes from the earlier session — all the work that was sitting uncommitted:

```bash
git add -A
git status  # review what's included
git commit -m "$(cat <<'EOF'
Ship day-1 Jarvis improvements: proxy fixes + wake word + face foundation

- proxy: clean dialog transcripts (strip Tavus perception/emotion metadata)
- proxy: conversation memory — agent no longer forgets drafts on confirm step  
- proxy: heartbeat filler — no dead air during tool calls
- wake word: vendor pv_porcupine 3.0.0, enable 'wake-word' feature, fall back to built-in Jarvis keyword
- tauri.conf.json: center: true — window opens centred
- JarvisFace CSS: container fills callMain panel
- env: TAVUS_TEST_MODE=false (out of credits — set back if needed)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Push to origin**

```bash
git push origin main
```

---

## Running the finished app

```bash
# Terminal 1 — start the proxy
cd proxy && npm start

# Build the eye-tracker sidecar once (or after Swift changes)
./scripts/build-sidecar.sh

# Terminal 2 — launch the desktop app (full features)
cd frontend
set -a && . ../.env && set +a
PATH="$HOME/.cargo/bin:$PATH" npm run tauri:dev:full
```

Say **"Jarvis"** (Picovoice AccessKey required) or type in the input and press Enter. The face will switch to thinking → speaking → idle as Jarvis responds.

**Feature flags:**

| Command | Wake word | Eye tracking |
|---|---|---|
| `tauri:dev` | ✗ | ✗ |
| `tauri:dev:wake` | ✓ | ✗ |
| `tauri:dev:full` | ✓ | ✓ |
