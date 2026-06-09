// Conversation API that works in both environments:
//  - Desktop (Tauri): calls Rust commands via invoke() — TAVUS_API_KEY stays in Rust.
//  - Web: calls the dev backend (frontend/server.mjs) over /api/*.

export type ConversationInfo = {
  conversation_id: string
  conversation_url: string
  status?: string
  test_mode: boolean
}

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function createConversation(): Promise<ConversationInfo> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<ConversationInfo>('create_conversation')
  }
  const res = await fetch('/api/conversation', { method: 'POST' })
  if (!res.ok) throw new Error(`Backend returned ${res.status}: ${await res.text()}`)
  return (await res.json()) as ConversationInfo
}

export async function endConversation(conversationId: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('end_conversation', { conversationId })
    return
  }
  await fetch(`/api/conversation/${conversationId}/end`, { method: 'POST' })
}

// ── Desktop session sleep (Tauri only; no-ops on web) ─────────────────────────

/** Hand a freshly-created conversation to Rust so it can auto-sleep on inactivity. */
export async function startSession(
  conversationId: string,
  conversationUrl: string,
): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    await invoke('start_session', { conversationId, conversationUrl })
  } catch {
    /* ignore */
  }
}

/** Reset the inactivity timer (call on audio/speech activity). */
export async function resetIdleTimer(): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    await invoke('reset_idle_timer')
  } catch {
    /* ignore */
  }
}

/** Subscribe to the "Hey Jarvus" wake-word event. Returns a disposer. */
export async function onWakeWord(cb: () => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen('wake-word', () => cb())
}

/** Subscribe to the session-ended (idle sleep) event. Returns a disposer. */
export async function onSessionEnded(cb: () => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen('session-ended', () => cb())
}
