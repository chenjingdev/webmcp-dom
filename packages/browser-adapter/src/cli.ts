import { startBrowserAdapterServer } from './index.js'

function parseHeaderPairs(raw: string | undefined): Record<string, string> {
  if (!raw) return {}

  const result: Record<string, string> = {}
  for (const token of raw.split(',')) {
    const pair = token.trim()
    if (!pair) continue

    const separator = pair.indexOf(':')
    if (separator <= 0) {
      throw new Error(
        `BROWSER_ADAPTER_HEADERS 형식 오류: "${pair}" (예: "x-api-key:abc, x-team:dev")`,
      )
    }

    const key = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!key || !value) {
      throw new Error(`BROWSER_ADAPTER_HEADERS 형식 오류: "${pair}"`)
    }
    result[key] = value
  }

  return result
}

const relayEndpoint =
  process.env.BROWSER_ADAPTER_RELAY_ENDPOINT ?? 'http://127.0.0.1:4173/__webmcp/relay'
const timeoutText = process.env.BROWSER_ADAPTER_TIMEOUT_MS
const timeoutMs = timeoutText ? Number(timeoutText) : 30_000

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('[browser-adapter] BROWSER_ADAPTER_TIMEOUT_MS는 양수 숫자여야 합니다.')
  process.exit(1)
}

let extraHeaders: Record<string, string>
try {
  extraHeaders = parseHeaderPairs(process.env.BROWSER_ADAPTER_HEADERS)
} catch (error) {
  console.error(`[browser-adapter] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

if (process.env.BROWSER_ADAPTER_BEARER_TOKEN) {
  extraHeaders.authorization = `Bearer ${process.env.BROWSER_ADAPTER_BEARER_TOKEN}`
}

await startBrowserAdapterServer({
  relay: {
    endpoint: relayEndpoint,
    headers: extraHeaders,
    requestTimeoutMs: timeoutMs,
  },
})

console.error(
  `[browser-adapter] stdio server started (relay=${relayEndpoint}, timeoutMs=${timeoutMs})`,
)
