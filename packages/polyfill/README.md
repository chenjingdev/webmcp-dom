# @webmcp-dom/polyfill

strict core WebMCP polyfill 패키지입니다.

제공 메서드:
- `provideContext()`
- `registerTool()`
- `unregisterTool()`
- `clearContext()`

브리지/확장 API(`callTool`, resources, prompts)는 포함하지 않습니다.

## 설치

```bash
pnpm add @webmcp-dom/polyfill
```

## 사용

```ts
import { initializeWebMcpPolyfill } from '@webmcp-dom/polyfill'

initializeWebMcpPolyfill({
  nativeModelContextBehavior: 'preserve',
  installTestingShim: 'if-missing',
})
```

## API

- `initializeWebMcpPolyfill(options?)`
- `cleanupWebMcpPolyfill()`
- `initializeWebModelContextPolyfill(options?)` (alias)

