import { useMemo, useState } from 'react'

type LogLevel = 'info' | 'error'

type LogEntry = {
  id: number
  level: LogLevel
  message: string
}

export function App() {
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:9333/mcp')
  const [logs, setLogs] = useState<LogEntry[]>([
    { id: 1, level: 'info', message: 'Bridge inspector scaffold ready.' },
    { id: 2, level: 'info', message: 'TODO: attach live JSON-RPC request/response stream.' },
  ])

  const status = useMemo(() => {
    if (!endpoint.trim()) return 'disconnected'
    return 'configured'
  }, [endpoint])

  return (
    <main className="shell">
      <header className="header">
        <h1>WebMCP Bridge Inspector</h1>
        <p>Bridge runtime panel for endpoint, traffic, and error tracing.</p>
      </header>

      <section className="panel">
        <label htmlFor="endpoint">Endpoint</label>
        <input
          id="endpoint"
          value={endpoint}
          onChange={e => setEndpoint(e.target.value)}
          placeholder="http://127.0.0.1:9333/mcp"
        />
        <div className="meta">status: {status}</div>
      </section>

      <section className="panel">
        <div className="panel-title">Event Log</div>
        <ul>
          {logs.map(log => (
            <li key={log.id} className={log.level === 'error' ? 'error' : 'info'}>
              {log.message}
            </li>
          ))}
        </ul>
        <button
          onClick={() => {
            setLogs(prev => [
              ...prev,
              { id: prev.length + 1, level: 'info', message: 'Manual log append for smoke check.' },
            ])
          }}
        >
          Add Log
        </button>
      </section>
    </main>
  )
}
