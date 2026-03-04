# @webmcp-dom/companion-client

브라우저 페이지에서 로컬 companion으로 tool snapshot/call 결과를 동기화하는 CSR SDK입니다.

## Install

```bash
pnpm add @webmcp-dom/companion-client
```

## Usage

```ts
import { initializeWebMcpCompanionClient } from '@webmcp-dom/companion-client'

initializeWebMcpCompanionClient({
  appId: 'my-csr-app',
})
```

기본 동작:

- `/page/ws` WebSocket으로 tool snapshot/결과 동기화(구버전 companion은 HTTP `/page/sync`로 폴백)
- `navigator.modelContextTesting.listTools()` snapshot 전송
- companion의 pending call을 `executeTool`로 실행
- 실행 결과를 companion으로 회신
