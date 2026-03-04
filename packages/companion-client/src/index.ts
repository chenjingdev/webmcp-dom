type CompanionStatusState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'pending'
  | 'denied'
  | 'unavailable'
  | 'stopped'

type GuideReason =
  | 'companion-unavailable'
  | 'origin-pending'
  | 'origin-denied'
  | 'model-context-testing-unavailable'

type TestingApi = {
  listTools: () => Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  executeTool: (toolName: string, inputArgsJson?: string) => Promise<string | null>
}

type CompletedCall = {
  callId: string
  ok: boolean
  result?: unknown
  error?: string
}

type ServerPendingCall = {
  callId?: string
  name?: string
  arguments?: unknown
}

type ServerWsMessage = {
  type?: string
  status?: string
  active?: boolean
  pendingCalls?: ServerPendingCall[]
  message?: string
}

export interface CompanionClientStatus {
  state: CompanionStatusState
  companionBaseUrl: string
  sessionId: string | null
  active: boolean
  lastError: string | null
  updatedAt: number
}

export interface InitializeWebMcpCompanionClientOptions {
  appId: string
  companionBaseUrl?: string
  pollIntervalMs?: number
  onStatusChange?: (status: CompanionClientStatus) => void
  onGuideRequired?: (reason: GuideReason) => void
  fetchImpl?: typeof fetch
}

export interface CompanionClientHandle {
  stop: () => void
}

const CLIENT_VERSION = '0.1.0'
const DEFAULT_BASE_URL = 'http://127.0.0.1:9333'
const DEFAULT_POLL_INTERVAL_MS = 800
const DEFAULT_TIMEOUT_MS = 4_000
const CLIENT_ID_STORAGE_PREFIX = '__webmcp_companion_client_id__'

let activeHandle: CompanionClientHandle | null = null
let currentStatus: CompanionClientStatus = {
  state: 'idle',
  companionBaseUrl: DEFAULT_BASE_URL,
  sessionId: null,
  active: false,
  lastError: null,
  updatedAt: Date.now(),
}

function getTestingApi(): TestingApi | null {
  const nav = navigator as Navigator & { modelContextTesting?: TestingApi }
  return nav.modelContextTesting ?? null
}

function createClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `wmcp_${Math.random().toString(36).slice(2)}`
}

function getOrCreateClientId(appId: string): string {
  const key = `${CLIENT_ID_STORAGE_PREFIX}:${appId}`
  try {
    const existing = window.sessionStorage?.getItem(key)
    if (existing && existing.trim()) {
      return existing.trim()
    }
  } catch {
    // ignore sessionStorage access errors
  }

  const generated = createClientId()
  try {
    window.sessionStorage?.setItem(key, generated)
  } catch {
    // ignore sessionStorage access errors
  }
  return generated
}

function scanSensitiveTargets(): string[] {
  const result = new Set<string>()
  const nodes = document.querySelectorAll<HTMLElement>('[data-mcp-sensitive="true"]')
  for (const node of nodes) {
    const key = node.getAttribute('data-webmcp-key') ?? node.getAttribute('data-mcp-key')
    if (!key) continue
    const trimmed = key.trim()
    if (!trimmed) continue
    result.add(trimmed)
  }
  return Array.from(result)
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  payload: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const text = await res.text()
    const parsed = text ? (JSON.parse(text) as unknown) : {}
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    return parsed
  } finally {
    window.clearTimeout(timer)
  }
}

function setStatus(
  next: Partial<CompanionClientStatus>,
  onStatusChange?: (status: CompanionClientStatus) => void,
) {
  currentStatus = {
    ...currentStatus,
    ...next,
    updatedAt: Date.now(),
  }
  onStatusChange?.(currentStatus)
}

