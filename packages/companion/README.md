# @webmcp-dom/companion

CSR 앱의 DOM 기반 tool을 로컬 MCP endpoint로 노출하는 단일 동반앱입니다.

기본 주소:

- MCP: `http://127.0.0.1:9333/mcp`
- Page WS: `ws://127.0.0.1:9333/page/ws?sessionId=<id>`
- Admin UI: `http://127.0.0.1:9333/admin?token=<token>`

## Run

```bash
pnpm --filter @webmcp-dom/companion run start
```

## CLI

```bash
pnpm --filter @webmcp-dom/companion run status
pnpm --filter @webmcp-dom/companion run stop
```

## 저장 경로

- 상태: `~/.webmcp-dom/companion/state.json`
- 관리자 토큰: `~/.webmcp-dom/companion/admin-token` (`start` 할 때마다 재발급)
- PID: `~/.webmcp-dom/companion/companion.pid`
