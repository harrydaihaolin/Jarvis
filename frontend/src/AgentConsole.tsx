import { useEffect, useRef, useState } from 'react'
import { openAgentEvents, type AgentEvent } from './agentEvents'
import './AgentConsole.css'

type Item = AgentEvent & { id: number }

const TOOL_LABEL: Record<string, string> = {
  web_search: '🔎 Searching the web',
  read_file: '📖 Reading a file',
  list_dir: '📂 Listing files',
  search_files: '🔎 Searching files',
  write_file: '📝 Writing a file',
  edit_file: '✏️ Editing a file',
  run_command: '⌘ Running a command',
}

function toolText(e: Extract<AgentEvent, { type: 'tool_call' }>): string {
  const base = TOOL_LABEL[e.name] || `🔧 ${e.name}`
  const arg =
    (e.input?.query as string) ||
    (e.input?.path as string) ||
    (e.input?.command as string) ||
    ''
  return arg ? `${base}: ${String(arg).slice(0, 80)}` : base
}

export function AgentConsole() {
  const [items, setItems] = useState<Item[]>([])
  const [connected, setConnected] = useState(false)
  const idRef = useRef(0)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const dispose = openAgentEvents(
      (e) => setItems((prev) => [...prev, { ...e, id: idRef.current++ }].slice(-200)),
      setConnected,
    )
    return dispose
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [items])

  return (
    <aside className="console">
      <header className="consoleHeader">
        <span>Agent console</span>
        <span className={`dot ${connected ? 'on' : 'off'}`} title={connected ? 'connected' : 'disconnected'} />
      </header>

      <div className="consoleBody">
        {items.length === 0 && (
          <div className="consoleEmpty">
            Live transcript, tool activity, citations, and media will appear here as you talk.
          </div>
        )}

        {items.map((it) => {
          if (it.type === 'transcript') {
            return (
              <div key={it.id} className={`msg ${it.role}`}>
                <div className="msgRole">{it.role === 'user' ? 'You' : 'Agent'}</div>
                <div className="msgText">{it.text}</div>
              </div>
            )
          }
          if (it.type === 'tool_call') {
            return (
              <div key={it.id} className="activity">
                {toolText(it)}
              </div>
            )
          }
          if (it.type === 'tool_result') {
            return (
              <div key={it.id} className={`activityResult ${it.isError ? 'err' : ''}`}>
                {it.isError ? `⚠️ ${it.name} failed` : `✓ ${it.name} done`}
              </div>
            )
          }
          if (it.type === 'citation') {
            return (
              <div key={it.id} className="citations">
                {it.items.slice(0, 6).map((c, i) => (
                  <a key={i} href={c.url} target="_blank" rel="noreferrer" className="citation">
                    🔗 {c.title || c.url}
                  </a>
                ))}
              </div>
            )
          }
          if (it.type === 'media') {
            return (
              <figure key={it.id} className="media">
                {it.mediaType === 'image' && <img src={it.url} alt={it.caption || ''} loading="lazy" />}
                {it.mediaType === 'video' && <video src={it.url} controls />}
                {it.mediaType === 'link' && (
                  <a href={it.url} target="_blank" rel="noreferrer" className="mediaLink">
                    🔗 {it.caption || it.url}
                  </a>
                )}
                {it.caption && it.mediaType !== 'link' && <figcaption>{it.caption}</figcaption>}
              </figure>
            )
          }
          return null
        })}
        <div ref={endRef} />
      </div>
    </aside>
  )
}
