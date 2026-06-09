// Subscribes to the proxy's /events SSE stream (the agent console feed).
// Works in web and desktop (both reach the proxy on localhost).

export type AgentEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; ts: number }
  | { type: 'tool_call'; name: string; input?: Record<string, unknown>; ts: number }
  | { type: 'tool_result'; name: string; isError?: boolean; ts: number }
  | { type: 'citation'; items: { url: string; title: string }[]; ts: number }
  | { type: 'media'; mediaType: 'image' | 'video' | 'link'; url: string; caption?: string; ts: number }

const PROXY_URL = (import.meta.env.VITE_PROXY_URL as string | undefined) || 'http://localhost:8787'

/** Open the console stream. Returns a disposer. */
export function openAgentEvents(
  onEvent: (e: AgentEvent) => void,
  onState?: (open: boolean) => void,
): () => void {
  const es = new EventSource(`${PROXY_URL}/events`)
  es.onopen = () => onState?.(true)
  es.onerror = () => onState?.(false)
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as AgentEvent)
    } catch {
      /* ignore keep-alive comments / malformed lines */
    }
  }
  return () => es.close()
}
