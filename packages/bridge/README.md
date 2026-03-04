# @webmcp-dom/bridge

Streamable HTTP ↔ stdio MCP 브리지 패키지입니다.

## 설치

```bash
pnpm add @webmcp-dom/bridge
```

## 서버 시작

```ts
import { startBridgeServer } from '@webmcp-dom/bridge'

const server = await startBridgeServer({
  host: '127.0.0.1',
  port: 9333,
  path: '/mcp',
  stdio: {
    command: 'claude',
    args: ['mcp', 'serve'],
  },
})

console.log(server.endpoint)
```

## 클라이언트

```ts
import { createStreamableHttpBridgeClient } from '@webmcp-dom/bridge'

const client = createStreamableHttpBridgeClient({
  endpoint: 'http://127.0.0.1:9333/mcp',
})

const tools = await client.request('tools/list')
```

