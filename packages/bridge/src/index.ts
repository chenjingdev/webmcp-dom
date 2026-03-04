import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export interface BridgeServerOptions {
  host?: string
  port?: number
  path?: string
  corsOrigins?: string[]
  bearerToken?: string
  requestTimeoutMs?: number
  stdio: {
    command: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
  }
}

export interface BridgeServerHandle {
  close(): Promise<void>
  endpoint: string
}

export interface BridgeClientOptions {
  endpoint: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}

type JsonRpcId = string | number

interface JsonRpcMessage {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return undefined
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function toErrorResponse(id: JsonRpcId | null, code: number, message: string) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }
}

export async function startBridgeServer(options: BridgeServerOptions): Promise<BridgeServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 9333
  const path = options.path ?? '/mcp'
  const corsOrigins = options.corsOrigins ?? []
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000

  const child = spawn(options.stdio.command, options.stdio.args ?? [], {
    cwd: options.stdio.cwd,
    env: { ...process.env, ...(options.stdio.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (!child.stdin || !child.stdout) {
    throw new Error('stdio 브리지 시작 실패: child stdio를 열 수 없습니다.')
  }

  const pending = new Map<
    JsonRpcId,
    {
      resolve: (msg: JsonRpcMessage) => void
      reject: (err: Error) => void
      timer: NodeJS.Timeout
    }
  >()

  let stdoutBuffer = ''

  const rejectAll = (reason: string) => {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
      pending.delete(id)
    }
  }

  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString('utf8')
    while (stdoutBuffer.includes('\n')) {
      const idx = stdoutBuffer.indexOf('\n')
      const line = stdoutBuffer.slice(0, idx).trim()
      stdoutBuffer = stdoutBuffer.slice(idx + 1)
      if (!line) continue

      const parsed = safeParseJson(line)
      if (!parsed || typeof parsed !== 'object') continue
      const msg = parsed as JsonRpcMessage

      if (msg.id === undefined || msg.id === null) {
        continue
      }

      const entry = pending.get(msg.id)
      if (!entry) continue
      clearTimeout(entry.timer)
      pending.delete(msg.id)
      entry.resolve(msg)
    }
  })

  child.on('exit', (code, signal) => {
    rejectAll(`upstream stdio 종료(code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
  })

  child.on('error', err => {
    rejectAll(`upstream stdio 오류: ${err.message}`)
  })

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin

    if (corsOrigins.length > 0) {
      if (!origin || !corsOrigins.includes(origin)) {
        writeJson(res, 403, { error: 'CORS origin not allowed' })
        return
      }
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
      res.setHeader('access-control-allow-headers', 'content-type, authorization')
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    if (req.method !== 'POST' || req.url !== path) {
      writeJson(res, 404, { error: 'Not found' })
      return
    }

    if (options.bearerToken) {
      const authHeader = req.headers.authorization
      if (authHeader !== `Bearer ${options.bearerToken}`) {
        writeJson(res, 401, { error: 'Unauthorized' })
        return
      }
    }

    let body = ''
    try {
      body = await readBody(req)
    } catch {
      writeJson(res, 400, { error: 'Failed to read request body' })
      return
    }

    const parsed = safeParseJson(body)
    if (!parsed || typeof parsed !== 'object') {
      writeJson(res, 400, toErrorResponse(null, -32700, 'Parse error'))
      return
    }

    const msg = parsed as JsonRpcMessage
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      writeJson(res, 400, toErrorResponse(msg.id ?? null, -32600, 'Invalid Request'))
      return
    }

    try {
      child.stdin.write(`${JSON.stringify(msg)}\n`, 'utf8')
    } catch (error) {
      writeJson(
        res,
        502,
        toErrorResponse(msg.id ?? null, -32000, `Upstream write failed: ${String(error)}`),
      )
      return
    }

    if (msg.id === undefined || msg.id === null) {
      writeJson(res, 202, { accepted: true })
      return
    }

    const responsePromise = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(msg.id as JsonRpcId)
        reject(new Error('Upstream response timeout'))
      }, requestTimeoutMs)

      pending.set(msg.id as JsonRpcId, { resolve, reject, timer })
    })

    try {
      const upstreamResponse = await responsePromise
      writeJson(res, 200, upstreamResponse)
    } catch (error) {
      writeJson(
        res,
        504,
        toErrorResponse(
          msg.id,
          -32001,
          error instanceof Error ? error.message : String(error),
        ),
      )
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    endpoint: `http://${host}:${port}${path}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(err => {
          if (err) {
            reject(err)
            return
          }
          resolve()
        })
      })

      rejectAll('bridge closed')
      if (!child.killed) {
        child.kill('SIGTERM')
      }
    },
  }
}

export function createStreamableHttpBridgeClient(options: BridgeClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = options.endpoint
  const baseHeaders = options.headers ?? {}

  async function post(payload: JsonRpcMessage): Promise<JsonRpcMessage> {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...baseHeaders,
      },
      body: JSON.stringify(payload),
    })

    const text = await response.text()
    const parsed = safeParseJson(text)

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Bridge 응답 파싱 실패(status=${response.status})`)
    }

    return parsed as JsonRpcMessage
  }

  return {
    async request(method: string, params?: unknown): Promise<unknown> {
      const id = randomUUID()
      const res = await post({
        jsonrpc: '2.0',
        id,
        method,
        params,
      })

      if (res.error) {
        throw new Error(typeof res.error === 'object' ? JSON.stringify(res.error) : String(res.error))
      }
      return res.result
    },

    async notify(method: string, params?: unknown): Promise<void> {
      await post({
        jsonrpc: '2.0',
        method,
        params,
      })
    },

    async close(): Promise<void> {
      // stateless client
    },
  }
}
