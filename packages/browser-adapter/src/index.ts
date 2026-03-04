import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'

type LogLevel = 'info' | 'error'

interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc?: string
  id?: string | number | null
  result?: T
  error?: JsonRpcError
}

export interface BrowserRelayHttpClientOptions {
  endpoint: string
  headers?: Record<string, string>
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface BrowserAdapterServerOptions {
  relay: BrowserRelayHttpClientOptions
  serverName?: string
  serverVersion?: string
  logger?: (level: LogLevel, message: string) => void
}

export interface BrowserAdapterServerHandle {
  close(): Promise<void>
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function ensureToolList(result: unknown): ListToolsResult {
  if (!result || typeof result !== 'object') {
    throw new Error('relay tools/list 응답이 객체가 아닙니다.')
  }

  const tools = (result as { tools?: unknown }).tools
  if (!Array.isArray(tools)) {
    throw new Error('relay tools/list 응답에 tools 배열이 없습니다.')
  }

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || typeof (tool as Tool).name !== 'string') {
      throw new Error('relay tools/list 응답에 잘못된 tool 항목이 있습니다.')
    }
  }

  return result as ListToolsResult
}

function ensureCallToolResult(result: unknown): CallToolResult {
  if (!result || typeof result !== 'object') {
    throw new Error('relay tools/call 응답이 객체가 아닙니다.')
  }
  return result as CallToolResult
}

export function createBrowserRelayHttpClient(options: BrowserRelayHttpClientOptions) {
  const endpoint = options.endpoint.trim()
  const baseHeaders = options.headers ?? {}
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  const fetchImpl = options.fetchImpl ?? fetch

  if (!endpoint) {
    throw new Error('relay endpoint가 비어 있습니다.')
  }

  async function request<T>(method: string, params?: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)

    try {
      const payload = {
        jsonrpc: '2.0',
        id: randomUUID(),
        method,
        params,
      }

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...baseHeaders,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      const text = await response.text()
      let parsed: JsonRpcResponse<T>

      try {
        parsed = JSON.parse(text) as JsonRpcResponse<T>
      } catch {
        throw new Error(`relay 응답 JSON 파싱 실패(status=${response.status})`)
      }

      if (parsed.error) {
        throw new Error(
          `relay ${method} 오류(code=${parsed.error.code}): ${parsed.error.message}`,
        )
      }

      if (!response.ok) {
        throw new Error(`relay ${method} HTTP 오류(status=${response.status})`)
      }

      if (parsed.result === undefined) {
        throw new Error(`relay ${method} 응답에 result가 없습니다.`)
      }

      return parsed.result
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    request,
  }
}

export function createBrowserAdapterServer(options: BrowserAdapterServerOptions) {
  const logger =
    options.logger ??
    ((level: LogLevel, message: string) => {
      const prefix = '[browser-adapter]'
      if (level === 'error') {
        console.error(`${prefix} ${message}`)
        return
      }
      console.error(`${prefix} ${message}`)
    })

  const relayClient = createBrowserRelayHttpClient(options.relay)
  const server = new Server(
    {
      name: options.serverName ?? 'webmcp-browser-adapter',
      version: options.serverVersion ?? '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await relayClient.request<unknown>('tools/list')
    const list = ensureToolList(result)
    logger('info', `tools/list proxied (${list.tools.length} tools)`)
    return list
  })

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const toolName = request.params.name
    const result = await relayClient.request<unknown>('tools/call', request.params)
    const callResult = ensureCallToolResult(result)
    logger('info', `tools/call proxied (${toolName})`)
    return callResult
  })

  server.onerror = error => {
    logger('error', `server error: ${getErrorMessage(error)}`)
  }

  return server
}

export async function startBrowserAdapterServer(
  options: BrowserAdapterServerOptions,
): Promise<BrowserAdapterServerHandle> {
  const server = createBrowserAdapterServer(options)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  return {
    async close() {
      await server.close()
    },
  }
}
