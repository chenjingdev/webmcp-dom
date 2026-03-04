# @webmcp-dom/build-core

`data-mcp-*` 선언형 DOM을 빌드 타임에 수집/검증하고 WebMCP `registerTool` 런타임 등록 코드로 연결합니다.

## 설치

```bash
pnpm add @webmcp-dom/build-core
```

## Vite 사용

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import webMcpDomPlugin from '@webmcp-dom/build-core'

export default defineConfig({
  plugins: [webMcpDomPlugin()],
})
```

```ts
// main.ts
import '@webmcp-dom/build-core/register'
```

## DSL

### 타겟(요소) 레벨

필수:
- `data-mcp-action`
- `data-mcp-name`
- `data-mcp-desc`

선택:
- `data-mcp-key`
- `data-mcp-group`

### 그룹/툴 레벨

선택:
- `data-mcp-group-name`
- `data-mcp-group-desc`
- `data-mcp-tool-name`
- `data-mcp-tool-desc`

### 설명 우선순위

툴 설명(`registerTool.description`):
1. `data-mcp-tool-desc`
2. `data-mcp-group-desc`
3. 자동 생성

버튼 설명(`data-mcp-desc`)은 각 target 설명으로 manifest에 기록됩니다.

### 중첩 그룹

중첩 시 **가장 가까운 상위 그룹**이 적용됩니다.

## 옵션

```ts
webMcpDomPlugin({
  exposureMode: 'grouped', // default
  groupAttr: 'data-mcp-group',
  unsupportedActionHandling: 'warn-skip',
  preserveSourceAttrs: false,
  emitTrackingAttr: 'debug',
  click: {
    autoScroll: true,
    retryCount: 2,
    retryDelayMs: 120,
  },
})
```

## 런타임 동작

- `navigator.modelContext.registerTool`이 없으면 경고 후 no-op
- v1 실행 액션은 `click`
- grouped 모드에서는 `target` 인자로 클릭 대상을 선택
- dev HMR에서 manifest가 바뀌면 기존 등록을 정리하고 재등록
  - `unregisterTool`이 있으면 이전 tool을 제거 후 최신 manifest 반영
- `webmcp.manifest.json` 파일은 build 결과물에서 생성됨
  - dev 중 최신 값은 virtual module(`@webmcp-dom/build-core/manifest`) 기준으로 동작
