import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  ensureCompanionHome,
  loadPersistedState,
  rotateAdminToken,
  resolveCompanionPaths,
  savePersistedState,
} from './state-store.js'
import { renderAdminHtml } from './admin-ui.js'
import type {
  ApprovalStatus,
  CompanionCallResult,
  CompanionConfirmationItem,
  CompanionLogEntry,
  CompanionPaths,
  CompanionPendingCall,
  CompanionServerHandle,
  CompanionServerOptions,
  CompanionSessionSnapshot,
  CompanionTool,
  PersistedState,
} from './types.js'

export type {
  ApprovalStatus,
  CompanionCallResult,
  CompanionConfirmationItem,
  CompanionLogEntry,
  CompanionPaths,
  CompanionPendingCall,
  CompanionServerHandle,
  CompanionServerOptions,
  CompanionSessionSnapshot,
  CompanionTool,
} from './types.js'

const VERSION = '0.1.0'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9333
const DEFAULT_MCP_PATH = '/mcp'
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000
const DEFAULT_CALL_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 800
const STALE_SESSION_GRACE_MULTIPLIER = 3
const WS_DISCONNECT_REMOVE_DELAY_MS = 2_000
const LOG_LIMIT = 400

interface CompanionRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

interface RpcErrorShape {
  code: number
  message: string
}

interface SessionRuntime {
  id: string
  clientId: string
  appId: string
  origin: string
  url: string
  title: string
  clientVersion: string
  connectedAt: number
  lastSeenAt: number
  approvalStatus: ApprovalStatus
  tools: CompanionTool[]
  sensitiveTargetIds: Set<string>
  outbox: Map<string, OutboxCall>
}

interface OutboxCall {
  callId: string
  name: string
  arguments: Record<string, unknown>
  requiresConfirm: boolean
  createdAt: number
  lastDispatchedAt?: number
}

interface PendingResolver {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  sessionId: string
}

interface PageConnectRequest {
  sessionId?: string
  clientId?: string
  appId?: string
  origin?: string
  url?: string
  title?: string
  clientVersion?: string
}

interface PageSyncRequest {
  sessionId?: string
  tools?: unknown
  sensitiveTargetIds?: unknown
  completedCalls?: unknown
}

interface PageWsMessage {
  type?: string
  tools?: unknown
  sensitiveTargetIds?: unknown
  completedCalls?: unknown
}

interface PageSyncResponse {
  status: ApprovalStatus
  active: boolean
  pendingCalls: CompanionPendingCall[]
}

interface AdminPostSessionActivate {
  sessionId?: string | null
}

interface AdminPostOrigin {
  origin?: string
}

interface AdminPostConfirmation {
  callId?: string
}

interface CompanionStatusPayload {
  version: string
  endpoint: string
  adminUrl: string
  tokenPath: string
  pidPath: string
  homeDir: string
  activeSessionId: string | null
  sessionCount: number
  approvals: Record<string, number>
}

class CompanionRpcError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

function toRpcError(id: string | number | null, code: number, message: string) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }
}

function toRpcResult(id: string | number | null, result: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  }
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function safeObject(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') return undefined
  return input as Record<string, unknown>
}

function sanitizeTools(input: unknown): CompanionTool[] {
  if (!Array.isArray(input)) return []
  const tools: CompanionTool[] = []
  for (const item of input) {
    const tool = safeObject(item)
    if (!tool) continue
    const name = typeof tool.name === 'string' ? tool.name.trim() : ''
    if (!name) continue
    const description = typeof tool.description === 'string' ? tool.description : 'No description'
    const inputSchema =
      tool.inputSchema && typeof tool.inputSchema === 'object'
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {}, additionalProperties: false }
    tools.push({ name, description, inputSchema })
  }
  return tools
}

function sanitizeSensitiveTargetIds(input: unknown): Set<string> {
  const result = new Set<string>()
  if (!Array.isArray(input)) return result
  for (const value of input) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    result.add(trimmed)
  }
  return result
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isSameOriginLoopback(origin: string): boolean {
  return origin === 'http://127.0.0.1' || origin === 'http://localhost'
}

export interface CompanionRuntimeInfo {
  paths: CompanionPaths
  endpoint: string
  adminUrl: string
  tokenPath: string
}

