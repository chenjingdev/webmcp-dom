import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startCompanionServer } from '../src/index'

const handles: Array<{ close: () => Promise<void> }> = []
const tempDirs: string[] = []

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop()
    if (handle) {
      await handle.close()
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

function makeHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmcp-companion-test-'))
  tempDirs.push(dir)
  return dir
}

async function postJson(url: string, payload: unknown, headers?: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(headers ?? {}),
    },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  return {
    status: res.status,
    body: text ? JSON.parse(text) : {},
  }
}

async function getJson(url: string, headers?: Record<string, string>) {
  const res = await fetch(url, {
    method: 'GET',
    headers: headers ?? {},
  })
  const text = await res.text()
  return {
    status: res.status,
    body: text ? JSON.parse(text) : {},
  }
}

async function waitForWebSocketOpen(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.off('error', onError)
      resolve()
    }
    const onError = (error: Error) => {
      socket.off('open', onOpen)
      reject(error)
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
  })
}

async function waitForWebSocketMessage(socket: WebSocket) {
  return await new Promise<unknown>((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      socket.off('error', onError)
      try {
        const text =
          typeof raw === 'string'
            ? raw
            : Array.isArray(raw)
              ? Buffer.concat(raw as Buffer[]).toString('utf8')
              : Buffer.isBuffer(raw)
                ? raw.toString('utf8')
                : ''
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    }
    const onError = (error: Error) => {
      socket.off('message', onMessage)
      reject(error)
    }
    socket.once('message', onMessage)
    socket.once('error', onError)
  })
}

