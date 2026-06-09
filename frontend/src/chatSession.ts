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
      // Read config lazily so test stubs of import.meta.env apply, and so
      // Vite doesn't statically inline the values at module-load time.
      const env = import.meta.env as Record<string, string | undefined>
      const proxyUrl = env.VITE_PROXY_URL ?? 'http://localhost:8787'
      const proxyApiKey = env.VITE_PROXY_API_KEY ?? ''

      controller?.abort()
      controller = new AbortController()

      history.push({ role: 'user', content: text })

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (proxyApiKey) headers['Authorization'] = `Bearer ${proxyApiKey}`

      const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
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
      if (history.length > 40) history.splice(0, history.length - 40)
      controller = null
      return assistantText
    },
  }
}
