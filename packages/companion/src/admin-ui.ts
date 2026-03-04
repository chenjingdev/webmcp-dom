export function renderAdminHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WebMCP Companion Admin</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #f2f5fa; color: #16212f; }
      main { max-width: 1080px; margin: 0 auto; padding: 18px 14px 40px; }
      h1 { margin: 0; font-size: 28px; }
      p { color: #4a596e; }
      .card { background: #fff; border: 1px solid #d8e0ea; border-radius: 10px; padding: 12px; margin-top: 14px; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
      button { border: 0; border-radius: 8px; padding: 6px 10px; background: #0f6bdc; color: white; cursor: pointer; }
      button.danger { background: #c63636; }
      table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 13px; }
      th, td { border-bottom: 1px solid #e7edf5; text-align: left; padding: 6px; vertical-align: top; }
      th { color: #4a596e; font-weight: 600; }
      code { font-family: ui-monospace, Menlo, monospace; }
      pre { margin: 0; max-height: 280px; overflow: auto; background: #0f1b2b; color: #d6e0ef; padding: 10px; border-radius: 8px; font-size: 12px; }
      .muted { color: #65758a; }
      .pill { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 12px; background: #e9f1ff; color: #1f4d93; }
      .pill.pending { background: #fff4dd; color: #8c5a08; }
      .pill.denied { background: #ffe4e4; color: #932626; }
      .pill.active { background: #dff6e6; color: #1d6b3a; }
    </style>
  </head>
  <body>
    <main>
      <h1>WebMCP Companion</h1>
      <p>로컬 companion 상태/세션/승인을 관리합니다.</p>
      <section class="card">
        <h3>Status</h3>
        <pre id="status">loading...</pre>
      </section>
      <section class="card">
        <h3>Sessions</h3>
        <div id="sessions"></div>
      </section>
      <section class="card">
        <h3>Origins</h3>
        <div id="origins"></div>
      </section>
      <section class="card">
        <h3>Confirmations</h3>
        <div id="confirmations"></div>
      </section>
      <section class="card">
        <h3>Logs</h3>
        <pre id="logs">loading...</pre>
      </section>
    </main>
    <script>
      const token = new URLSearchParams(window.location.search).get('token') || ''
      const headers = { 'content-type': 'application/json', 'x-webmcp-admin-token': token }

      async function api(path, init = {}) {
        const res = await fetch(path, { ...init, headers: { ...headers, ...(init.headers || {}) } })
        const text = await res.text()
        if (!res.ok) {
          throw new Error(\`HTTP \${res.status}: \${text}\`)
        }
        return text ? JSON.parse(text) : {}
      }

      function fmtMs(ts) {
        if (!ts) return '-'
        const d = new Date(ts)
        return d.toLocaleTimeString()
      }

      function renderSessions(list) {
        if (!Array.isArray(list) || list.length === 0) {
          document.getElementById('sessions').innerHTML = '<div class="muted">세션 없음</div>'
          return
        }

        const rows = list.map(session => {
          const statusPill = \`<span class="pill \${session.approvalStatus}">\${session.approvalStatus}</span>\`
          const activePill = session.active ? '<span class="pill active">active</span>' : ''
          const action = session.active
            ? ''
            : \`<button onclick="activateSession('\${session.id.replace(/'/g, "\\\\'")}')">Set Active</button>\`
          return \`<tr>
            <td><code>\${session.id}</code></td>
            <td>\${session.title || '-'}<br/><span class="muted">\${session.url || '-'}</span></td>
            <td>\${session.origin}</td>
            <td>\${statusPill} \${activePill}</td>
            <td>\${session.toolCount}</td>
            <td>\${session.pendingCallCount}</td>
            <td>\${fmtMs(session.lastSeenAt)}</td>
            <td>\${action}</td>
          </tr>\`
        }).join('')

        document.getElementById('sessions').innerHTML = \`<table>
          <thead><tr><th>ID</th><th>Page</th><th>Origin</th><th>Status</th><th>Tools</th><th>Pending</th><th>Last Seen</th><th>Action</th></tr></thead>
          <tbody>\${rows}</tbody>
        </table>\`
      }

      function renderOrigins(items) {
        if (!Array.isArray(items) || items.length === 0) {
          document.getElementById('origins').innerHTML = '<div class="muted">origin 없음</div>'
          return
        }
        const rows = items.map(item => {
          const approve = \`<button onclick="approveOrigin('\${item.origin.replace(/'/g, "\\\\'")}')">Approve</button>\`
          const revoke = \`<button class="danger" onclick="revokeOrigin('\${item.origin.replace(/'/g, "\\\\'")}')">Revoke</button>\`
          return \`<tr>
            <td><code>\${item.origin}</code></td>
            <td><span class="pill \${item.status}">\${item.status}</span></td>
            <td>\${approve} \${revoke}</td>
          </tr>\`
        }).join('')
        document.getElementById('origins').innerHTML = \`<table>
          <thead><tr><th>Origin</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>\${rows}</tbody>
        </table>\`
      }

      function renderConfirmations(items) {
        if (!Array.isArray(items) || items.length === 0) {
          document.getElementById('confirmations').innerHTML = '<div class="muted">확인 대기 없음</div>'
          return
        }
        const rows = items.map(item => {
          const approve = \`<button onclick="approveConfirmation('\${item.callId}')">Approve</button>\`
          const reject = \`<button class="danger" onclick="rejectConfirmation('\${item.callId}')">Reject</button>\`
          return \`<tr>
            <td><code>\${item.callId}</code></td>
            <td>\${item.toolName}</td>
            <td><code>\${JSON.stringify(item.arguments)}</code></td>
            <td>\${fmtMs(item.createdAt)}</td>
            <td>\${approve} \${reject}</td>
          </tr>\`
        }).join('')
        document.getElementById('confirmations').innerHTML = \`<table>
          <thead><tr><th>Call</th><th>Tool</th><th>Args</th><th>Created</th><th>Action</th></tr></thead>
          <tbody>\${rows}</tbody>
        </table>\`
      }

      async function activateSession(sessionId) {
        await api('/admin/api/sessions/activate', { method: 'POST', body: JSON.stringify({ sessionId }) })
        await refresh()
      }

      async function approveOrigin(origin) {
        await api('/admin/api/origins/approve', { method: 'POST', body: JSON.stringify({ origin }) })
        await refresh()
      }

      async function revokeOrigin(origin) {
        await api('/admin/api/origins/revoke', { method: 'POST', body: JSON.stringify({ origin }) })
        await refresh()
      }

      async function approveConfirmation(callId) {
        await api('/admin/api/confirmations/approve', { method: 'POST', body: JSON.stringify({ callId }) })
        await refresh()
      }

      async function rejectConfirmation(callId) {
        await api('/admin/api/confirmations/reject', { method: 'POST', body: JSON.stringify({ callId }) })
        await refresh()
      }

      async function refresh() {
        try {
          const [status, sessions, origins, logs, confirmations] = await Promise.all([
            api('/admin/api/status'),
            api('/admin/api/sessions'),
            api('/admin/api/origins'),
            api('/admin/api/logs?limit=80'),
            api('/admin/api/confirmations'),
          ])

          document.getElementById('status').textContent = JSON.stringify(status, null, 2)
          renderSessions(sessions.sessions || [])
          renderOrigins(origins.origins || [])
          renderConfirmations(confirmations.confirmations || [])
          document.getElementById('logs').textContent = JSON.stringify(logs.logs || [], null, 2)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          document.getElementById('status').textContent = message
        }
      }

      refresh()
      setInterval(refresh, 1500)
      window.activateSession = activateSession
      window.approveOrigin = approveOrigin
      window.revokeOrigin = revokeOrigin
      window.approveConfirmation = approveConfirmation
      window.rejectConfirmation = rejectConfirmation
    </script>
  </body>
</html>`
}
