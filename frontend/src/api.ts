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