function toCompanionWsUrl(baseUrl: string, sessionId: string): string {
  const url = new URL('/page/ws', baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('sessionId', sessionId)
  return url.toString()
}

export function getWebMcpCompanionStatus(): CompanionClientStatus {
  return { ...currentStatus }
}

export function initializeWebMcpCompanionClient(
  options: InitializeWebMcpCompanionClientOptions,
): CompanionClientHandle {
  if (!options.appId || !options.appId.trim()) {
    throw new Error('appId is required')
  }

  activeHandle?.stop()

  const appId = options.appId.trim()
  const companionBaseUrl = (options.companionBaseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const fetchImpl = options.fetchImpl ?? fetch
  const onGuideRequired = options.onGuideRequired
  const onStatusChange = options.onStatusChange

  let stopped = false
  let inflight = false
  let sessionId: string | null = null
  const clientId = getOrCreateClientId(appId)
  const completedCalls: CompletedCall[] = []
  let guideNotified: GuideReason | null = null
  let socket: WebSocket | null = null
  let socketConnecting = false
  let socketOpenedOnce = false
  const supportsWebSocket =
    typeof window !== 'undefined' && typeof window.WebSocket === 'function'
  let webSocketEnabled = supportsWebSocket

  const emitGuide = (reason: GuideReason) => {
    if (guideNotified === reason) return
    guideNotified = reason
    onGuideRequired?.(reason)
  }

  const drainCompletedCalls = (): CompletedCall[] => {
    if (completedCalls.length === 0) return []
    const drained = completedCalls.splice(0, completedCalls.length)
    return drained
  }

  const processPendingCalls = async (calls: ServerPendingCall[], testingApi: TestingApi) => {
    for (const call of calls) {
      const callId = typeof call.callId === 'string' ? call.callId : ''
      const name = typeof call.name === 'string' ? call.name : ''
      const args =
        call.arguments && typeof call.arguments === 'object'
          ? (call.arguments as Record<string, unknown>)
          : {}

      if (!callId || !name) continue

      try {
        const raw = await testingApi.executeTool(name, JSON.stringify(args))
        const parsed = raw ? (JSON.parse(raw) as unknown) : { content: [] }
        completedCalls.push({
          callId,
          ok: true,
          result: parsed,
        })
      } catch (error) {
        completedCalls.push({
          callId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const applyServerStatus = (status: string | undefined, active: boolean) => {
    if (status === 'denied') {
      setStatus(
        {
          state: 'denied',
          companionBaseUrl,
          sessionId,
          active,
          lastError: null,
        },
        onStatusChange,
      )
      emitGuide('origin-denied')
      return
    }

    if (status === 'pending') {
      setStatus(
        {
          state: 'pending',
          companionBaseUrl,
          sessionId,
          active,
          lastError: null,
        },
        onStatusChange,
      )
      emitGuide('origin-pending')
      return
    }

    guideNotified = null
    setStatus(
      {
        state: active ? 'connected' : 'connecting',
        companionBaseUrl,
        sessionId,
        active,
        lastError: null,
      },
      onStatusChange,
    )
  }

  const closeSocket = () => {
    if (!socket) return
    const current = socket
    socket = null
    socketConnecting = false
    current.onopen = null
    current.onmessage = null
    current.onerror = null
    current.onclose = null
    try {
      current.close()
    } catch {
      // noop
    }
  }

  const sendSocketSync = (testingApi: TestingApi): boolean => {
    if (!socket || socket.readyState !== window.WebSocket.OPEN || !sessionId) {
      return false
    }

    try {
      socket.send(
        JSON.stringify({
          type: 'sync',
          tools: testingApi.listTools(),
          sensitiveTargetIds: scanSensitiveTargets(),
          completedCalls: drainCompletedCalls(),
          timestamp: Date.now(),
        }),
      )
      return true
    } catch {
      return false
    }
  }

  const ensureSession = async () => {
    if (sessionId) return

    setStatus(
      {
        state: 'connecting',
        companionBaseUrl,
        sessionId: null,
        active: false,
        lastError: null,
      },
      onStatusChange,
    )

    const connectRes = (await postJson(fetchImpl, `${companionBaseUrl}/page/connect`, {
      sessionId,
      clientId,
      appId,
      origin: window.location.origin,
      url: window.location.href,
      title: document.title,
      clientVersion: CLIENT_VERSION,
    })) as {
      sessionId?: string
      status?: string
      active?: boolean
    }

    if (typeof connectRes.sessionId !== 'string' || !connectRes.sessionId.trim()) {
      throw new Error('invalid sessionId from /page/connect')
    }
    sessionId = connectRes.sessionId
    applyServerStatus(connectRes.status, Boolean(connectRes.active))
  }

  const connectSocket = (testingApi: TestingApi) => {
    if (!webSocketEnabled || !sessionId || socket || socketConnecting || stopped) {
      return
    }

    socketConnecting = true
    const wsUrl = toCompanionWsUrl(companionBaseUrl, sessionId)
    const nextSocket = new window.WebSocket(wsUrl)

    nextSocket.onopen = () => {
      if (stopped) {
        try {
          nextSocket.close()
        } catch {
          // noop
        }
        return
      }

      socketConnecting = false
      socketOpenedOnce = true
      socket = nextSocket
      guideNotified = null
      void sendSocketSync(testingApi)
    }

    nextSocket.onmessage = event => {
      void (async () => {
        const raw =
          typeof event.data === 'string'
            ? event.data
            : event.data instanceof ArrayBuffer
              ? new TextDecoder().decode(event.data)
              : ''
        if (!raw) return

        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return
        }

        const message = parsed as ServerWsMessage
        if (typeof message.status === 'string') {
          applyServerStatus(message.status, Boolean(message.active))
        }

        if (message.type === 'error') {
          setStatus(
            {
              state: 'unavailable',
              companionBaseUrl,
              sessionId,
              active: false,
              lastError: message.message ?? 'websocket error',
            },
            onStatusChange,
          )
          emitGuide('companion-unavailable')
          return
        }

        if (!Array.isArray(message.pendingCalls) || message.pendingCalls.length === 0) {
          return
        }

        const runtimeTestingApi = getTestingApi()
        if (!runtimeTestingApi) {
          setStatus(
            {
              state: 'unavailable',
              companionBaseUrl,
              sessionId,
              active: false,
              lastError: 'navigator.modelContextTesting is unavailable',
            },
            onStatusChange,
          )
          emitGuide('model-context-testing-unavailable')
          return
        }

        await processPendingCalls(message.pendingCalls, runtimeTestingApi)
        if (completedCalls.length > 0) {
          void sendSocketSync(runtimeTestingApi)
        }
      })()
    }

    nextSocket.onerror = () => {
      // onclose에서 상태 전환 처리
    }

    nextSocket.onclose = event => {
      if (socket === nextSocket) {
        socket = null
      }
      socketConnecting = false

      if (event.code === 1008) {
        sessionId = null
      }

      if (!socketOpenedOnce) {
        // 구버전 companion 호환: websocket이 불가능하면 HTTP sync로 폴백
        webSocketEnabled = false
      }

      if (stopped) return
      setStatus(
        {
          state: webSocketEnabled ? 'connecting' : 'unavailable',
          companionBaseUrl,
          sessionId,
          active: false,
          lastError: event.reason || null,
        },
        onStatusChange,
      )
      if (!webSocketEnabled) {
        emitGuide('companion-unavailable')
      }
    }
  }

  const runHttpSync = async (testingApi: TestingApi) => {
    const syncRes = (await postJson(fetchImpl, `${companionBaseUrl}/page/sync`, {
      sessionId,
      tools: testingApi.listTools(),
      sensitiveTargetIds: scanSensitiveTargets(),
      completedCalls: drainCompletedCalls(),
      timestamp: Date.now(),
    })) as {
      status?: string
      active?: boolean
      pendingCalls?: ServerPendingCall[]
    }

    applyServerStatus(syncRes.status, Boolean(syncRes.active))
    if (Array.isArray(syncRes.pendingCalls) && syncRes.pendingCalls.length > 0) {
      await processPendingCalls(syncRes.pendingCalls, testingApi)
    }
  }

  const tick = async () => {
    if (stopped || inflight) return
    inflight = true

    try {
      const testingApi = getTestingApi()
      if (!testingApi) {
        setStatus(
          {
            state: 'unavailable',
            companionBaseUrl,
            sessionId,
            active: false,
            lastError: 'navigator.modelContextTesting is unavailable',
          },
          onStatusChange,
        )
        emitGuide('model-context-testing-unavailable')
        return
      }

      await ensureSession()

      if (webSocketEnabled) {
        connectSocket(testingApi)
        if (!sendSocketSync(testingApi)) {
          setStatus(
            {
              state: 'connecting',
              companionBaseUrl,
              sessionId,
              active: false,
              lastError: null,
            },
            onStatusChange,
          )
        }
      } else {
        await runHttpSync(testingApi)
      }
    } catch (error) {
      closeSocket()
      setStatus(
        {
          state: 'unavailable',
          companionBaseUrl,
          sessionId,
          active: false,
          lastError: error instanceof Error ? error.message : String(error),
        },
        onStatusChange,
      )
      emitGuide('companion-unavailable')
    } finally {
      inflight = false
    }
  }

  const timer = window.setInterval(() => {
    void tick()
  }, pollIntervalMs)

  const handle: CompanionClientHandle = {
    stop() {
      if (stopped) return
      stopped = true
      window.clearInterval(timer)
      closeSocket()
      setStatus(
        {
          state: 'stopped',
          companionBaseUrl,
          sessionId,
          active: false,
        },
        onStatusChange,
      )
    },
  }

  activeHandle = handle
  void tick()
  return handle
}
