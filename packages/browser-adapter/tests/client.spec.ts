import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrowserRelayHttpClient } from '../src/index'

const servers: http.Server[] = []

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    if (!server) continue
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }
})

async function startServer(
  port: number,
  handler: (reqBody: unknown, res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 404
      res.end('not found')
      return
    }

    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      body += chunk
    })
    await new Promise(resolve => req.on('end', resolve))

    const parsed = JSON.parse(body) as unknown
    handler(parsed, res)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  servers.push(server)
  return `http://127.0.0.1:${port}/relay`
}

describe('createBrowserRelayHttpClient', () => {
  it('JSON-RPC request를 relay endpoint로 전송한다', async () => {
    const endpoint = await startServer(19433, (reqBody, res) => {
      const method = (reqBody as { method?: string }).method
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: (reqBody as { id?: string }).id ?? null,
          result: { ok: true, method },
        }),
      )
    })

    const client = createBrowserRelayHttpClient({ endpoint })
    const result = await client.request<{ ok: boolean; method: string }>('tools/list')

    expect(result).toEqual({ ok: true, method: 'tools/list' })
  })

  it('JSON-RPC error 응답이면 예외를 던진다', async () => {
    const endpoint = await startServer(19434, (reqBody, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: (reqBody as { id?: string }).id ?? null,
          error: { code: -32000, message: 'relay failed' },
        }),
      )
    })

    const client = createBrowserRelayHttpClient({ endpoint })
    await expect(client.request('tools/list')).rejects.toThrow('relay tools/list 오류')
  })
})
