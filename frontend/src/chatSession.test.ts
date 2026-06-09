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
