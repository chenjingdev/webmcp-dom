# @webmcp-dom/browser-adapter

브라우저 relay endpoint를 stdio MCP 서버로 노출하는 SDK 기반 어댑터입니다.

> 권장 경로: CSR 통합은 `@webmcp-dom/companion` + `@webmcp-dom/companion-client` 조합을 사용하세요.
> 이 패키지는 relay 기반 호환 모드/실험 경로로 유지됩니다.

역할:

- 입력: MCP stdio(`tools/list`, `tools/call`)
- 출력: HTTP relay endpoint(JSON-RPC)

## Install

```bash
pnpm add @webmcp-dom/browser-adapter
```

## Run (CLI)

```bash
BROWSER_ADAPTER_RELAY_ENDPOINT='http://127.0.0.1:4173/__webmcp/relay' \
pnpm --filter @webmcp-dom/browser-adapter run start
```

옵션 환경변수:

- `BROWSER_ADAPTER_RELAY_ENDPOINT`: relay endpoint URL
- `BROWSER_ADAPTER_BEARER_TOKEN`: Authorization Bearer 토큰
- `BROWSER_ADAPTER_HEADERS`: 추가 헤더(`key:value,key2:value2`)
- `BROWSER_ADAPTER_TIMEOUT_MS`: 요청 타임아웃(ms), 기본 `30000`

## Bridge 연결 예시

```bash
BRIDGE_UPSTREAM_COMMAND=pnpm \
BRIDGE_UPSTREAM_ARGS_JSON='["--filter","@webmcp-dom/browser-adapter","run","start"]'
```

브리지 서버 실행 코드는 [`packages/bridge/README.md`](../bridge/README.md)를 참고하세요.
