import { afterEach, describe, expect, it } from 'vitest'
import {
  getWebMcpCompanionStatus,
  initializeWebMcpCompanionClient,
} from '../src/index'

type MutableGlobal = typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
  navigator?: Navigator & {
    modelContextTesting?: {
      listTools: () => Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
      executeTool: (toolName: string, inputArgsJson?: string) => Promise<string | null>
    }
  }
}

const mutableGlobal = globalThis as MutableGlobal
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function createSessionStorageMock() {
  const store = new Map<string, string>()
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
    removeItem(key: string) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
  } as unknown as Storage
}

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }

  if (originalDocumentDescriptor) {
    Object.defineProperty(globalThis, 'document', originalDocumentDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'document')
  }

  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'navigator')
  }
})

describe('companion-client', () => {
  it('connect/sync 루프를 수행하고 pending call 실행 결과를 회신한다', async () => {
    const executed: string[] = []
    const syncPayloads: unknown[] = []

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout,
        location: {
          origin: 'http://localhost:4173',
          href: 'http://localhost:4173/',
        },
        sessionStorage: createSessionStorageMock(),
      } as unknown as Window & typeof globalThis,
    })

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: {
      title: 'test page',
      querySelectorAll: () => [] as unknown as NodeListOf<HTMLElement>,
      } as unknown as Document,
    })

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
      modelContextTesting: {
        listTools: () => [
          {
            name: 'navigation_click',
            description: 'desc',
            inputSchema: { type: 'object' },
          },
        ],
        executeTool: async (toolName: string) => {
          executed.push(toolName)
          return JSON.stringify({
            content: [{ type: 'text', text: 'ok' }],
          })
        },
      },
      } as unknown as Navigator,
    })

    let sentPendingCall = false
    const fetchImpl: typeof fetch = async (_input, init) => {
      const url = String(_input)
      const body = init?.body ? JSON.parse(String(init.body)) : {}

      if (url.endsWith('/page/connect')) {
        return new Response(
          JSON.stringify({
            sessionId: 'session-1',
            status: 'approved',
            active: true,
            pollIntervalMs: 20,
          }),
          { status: 200 },
        )
      }

      if (url.endsWith('/page/sync')) {
        syncPayloads.push(body)
        if (!sentPendingCall) {
          sentPendingCall = true
          return new Response(
            JSON.stringify({
              status: 'approved',
              active: true,
              pendingCalls: [{ callId: 'call-1', name: 'navigation_click', arguments: {} }],
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            status: 'approved',
            active: true,
            pendingCalls: [],
          }),
          { status: 200 },
        )
      }

      return new Response('{}', { status: 404 })
    }

    const handle = initializeWebMcpCompanionClient({
      appId: 'test-app',
      pollIntervalMs: 20,
      fetchImpl,
    })

    await new Promise(resolve => setTimeout(resolve, 120))
    handle.stop()

    expect(executed).toContain('navigation_click')
    expect(syncPayloads.length).toBeGreaterThanOrEqual(2)
    expect(getWebMcpCompanionStatus().state).toBe('stopped')
  })

  it('같은 탭(세션스토리지)에서는 clientId를 재사용한다', async () => {
    const connectClientIds: string[] = []

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout,
        location: {
          origin: 'http://localhost:4173',
          href: 'http://localhost:4173/',
        },
        sessionStorage: createSessionStorageMock(),
      } as unknown as Window & typeof globalThis,
    })

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: {
        title: 'test page',
        querySelectorAll: () => [] as unknown as NodeListOf<HTMLElement>,
      } as unknown as Document,
    })

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        modelContextTesting: {
          listTools: () => [],
          executeTool: async () => JSON.stringify({ content: [] }),
        },
      } as unknown as Navigator,
    })

    const fetchImpl: typeof fetch = async (_input, init) => {
      const url = String(_input)
      const body = init?.body ? JSON.parse(String(init.body)) : {}

      if (url.endsWith('/page/connect')) {
        if (typeof body.clientId === 'string') {
          connectClientIds.push(body.clientId)
        }
        return new Response(
          JSON.stringify({
            sessionId: 'session-fixed',
            status: 'approved',
            active: true,
          }),
          { status: 200 },
        )
      }

      if (url.endsWith('/page/sync')) {
        return new Response(
          JSON.stringify({
            status: 'approved',
            active: true,
            pendingCalls: [],
          }),
          { status: 200 },
        )
      }

      return new Response('{}', { status: 404 })
    }

    const first = initializeWebMcpCompanionClient({
      appId: 'test-app',
      pollIntervalMs: 20,
      fetchImpl,
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    first.stop()

    const second = initializeWebMcpCompanionClient({
      appId: 'test-app',
      pollIntervalMs: 20,
      fetchImpl,
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    second.stop()

    expect(connectClientIds.length).toBeGreaterThanOrEqual(2)
    expect(connectClientIds[0]).toBe(connectClientIds[1])
  })
})