async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 4_000,
  intervalMs = 100,
) {
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return true
    if (Date.now() - startedAt >= timeoutMs) return false
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

describe('companion', () => {
  it('origin 승인 전에는 tools/list가 빈 배열이고 승인 후 노출한다', async () => {
    const handle = await startCompanionServer({
      host: '127.0.0.1',
      port: 19440,
      homeDir: makeHomeDir(),
    })
    handles.push(handle)

    const connectRes = await postJson('http://127.0.0.1:19440/page/connect', {
      appId: 'test-app',
      clientId: 'client-1',
      origin: 'http://example.local',
      url: 'http://example.local/',
      title: 'Example',
      clientVersion: '0.0.1',
    })
    expect(connectRes.status).toBe(200)

    const sessionId = connectRes.body.sessionId as string
    expect(connectRes.body.status).toBe('pending')

    await postJson('http://127.0.0.1:19440/page/sync', {
      sessionId,
      tools: [
        {
          name: 'navigation_click',
          description: 'desc',
          inputSchema: { type: 'object' },
        },
      ],
      sensitiveTargetIds: [],
      completedCalls: [],
    })

    const listBeforeApprove = await postJson('http://127.0.0.1:19440/mcp', {
      jsonrpc: '2.0',
      id: '1',
      method: 'tools/list',
    })
    expect(Array.isArray(listBeforeApprove.body.result.tools)).toBe(true)
    expect(listBeforeApprove.body.result.tools).toHaveLength(0)

    const approveRes = await postJson(
      'http://127.0.0.1:19440/admin/api/origins/approve',
      { origin: 'http://example.local' },
      { 'x-webmcp-admin-token': handle.adminToken },
    )
    expect(approveRes.status).toBe(200)

    const listAfterApprove = await postJson('http://127.0.0.1:19440/mcp', {
      jsonrpc: '2.0',
      id: '2',
      method: 'tools/list',
    })
    expect(listAfterApprove.body.result.tools[0].name).toBe('navigation_click')
  })

  it('tools/call을 page sync 왕복으로 완료한다', async () => {
    const handle = await startCompanionServer({
      host: '127.0.0.1',
      port: 19441,
      homeDir: makeHomeDir(),
      callTimeoutMs: 5_000,
    })
    handles.push(handle)

    const connectRes = await postJson('http://127.0.0.1:19441/page/connect', {
      appId: 'test-app',
      clientId: 'client-2',
      origin: 'http://example.local',
      url: 'http://example.local/',
      title: 'Example',
      clientVersion: '0.0.1',
    })
    const sessionId = connectRes.body.sessionId as string

    await postJson(
      'http://127.0.0.1:19441/admin/api/origins/approve',
      { origin: 'http://example.local' },
      { 'x-webmcp-admin-token': handle.adminToken },
    )

    await postJson('http://127.0.0.1:19441/page/sync', {
      sessionId,
      tools: [
        {
          name: 'navigation_click',
          description: 'desc',
          inputSchema: { type: 'object' },
        },
      ],
      sensitiveTargetIds: [],
      completedCalls: [],
    })

    const callPromise = postJson('http://127.0.0.1:19441/mcp', {
      jsonrpc: '2.0',
      id: '3',
      method: 'tools/call',
      params: {
        name: 'navigation_click',
        arguments: { target: 'mcp_x' },
      },
    })

    const syncPull = await postJson('http://127.0.0.1:19441/page/sync', {
      sessionId,
      tools: [
        {
          name: 'navigation_click',
          description: 'desc',
          inputSchema: { type: 'object' },
        },
      ],
      sensitiveTargetIds: [],
      completedCalls: [],
    })

    const callId = syncPull.body.pendingCalls[0].callId as string
    await postJson('http://127.0.0.1:19441/page/sync', {
      sessionId,
      tools: [
        {
          name: 'navigation_click',
          description: 'desc',
          inputSchema: { type: 'object' },
        },
      ],
      sensitiveTargetIds: [],
      completedCalls: [
        {
          callId,
          ok: true,
          result: {
            content: [{ type: 'text', text: 'clicked' }],
          },
        },
      ],
    })

    const callRes = await callPromise
    expect(callRes.body.result.content[0].text).toBe('clicked')
  })

  it('admin api는 토큰 없으면 거부한다', async () => {
    const handle = await startCompanionServer({
      host: '127.0.0.1',
      port: 19442,
      homeDir: makeHomeDir(),
    })
    handles.push(handle)

    const res = await getJson('http://127.0.0.1:19442/admin/api/status')
    expect(res.status).toBe(401)
  })

  it('resources 관련 MCP 메서드는 빈 배열로 응답한다', async () => {
    const handle = await startCompanionServer({
      host: '127.0.0.1',
      port: 19445,
      homeDir: makeHomeDir(),
    })
    handles.push(handle)

    const listRes = await postJson('http://127.0.0.1:19445/mcp', {
      jsonrpc: '2.0',
      id: 'resources-1',
      method: 'resources/list',
    })
    expect(Array.isArray(listRes.body.result.resources)).toBe(true)
    expect(listRes.body.result.resources).toHaveLength(0)

    const templatesRes = await postJson('http://127.0.0.1:19445/mcp', {
      jsonrpc: '2.0',
      id: 'resources-2',
      method: 'resources/templates/list',
    })
    expect(Array.isArray(templatesRes.body.result.resourceTemplates)).toBe(true)
    expect(templatesRes.body.result.resourceTemplates).toHaveLength(0)
  })

  it('heartbeat가 만료되면 tools/list는 빈 배열을 반환한다', async () => {
    const handle = await startCompanionServer({
      host: '127.0.0.1',
      port: 19443,
      homeDir: makeHomeDir(),
      heartbeatTimeoutMs: 30,
    })
    handles.push(handle)

    const connectRes = await postJson('http://127.0.0.1:19443/page/connect', {
      appId: 'test-app',
      clientId: 'client-3',
      origin: 'http://example.local',
      url: 'http://example.local/',
      title: 'Example',
      clientVersion: '0.0.1',
    })
    const sessionId = connectRes.body.sessionId as string

    await postJson(
      'http://127.0.0.1:19443/admin/api/origins/approve',
      { origin: 'http://example.local' },
      { 'x-webmcp-admin-token': handle.adminToken },
    )

    await postJson('http://127.0.0.1:19443/page/sync', {
      sessionId,
      tools: [
        {
          name: 'navigation_click',
          description: 'desc',
          inputSchema: { type: 'object' },
        },
      ],
      sensitiveTargetIds: [],
      completedCalls: [],
    })

    await new Promise(resolve => setTimeout(resolve, 60))

    const listRes = await postJson('http://127.0.0.1:19443/mcp', {
      jsonrpc: '2.0',
      id: '4',
      method: 'tools/list',
    })
    expect(Array.isArray(listRes.body.result.tools)).toBe(true)
    expect(listRes.body.result.tools).toHaveLength(0)
  })

  it('tools/call 결과가 오지 않으면 timeout 에러를 반환한다', async () => {
    const handle = await startCompanionServer({
      host: '127.0.0.1',
      port: 19446,
      homeDir: makeHomeDir(),
      callTimeoutMs: 80,
    })
    handles.push(handle)

    const connectRes = await postJson('http://127.0.0.1:19446/page/connect', {
      appId: 'test-app',
      clientId: 'client-4',
      origin: 'http://example.local',
      url: 'http://example.local/',
      title: 'Example',
      clientVersion: '0.0.1',
    })
    const sessionId = connectRes.body.sessionId as string

    await postJson(
      'http://127.0.0.1:19446/admin/api/origins/approve',
      { origin: 'http://example.local' },
      { 'x-webmcp-admin-token': handle.adminToken },
    )

    await postJson('http://127.0.0.1:19446/page/sync', {
      sessionId,
      tools: [
        {
          name: 'navigation_click',
          description: 'desc',
          inputSchema: { type: 'object' },
        },
      ],
      sensitiveTargetIds: [],
      completedCalls: [],
    })

    const callRes = await postJson('http://127.0.0.1:19446/mcp', {
      jsonrpc: '2.0',
      id: '5',
      method: 'tools/call',
      params: {
        name: 'navigation_click',
        arguments: { target: 'mcp_x' },
      },
    })

    expect(callRes.body.error.code).toBe(-32000)
    expect(callRes.body.error.message).toContain('timed out')
  })

  it('websocket sync로 tools/list를 갱신한다', async () => {
    const handle = await startCompanionServer({
      host: '127.0.0.1',
      port: 19448,
      homeDir: makeHomeDir(),
      callTimeoutMs: 5_000,
    })
    handles.push(handle)

    const connectRes = await postJson('http://127.0.0.1:19448/page/connect', {
      appId: 'test-app',
      clientId: 'client-ws-1',
      origin: 'http://example.local',
      url: 'http://example.local/',
      title: 'Example WS',
      clientVersion: '0.0.1',
    })
    const sessionId = connectRes.body.sessionId as string

    await postJson(
      'http://127.0.0.1:19448/admin/api/origins/approve',
      { origin: 'http://example.local' },
      { 'x-webmcp-admin-token': handle.adminToken },
    )

    const socket = new WebSocket(`ws://127.0.0.1:19448/page/ws?sessionId=${encodeURIComponent(sessionId)}`, {
      origin: 'http://example.local',
    })
    await waitForWebSocketOpen(socket)

    socket.send(
      JSON.stringify({
        type: 'sync',
        tools: [
          {
            name: 'navigation_click',
            description: 'desc',
            inputSchema: { type: 'object' },
          },
        ],
        sensitiveTargetIds: [],
        completedCalls: [],
      }),
    )
    await waitForWebSocketMessage(socket)

    const listRes = await postJson('http://127.0.0.1:19448/mcp', {
      jsonrpc: '2.0',
      id: 'ws-list-1',
      method: 'tools/list',
    })
    expect(listRes.body.result.tools[0].name).toBe('navigation_click')

    socket.close()
  })

  it('웹소켓 탭 종료 시 세션이 자동 제거된다', async () => {
    const handle = await startCompanionServer({
      host: '127.0.0.1',
      port: 19449,
      homeDir: makeHomeDir(),
      callTimeoutMs: 5_000,
    })
    handles.push(handle)

    const connectRes = await postJson('http://127.0.0.1:19449/page/connect', {
      appId: 'test-app',
      clientId: 'client-ws-close-1',
      origin: 'http://example.local',
      url: 'http://example.local/',
      title: 'Example WS close',
      clientVersion: '0.0.1',
    })
    const sessionId = connectRes.body.sessionId as string

    await postJson(
      'http://127.0.0.1:19449/admin/api/origins/approve',
      { origin: 'http://example.local' },
      { 'x-webmcp-admin-token': handle.adminToken },
    )

    const socket = new WebSocket(`ws://127.0.0.1:19449/page/ws?sessionId=${encodeURIComponent(sessionId)}`, {
      origin: 'http://example.local',
    })
    await waitForWebSocketOpen(socket)
    socket.close()

    const removed = await waitForCondition(async () => {
      const sessionsRes = await getJson('http://127.0.0.1:19449/admin/api/sessions', {
        'x-webmcp-admin-token': handle.adminToken,
      })
      if (sessionsRes.status !== 200 || !Array.isArray(sessionsRes.body.sessions)) {
        return false
      }
      return sessionsRes.body.sessions.length === 0
    }, 5_000)

    expect(removed).toBe(true)
  })

  it('companion 재시작 시 admin token이 새로 발급된다', async () => {
    const sharedHomeDir = makeHomeDir()

    const first = await startCompanionServer({
      host: '127.0.0.1',
      port: 19450,
      homeDir: sharedHomeDir,
    })
    handles.push(first)
    const firstToken = first.adminToken
    await first.close()
    handles.pop()

    const second = await startCompanionServer({
      host: '127.0.0.1',
      port: 19451,
      homeDir: sharedHomeDir,
    })
    handles.push(second)

    expect(second.adminToken).not.toBe(firstToken)
  })

  it('heartbeat 만료 세션은 이후 요청에서 자동 정리된다', async () => {
    const handle = await startCompanionServer({
      host: '127.0.0.1',
      port: 19447,
      homeDir: makeHomeDir(),
      heartbeatTimeoutMs: 20,
      pollIntervalMs: 20,
    })
    handles.push(handle)

    const firstConnect = await postJson('http://127.0.0.1:19447/page/connect', {
      appId: 'test-app',
      clientId: 'client-stale-1',
      origin: 'http://example.local',
      url: 'http://example.local/',
      title: 'Example 1',
      clientVersion: '0.0.1',
    })
    const firstSessionId = firstConnect.body.sessionId as string
    expect(typeof firstSessionId).toBe('string')

    await new Promise(resolve => setTimeout(resolve, 80))

    await postJson('http://127.0.0.1:19447/page/connect', {
      appId: 'test-app',
      clientId: 'client-stale-2',
      origin: 'http://example.local',
      url: 'http://example.local/2',
      title: 'Example 2',
      clientVersion: '0.0.1',
    })

    const sessionsRes = await getJson('http://127.0.0.1:19447/admin/api/sessions', {
      'x-webmcp-admin-token': handle.adminToken,
    })
    expect(sessionsRes.status).toBe(200)
    expect(Array.isArray(sessionsRes.body.sessions)).toBe(true)
    expect(sessionsRes.body.sessions).toHaveLength(1)
    expect(sessionsRes.body.sessions[0].id).not.toBe(firstSessionId)
  })
})
