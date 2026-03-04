import { afterEach, describe, expect, it } from 'vitest'
import { startBridgeServer, createStreamableHttpBridgeClient } from '../src/index'

const handles: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop()
    if (handle) {
      await handle.close()
    }
  }
})

describe('bridge', () => {
  it('stdio upstream과 JSON-RPC 요청/응답을 패스스루한다', async () => {
    const handle = await startBridgeServer({
      host: '127.0.0.1',
      port: 19333,
      stdio: {
        command: process.execPath,
        args: [
          '-e',
          [
            'process.stdin.setEncoding("utf8");',
            'let buf = "";',
            'process.stdin.on("data", (chunk) => {',
            '  buf += chunk;',
            '  while (buf.includes("\\n")) {',
            '    const idx = buf.indexOf("\\n");',
            '    const line = buf.slice(0, idx).trim();',
            '    buf = buf.slice(idx + 1);',
            '    if (!line) continue;',
            '    const req = JSON.parse(line);',
            '    if (req.id === undefined) continue;',
            '    const res = { jsonrpc: "2.0", id: req.id, result: { ok: true, method: req.method } };',
            '    process.stdout.write(JSON.stringify(res) + "\\n");',
            '  }',
            '});',
          ].join(''),
        ],
      },
    })
    handles.push(handle)

    const client = createStreamableHttpBridgeClient({ endpoint: handle.endpoint })
    const result = await client.request('tools/list')

    expect(result).toEqual({ ok: true, method: 'tools/list' })
  })

  it('bearer token이 있으면 인증 헤더를 검증한다', async () => {
    const handle = await startBridgeServer({
      host: '127.0.0.1',
      port: 19334,
      bearerToken: 'secret-token',
      stdio: {
        command: process.execPath,
        args: [
          '-e',
          [
            'process.stdin.setEncoding("utf8");',
            'let buf = "";',
            'process.stdin.on("data", (chunk) => {',
            '  buf += chunk;',
            '  while (buf.includes("\\n")) {',
            '    const idx = buf.indexOf("\\n");',
            '    const line = buf.slice(0, idx).trim();',
            '    buf = buf.slice(idx + 1);',
            '    if (!line) continue;',
            '    const req = JSON.parse(line);',
            '    if (req.id === undefined) continue;',
            '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\\n");',
            '  }',
            '});',
          ].join(''),
        ],
      },
    })
    handles.push(handle)

    const noAuthRes = await fetch(handle.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/list' }),
    })
    expect(noAuthRes.status).toBe(401)

    const client = createStreamableHttpBridgeClient({
      endpoint: handle.endpoint,
      headers: { authorization: 'Bearer secret-token' },
    })

    const result = await client.request('tools/list')
    expect(result).toEqual({ ok: true })
  })

  it('corsOrigins 설정 시에도 Origin 없는 서버 요청은 허용한다', async () => {
    const handle = await startBridgeServer({
      host: '127.0.0.1',
      port: 19335,
      corsOrigins: ['http://localhost:5173'],
      stdio: {
        command: process.execPath,
        args: [
          '-e',
          [
            'process.stdin.setEncoding("utf8");',
            'let buf = "";',
            'process.stdin.on("data", (chunk) => {',
            '  buf += chunk;',
            '  while (buf.includes("\\n")) {',
            '    const idx = buf.indexOf("\\n");',
            '    const line = buf.slice(0, idx).trim();',
            '    buf = buf.slice(idx + 1);',
            '    if (!line) continue;',
            '    const req = JSON.parse(line);',
            '    if (req.id === undefined) continue;',
            '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\\n");',
            '  }',
            '});',
          ].join(''),
        ],
      },
    })
    handles.push(handle)

    const noOriginRes = await fetch(handle.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/list' }),
    })
    expect(noOriginRes.status).toBe(200)

    const disallowedOriginRes = await fetch(handle.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:9999',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: '2', method: 'tools/list' }),
    })
    expect(disallowedOriginRes.status).toBe(403)
  })
})
