# @webmcp-apps/mcp-test-page

`data-mcp-*` 선언형 DOM 툴 등록과 companion 연동을 검증하는 테스트 페이지입니다.

## Run

```bash
pnpm --filter @webmcp-dom/companion run start
pnpm -C apps/mcp-test-page dev
```

- companion이 실행 중이면 페이지 툴이 로컬 MCP endpoint(`http://127.0.0.1:9333/mcp`)로 노출됩니다.

## Companion 동작

- 페이지는 `navigator.modelContextTesting.listTools()` snapshot을 companion으로 주기적으로 전송합니다.
- companion의 `tools/call` 요청은 페이지의 `executeTool`로 실행되어 결과가 회신됩니다.