export function getCompanionRuntimeInfo(options: CompanionServerOptions = {}): CompanionRuntimeInfo {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  const paths = resolveCompanionPaths(options.homeDir)
  return {
    paths,
    endpoint: `http://${host}:${port}${options.mcpPath ?? DEFAULT_MCP_PATH}`,
    adminUrl: `http://${host}:${port}/admin`,
    tokenPath: paths.tokenPath,
  }
}

export async function startCompanionServer(
  options: CompanionServerOptions = {},
): Promise<CompanionServerHandle> {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  const mcpPath = options.mcpPath ?? DEFAULT_MCP_PATH
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const staleSessionTimeoutMs = Math.max(
    heartbeatTimeoutMs * STALE_SESSION_GRACE_MULTIPLIER,
    pollIntervalMs * STALE_SESSION_GRACE_MULTIPLIER,
  )
  const logger = options.logger ?? ((message: string) => console.error(`[companion] ${message}`))

  const paths = resolveCompanionPaths(options.homeDir)
  ensureCompanionHome(paths)
  const adminToken = rotateAdminToken(paths)
  const persisted: PersistedState = loadPersistedState(paths)

  const sessions = new Map<string, SessionRuntime>()
  const sessionByClient = new Map<string, string>()
  const sessionSockets = new Map<string, WebSocket>()
  const disconnectedSessionTimers = new Map<string, NodeJS.Timeout>()
  const pendingResolvers = new Map<string, PendingResolver>()
  const confirmations = new Map<string, CompanionConfirmationItem>()
  const logs: CompanionLogEntry[] = []
  let nextLogId = 1

  const addLog = (
    kind: CompanionLogEntry['kind'],
    message: string,
    meta?: unknown,
    forceConsoleError = false,
  ) => {
    logs.unshift({
      id: nextLogId,
      at: Date.now(),
      kind,
      message,
      meta,
    })
    nextLogId += 1
    if (logs.length > LOG_LIMIT) {
      logs.length = LOG_LIMIT
    }
    if (kind === 'error' || forceConsoleError) {
      logger(`${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`)
    }
  }

  const persistState = () => {
    savePersistedState(paths, persisted)
  }

  const ensureApprovalTracked = (origin: string): ApprovalStatus => {
    const known = persisted.approvals[origin]
    if (known) return known
    persisted.approvals[origin] = 'pending'
    persistState()
    addLog('system', 'origin added to pending approvals', { origin })
    return 'pending'
  }

  const isSessionStale = (session: SessionRuntime, now = Date.now()): boolean =>
    now - session.lastSeenAt > staleSessionTimeoutMs

  const chooseFallbackActiveSession = (): string | null => {
    const approvedSessions = Array.from(sessions.values())
      .filter(session => session.approvalStatus === 'approved' && !isSessionStale(session))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    return approvedSessions[0]?.id ?? null
  }

  const setActiveSession = (sessionId: string | null): void => {
    persisted.activeSessionId = sessionId
    persistState()
    addLog('admin', 'active session updated', { sessionId })
    pushStatusUpdates()
  }

  const isSessionActive = (session: SessionRuntime): boolean =>
    persisted.activeSessionId === session.id && session.approvalStatus === 'approved'

  const collectPendingCalls = (session: SessionRuntime): CompanionPendingCall[] => {
    if (!isSessionActive(session)) return []
    const pendingCalls: CompanionPendingCall[] = []
    const now = Date.now()
    for (const call of session.outbox.values()) {
      if (!call.lastDispatchedAt || now - call.lastDispatchedAt > 1500) {
        call.lastDispatchedAt = now
        pendingCalls.push({
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
          requiresConfirm: call.requiresConfirm,
        })
      }
    }
    return pendingCalls
  }

  const sendSocketPayload = (socket: WebSocket, payload: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(payload))
    } catch (error) {
      addLog('error', 'failed to send websocket payload', {
        error: stringifyError(error),
      })
    }
  }

  const sendSessionSyncResult = (session: SessionRuntime): void => {
    const socket = sessionSockets.get(session.id)
    if (!socket) return
    sendSocketPayload(socket, {
      type: 'syncResult',
      status: session.approvalStatus,
      active: isSessionActive(session),
      pendingCalls: collectPendingCalls(session),
    } satisfies PageSyncResponse & { type: string })
  }

  const pushStatusUpdates = (): void => {
    for (const session of sessions.values()) {
      const socket = sessionSockets.get(session.id)
      if (!socket) continue
      sendSocketPayload(socket, {
        type: 'status',
        status: session.approvalStatus,
        active: isSessionActive(session),
      })
      if (isSessionActive(session)) {
        const pendingCalls = collectPendingCalls(session)
        if (pendingCalls.length > 0) {
          sendSocketPayload(socket, {
            type: 'pendingCalls',
            status: session.approvalStatus,
            active: true,
            pendingCalls,
          })
        }
      }
    }
  }

  const removeSession = (sessionId: string, reason: string): boolean => {
    const session = sessions.get(sessionId)
    if (!session) return false

    const disconnectedTimer = disconnectedSessionTimers.get(sessionId)
    if (disconnectedTimer) {
      clearTimeout(disconnectedTimer)
      disconnectedSessionTimers.delete(sessionId)
    }

    sessions.delete(sessionId)
    if (sessionByClient.get(session.clientId) === sessionId) {
      sessionByClient.delete(session.clientId)
    }

    for (const [callId, pending] of Array.from(pendingResolvers.entries())) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timer)
      pendingResolvers.delete(callId)
      pending.reject(new Error(reason))
    }

    for (const [callId, confirmation] of Array.from(confirmations.entries())) {
      if (confirmation.sessionId === sessionId) {
        confirmations.delete(callId)
      }
    }

    const socket = sessionSockets.get(sessionId)
    if (socket) {
      sessionSockets.delete(sessionId)
      try {
        socket.close(1000, reason.slice(0, 120))
      } catch {
        // noop
      }
    }

    if (persisted.activeSessionId === sessionId) {
      setActiveSession(chooseFallbackActiveSession())
    }

    addLog('system', 'session removed', {
      sessionId,
      clientId: session.clientId,
      origin: session.origin,
      reason,
    })

    return true
  }

  const scheduleDisconnectedSessionRemoval = (sessionId: string): void => {
    const existingTimer = disconnectedSessionTimers.get(sessionId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(() => {
      disconnectedSessionTimers.delete(sessionId)
      if (sessionSockets.has(sessionId)) return
      removeSession(sessionId, 'session websocket disconnected')
    }, WS_DISCONNECT_REMOVE_DELAY_MS)

    disconnectedSessionTimers.set(sessionId, timer)
  }

  const pruneExpiredSessions = (now = Date.now(), preserveSessionId?: string): void => {
    for (const session of Array.from(sessions.values())) {
      if (preserveSessionId && session.id === preserveSessionId) continue
      if (isSessionStale(session, now)) {
        removeSession(session.id, 'session heartbeat expired')
      }
    }
  }

  const applyOriginApproval = (origin: string, status: ApprovalStatus): void => {
    persisted.approvals[origin] = status
    persistState()
    for (const session of sessions.values()) {
      if (session.origin === origin) {
        session.approvalStatus = status
      }
    }

    const activeSession = persisted.activeSessionId ? sessions.get(persisted.activeSessionId) : null
    if (!activeSession || activeSession.approvalStatus !== 'approved') {
      setActiveSession(chooseFallbackActiveSession())
    }
    addLog('admin', 'origin approval updated', { origin, status })
    pushStatusUpdates()
  }

  const toSessionSnapshot = (session: SessionRuntime): CompanionSessionSnapshot => ({
    id: session.id,
    appId: session.appId,
    origin: session.origin,
    url: session.url,
    title: session.title,
    clientVersion: session.clientVersion,
    connectedAt: session.connectedAt,
    lastSeenAt: session.lastSeenAt,
    approvalStatus: session.approvalStatus,
    active: persisted.activeSessionId === session.id,
    toolCount: session.tools.length,
    sensitiveTargetCount: session.sensitiveTargetIds.size,
    pendingCallCount: session.outbox.size,
  })

  const getActiveApprovedSession = (): SessionRuntime => {
    const activeId = persisted.activeSessionId
    if (!activeId) {
      throw new CompanionRpcError(-32001, '활성 세션이 없습니다.')
    }
    const session = sessions.get(activeId)
    if (!session) {
      throw new CompanionRpcError(-32001, '활성 세션이 존재하지 않습니다.')
    }
    if (session.approvalStatus !== 'approved') {
      throw new CompanionRpcError(-32001, '활성 세션 origin이 승인되지 않았습니다.')
    }
    if (Date.now() - session.lastSeenAt > heartbeatTimeoutMs) {
      throw new CompanionRpcError(-32003, '활성 세션 heartbeat가 만료되었습니다.')
    }
    return session
  }

  const queueCallForSession = (
    session: SessionRuntime,
    name: string,
    args: Record<string, unknown>,
    requiresConfirm: boolean,
  ): Promise<unknown> => {
    const callId = randomUUID()
    const outboxCall: OutboxCall = {
      callId,
      name,
      arguments: args,
      requiresConfirm,
      createdAt: Date.now(),
    }

    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingResolvers.delete(callId)
        session.outbox.delete(callId)
        confirmations.delete(callId)
        reject(new Error('tools/call timed out'))
      }, callTimeoutMs)
      pendingResolvers.set(callId, { resolve, reject, timer, sessionId: session.id })
    })

    if (requiresConfirm) {
      confirmations.set(callId, {
        callId,
        sessionId: session.id,
        toolName: name,
        arguments: args,
        createdAt: Date.now(),
      })
      addLog('mcp', 'call queued for confirmation', { callId, sessionId: session.id, name })
    } else {
      session.outbox.set(callId, outboxCall)
      addLog('mcp', 'call queued', { callId, sessionId: session.id, name })
      sendSessionSyncResult(session)
    }

    return resultPromise
  }

  const tryApproveConfirmation = (callId: string): boolean => {
    const confirmation = confirmations.get(callId)
    if (!confirmation) return false
    const session = sessions.get(confirmation.sessionId)
    if (!session) {
      confirmations.delete(callId)
      const pending = pendingResolvers.get(callId)
      if (pending) {
        clearTimeout(pending.timer)
        pendingResolvers.delete(callId)
        pending.reject(new Error('session not found'))
      }
      return false
    }

    confirmations.delete(callId)
    session.outbox.set(callId, {
      callId,
      name: confirmation.toolName,
      arguments: confirmation.arguments,
      requiresConfirm: true,
      createdAt: confirmation.createdAt,
    })
    addLog('admin', 'confirmation approved', { callId })
    sendSessionSyncResult(session)
    return true
  }

  const rejectConfirmation = (callId: string, reason: string): boolean => {
    const confirmation = confirmations.get(callId)
    if (!confirmation) return false
    confirmations.delete(callId)
    const pending = pendingResolvers.get(callId)
    if (pending) {
      clearTimeout(pending.timer)
      pendingResolvers.delete(callId)
      pending.reject(new Error(reason))
    }
    addLog('admin', 'confirmation rejected', { callId, reason })
    return true
  }

  const applyPageSyncPayload = (session: SessionRuntime, payload: PageSyncRequest): void => {
    session.lastSeenAt = Date.now()
    session.approvalStatus = persisted.approvals[session.origin] ?? ensureApprovalTracked(session.origin)
    session.tools = sanitizeTools(payload.tools)
    session.sensitiveTargetIds = sanitizeSensitiveTargetIds(payload.sensitiveTargetIds)

    if (!Array.isArray(payload.completedCalls)) return
    for (const item of payload.completedCalls) {
      const result = safeObject(item) as CompanionCallResult | undefined
      if (!result || typeof result.callId !== 'string') continue
      const pending = pendingResolvers.get(result.callId)
      if (!pending) continue
      clearTimeout(pending.timer)
      pendingResolvers.delete(result.callId)
      session.outbox.delete(result.callId)
      confirmations.delete(result.callId)
      if (result.ok) {
        pending.resolve(
          result.result ?? {
            content: [{ type: 'text', text: 'ok' }],
          },
        )
      } else {
        pending.reject(new Error(result.error ?? 'tool call failed'))
      }
    }
  }

  const buildPageSyncResponse = (session: SessionRuntime): PageSyncResponse => ({
    status: session.approvalStatus,
    active: isSessionActive(session),
    pendingCalls: collectPendingCalls(session),
  })

  const listOrigins = (): Array<{ origin: string; status: ApprovalStatus }> =>
    Object.entries(persisted.approvals)
      .map(([origin, status]) => ({ origin, status }))
      .sort((a, b) => a.origin.localeCompare(b.origin))

  const isAdminAuthorized = (req: http.IncomingMessage, url: URL, forUiPage: boolean): boolean => {
    const headerToken = req.headers['x-webmcp-admin-token']
    const queryToken = url.searchParams.get('token')
    if (forUiPage) {
      return queryToken === adminToken
    }
    if (typeof headerToken === 'string') {
      return headerToken === adminToken
    }
    return false
  }

  const withPageCors = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.startsWith('http')) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
    } else {
      res.setHeader('access-control-allow-origin', '*')
    }
    res.setHeader('access-control-allow-headers', 'content-type')
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
  }

  const handlePageConnect = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    withPageCors(req, res)
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'Method Not Allowed' })
      return
    }

    const body = parseJson(await readBody(req))
    const payload = safeObject(body) as PageConnectRequest | undefined
    if (!payload) {
      writeJson(res, 400, { error: 'Invalid JSON body' })
      return
    }

    const appId = typeof payload.appId === 'string' ? payload.appId.trim() : ''
    const origin = typeof payload.origin === 'string' ? payload.origin.trim() : ''
    const url = typeof payload.url === 'string' ? payload.url.trim() : ''
    const title = typeof payload.title === 'string' ? payload.title.trim() : ''
    const clientVersion =
      typeof payload.clientVersion === 'string' ? payload.clientVersion.trim() : 'unknown'
    const clientId = typeof payload.clientId === 'string' ? payload.clientId.trim() : ''
    const requestedSessionId =
      typeof payload.sessionId === 'string' ? payload.sessionId.trim() : undefined

    if (!appId || !origin || !clientId) {
      writeJson(res, 400, { error: 'appId, origin, clientId are required' })
      return
    }

    pruneExpiredSessions()

    const approval = ensureApprovalTracked(origin)

    let sessionId = requestedSessionId
    if (!sessionId || !sessions.has(sessionId)) {
      sessionId = sessionByClient.get(clientId) ?? randomUUID()
    }

    const now = Date.now()
    const existing = sessions.get(sessionId)
    const session: SessionRuntime = existing ?? {
      id: sessionId,
      clientId,
      appId,
      origin,
      url,
      title,
      clientVersion,
      connectedAt: now,
      lastSeenAt: now,
      approvalStatus: approval,
      tools: [],
      sensitiveTargetIds: new Set<string>(),
      outbox: new Map<string, OutboxCall>(),
    }

    session.clientId = clientId
    session.appId = appId
    session.origin = origin
    session.url = url
    session.title = title
    session.clientVersion = clientVersion || 'unknown'
    session.lastSeenAt = now
    session.approvalStatus = persisted.approvals[origin] ?? approval

    sessions.set(session.id, session)
    sessionByClient.set(clientId, session.id)

    if (session.approvalStatus === 'approved' && !persisted.activeSessionId) {
      setActiveSession(session.id)
    }

    addLog('page', 'session connected', {
      sessionId: session.id,
      appId,
      origin,
      approval: session.approvalStatus,
    })

    writeJson(res, 200, {
      sessionId: session.id,
      status: session.approvalStatus,
      active: persisted.activeSessionId === session.id,
      pollIntervalMs,
    })
  }

  const handlePageSync = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    withPageCors(req, res)
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'Method Not Allowed' })
      return
    }

    const body = parseJson(await readBody(req))
    const payload = safeObject(body) as PageSyncRequest | undefined
    if (!payload) {
      writeJson(res, 400, { error: 'Invalid JSON body' })
      return
    }

    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    pruneExpiredSessions(Date.now(), sessionId)
    const session = sessions.get(sessionId)
    if (!session) {
      writeJson(res, 404, { error: 'Unknown sessionId' })
      return
    }
    applyPageSyncPayload(session, payload)
    writeJson(res, 200, buildPageSyncResponse(session))
  }

  const handleMcp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'Method Not Allowed' })
      return
    }

    const body = parseJson(await readBody(req))
    const request = safeObject(body) as CompanionRpcMessage | undefined
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      writeJson(res, 400, toRpcError(null, -32600, 'Invalid Request'))
      return
    }

    const id = request.id ?? null

    pruneExpiredSessions()

    if (request.id === undefined || request.id === null) {
      writeJson(res, 202, { accepted: true })
      return
    }

    try {
      let result: unknown
      if (request.method === 'initialize') {
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'webmcp-companion', version: VERSION },
        }
      } else if (request.method === 'ping') {
        result = {}
      } else if (request.method === 'resources/list') {
        result = {
          resources: [],
        }
      } else if (request.method === 'resources/templates/list') {
        result = {
          resourceTemplates: [],
        }
      } else if (request.method === 'tools/list') {
        try {
          const session = getActiveApprovedSession()
          result = {
            tools: session.tools,
          }
          addLog('mcp', 'tools/list', { sessionId: session.id, toolCount: session.tools.length })
        } catch (error) {
          if (error instanceof CompanionRpcError && (error.code === -32001 || error.code === -32003)) {
            result = {
              tools: [],
            }
            addLog('mcp', 'tools/list empty', { reason: error.message, code: error.code })
          } else {
            throw error
          }
        }
      } else if (request.method === 'tools/call') {
        const params = safeObject(request.params)
        const toolName = typeof params?.name === 'string' ? params.name.trim() : ''
        if (!toolName) {
          throw new CompanionRpcError(-32602, 'Invalid params: name')
        }

        const argsRaw = safeObject(params?.arguments)
        const args = argsRaw ?? {}
        const session = getActiveApprovedSession()
        const target = typeof args.target === 'string' ? args.target : ''
        const requiresConfirm = Boolean(target && session.sensitiveTargetIds.has(target))
        const callResult = await queueCallForSession(session, toolName, args, requiresConfirm)
        result = callResult
        addLog('mcp', 'tools/call completed', {
          sessionId: session.id,
          toolName,
          requiresConfirm,
        })
      } else {
        throw new CompanionRpcError(-32601, `Method not found: ${request.method}`)
      }

      writeJson(res, 200, toRpcResult(id, result))
    } catch (error) {
      const rpcError =
        error instanceof CompanionRpcError
          ? error
          : new CompanionRpcError(-32000, stringifyError(error))
      addLog('error', 'mcp request failed', {
        method: request.method,
        code: rpcError.code,
        message: rpcError.message,
      })
      writeJson(res, 200, toRpcError(id, rpcError.code, rpcError.message))
    }
  }

  const handleAdminApi = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    if (!isAdminAuthorized(req, url, false)) {
      writeJson(res, 401, { error: 'Unauthorized' })
      return
    }

    pruneExpiredSessions()

    const pathname = url.pathname

    if (req.method === 'GET' && pathname === '/admin/api/status') {
      const approvalCounts = {
        approved: 0,
        pending: 0,
        denied: 0,
      }
      for (const status of Object.values(persisted.approvals)) {
        approvalCounts[status] += 1
      }

      const payload: CompanionStatusPayload = {
        version: VERSION,
        endpoint: `http://${host}:${port}${mcpPath}`,
        adminUrl: `http://${host}:${port}/admin`,
        tokenPath: paths.tokenPath,
        pidPath: paths.pidPath,
        homeDir: paths.homeDir,
        activeSessionId: persisted.activeSessionId,
        sessionCount: sessions.size,
        approvals: approvalCounts,
      }
      writeJson(res, 200, payload)
      return
    }

    if (req.method === 'GET' && pathname === '/admin/api/sessions') {
      const entries = Array.from(sessions.values())
        .map(toSessionSnapshot)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      writeJson(res, 200, { sessions: entries })
      return
    }

    if (req.method === 'POST' && pathname === '/admin/api/sessions/activate') {
      const payload = safeObject(parseJson(await readBody(req))) as AdminPostSessionActivate | undefined
      const sessionId =
        payload?.sessionId === null
          ? null
          : typeof payload?.sessionId === 'string'
            ? payload.sessionId
            : undefined
      if (sessionId === undefined) {
        writeJson(res, 400, { error: 'sessionId must be string or null' })
        return
      }
      if (sessionId && !sessions.has(sessionId)) {
        writeJson(res, 404, { error: 'session not found' })
        return
      }
      if (sessionId && sessions.get(sessionId)?.approvalStatus !== 'approved') {
        writeJson(res, 400, { error: 'session origin is not approved' })
        return
      }
      setActiveSession(sessionId)
      writeJson(res, 200, { ok: true, activeSessionId: persisted.activeSessionId })
      return
    }

    if (req.method === 'GET' && pathname === '/admin/api/origins') {
      writeJson(res, 200, { origins: listOrigins() })
      return
    }

    if (req.method === 'POST' && pathname === '/admin/api/origins/approve') {
      const payload = safeObject(parseJson(await readBody(req))) as AdminPostOrigin | undefined
      const origin = typeof payload?.origin === 'string' ? payload.origin.trim() : ''
      if (!origin) {
        writeJson(res, 400, { error: 'origin is required' })
        return
      }
      applyOriginApproval(origin, 'approved')
      if (!persisted.activeSessionId) {
        setActiveSession(chooseFallbackActiveSession())
      }
      writeJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && pathname === '/admin/api/origins/revoke') {
      const payload = safeObject(parseJson(await readBody(req))) as AdminPostOrigin | undefined
      const origin = typeof payload?.origin === 'string' ? payload.origin.trim() : ''
      if (!origin) {
        writeJson(res, 400, { error: 'origin is required' })
        return
      }
      applyOriginApproval(origin, 'pending')
      writeJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && pathname === '/admin/api/logs') {
      const limitRaw = Number(url.searchParams.get('limit') ?? 100)
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 300) : 100
      writeJson(res, 200, { logs: logs.slice(0, limit) })
      return
    }

    if (req.method === 'GET' && pathname === '/admin/api/confirmations') {
      writeJson(res, 200, {
        confirmations: Array.from(confirmations.values()).sort((a, b) => b.createdAt - a.createdAt),
      })
      return
    }

    if (req.method === 'POST' && pathname === '/admin/api/confirmations/approve') {
      const payload = safeObject(parseJson(await readBody(req))) as AdminPostConfirmation | undefined
      const callId = typeof payload?.callId === 'string' ? payload.callId.trim() : ''
      if (!callId) {
        writeJson(res, 400, { error: 'callId is required' })
        return
      }
      if (!tryApproveConfirmation(callId)) {
        writeJson(res, 404, { error: 'confirmation not found' })
        return
      }
      writeJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && pathname === '/admin/api/confirmations/reject') {
      const payload = safeObject(parseJson(await readBody(req))) as AdminPostConfirmation | undefined
      const callId = typeof payload?.callId === 'string' ? payload.callId.trim() : ''
      if (!callId) {
        writeJson(res, 400, { error: 'callId is required' })
        return
      }
      if (!rejectConfirmation(callId, 'call rejected by admin')) {
        writeJson(res, 404, { error: 'confirmation not found' })
        return
      }
      writeJson(res, 200, { ok: true })
      return
    }

    writeJson(res, 404, { error: 'Not found' })
  }

  const pageWsServer = new WebSocketServer({ noServer: true })

  const handlePageWsSync = (sessionId: string, payload: PageWsMessage, socket: WebSocket): void => {
    pruneExpiredSessions(Date.now(), sessionId)
    const session = sessions.get(sessionId)
    if (!session) {
      sendSocketPayload(socket, {
        type: 'error',
        code: 'unknown_session',
        message: 'Unknown sessionId',
      })
      try {
        socket.close(1008, 'unknown session')
      } catch {
        // noop
      }
      return
    }

    applyPageSyncPayload(session, {
      tools: payload.tools,
      sensitiveTargetIds: payload.sensitiveTargetIds,
      completedCalls: payload.completedCalls,
    })
    sendSocketPayload(socket, {
      type: 'syncResult',
      ...buildPageSyncResponse(session),
    })
  }

  pageWsServer.on('connection', (socket: WebSocket, req: http.IncomingMessage) => {
    const wsUrl = new URL(req.url ?? '/', `http://${host}:${port}`)
    const sessionId = wsUrl.searchParams.get('sessionId')?.trim() ?? ''
    if (!sessionId) {
      socket.close(1008, 'sessionId required')
      return
    }

    pruneExpiredSessions(Date.now(), sessionId)
    const session = sessions.get(sessionId)
    if (!session) {
      socket.close(1008, 'unknown session')
      return
    }

    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : ''
    if (originHeader && originHeader !== session.origin && !isSameOriginLoopback(originHeader)) {
      socket.close(1008, 'origin mismatch')
      return
    }

    const previousSocket = sessionSockets.get(sessionId)
    if (previousSocket && previousSocket !== socket) {
      try {
        previousSocket.close(1000, 'replaced by newer connection')
      } catch {
        // noop
      }
    }

    const disconnectedTimer = disconnectedSessionTimers.get(sessionId)
    if (disconnectedTimer) {
      clearTimeout(disconnectedTimer)
      disconnectedSessionTimers.delete(sessionId)
    }

    sessionSockets.set(sessionId, socket)
    session.lastSeenAt = Date.now()
    addLog('page', 'session websocket connected', { sessionId })
    sendSessionSyncResult(session)

    socket.on('message', (raw: Buffer | Buffer[] | ArrayBuffer | string) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8')
      const parsed = parseJson(text)
      const payload = safeObject(parsed) as PageWsMessage | undefined
      if (!payload) {
        sendSocketPayload(socket, {
          type: 'error',
          code: 'invalid_payload',
          message: 'Invalid websocket payload',
        })
        return
      }

      const type = typeof payload.type === 'string' ? payload.type : 'sync'
      if (type === 'sync') {
        handlePageWsSync(sessionId, payload, socket)
        return
      }

      if (type === 'ping') {
        sendSocketPayload(socket, { type: 'pong' })
        return
      }

      sendSocketPayload(socket, {
        type: 'error',
        code: 'unsupported_message_type',
        message: `Unsupported message type: ${type}`,
      })
    })

    socket.on('close', () => {
      if (sessionSockets.get(sessionId) === socket) {
        sessionSockets.delete(sessionId)
        scheduleDisconnectedSessionRemoval(sessionId)
      }
      addLog('page', 'session websocket disconnected', { sessionId })
    })

    socket.on('error', (error: Error) => {
      addLog('error', 'session websocket error', {
        sessionId,
        error: stringifyError(error),
      })
    })
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)
    const pathname = url.pathname

    try {
      if (pathname === '/page/connect' || pathname === '/page/sync') {
        if (pathname === '/page/connect') {
          await handlePageConnect(req, res)
        } else {
          await handlePageSync(req, res)
        }
        return
      }

      if (pathname === mcpPath) {
        await handleMcp(req, res)
        return
      }

      if (pathname === '/admin') {
        if (!isAdminAuthorized(req, url, true)) {
          res.statusCode = 401
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end('Unauthorized. Use /admin?token=<admin-token>')
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(renderAdminHtml())
        return
      }

      if (pathname.startsWith('/admin/api/')) {
        await handleAdminApi(req, res, url)
        return
      }

      if (pathname === '/healthz') {
        writeJson(res, 200, { ok: true, version: VERSION })
        return
      }

      writeJson(res, 404, { error: 'Not found' })
    } catch (error) {
      addLog('error', 'unhandled request error', { error: stringifyError(error) }, true)
      writeJson(res, 500, { error: 'Internal Server Error' })
    }
  })

  server.on('upgrade', (req, socket, head) => {
    try {
      const upgradeUrl = new URL(req.url ?? '/', `http://${host}:${port}`)
      if (upgradeUrl.pathname !== '/page/ws') {
        socket.destroy()
        return
      }
      pageWsServer.handleUpgrade(req, socket, head, (upgradedSocket: WebSocket) => {
        pageWsServer.emit('connection', upgradedSocket, req)
      })
    } catch {
      socket.destroy()
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  addLog('system', 'companion started', {
    host,
    port,
    mcpPath,
    homeDir: paths.homeDir,
  })

  return {
    endpoint: `http://${host}:${port}${mcpPath}`,
    adminUrl: `http://${host}:${port}/admin`,
    adminToken,
    paths,
    async close() {
      for (const timer of disconnectedSessionTimers.values()) {
        clearTimeout(timer)
      }
      disconnectedSessionTimers.clear()

      for (const socket of sessionSockets.values()) {
        try {
          socket.close(1000, 'companion closing')
        } catch {
          // noop
        }
      }
      sessionSockets.clear()

      for (const [callId, pending] of pendingResolvers.entries()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('companion closed'))
        pendingResolvers.delete(callId)
      }
      await new Promise<void>(resolve => {
        pageWsServer.close(() => resolve())
      })
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}
