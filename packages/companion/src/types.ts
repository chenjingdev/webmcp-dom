export type ApprovalStatus = 'pending' | 'approved' | 'denied'

export interface CompanionTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface CompanionCallResult {
  callId: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface CompanionPendingCall {
  callId: string
  name: string
  arguments: Record<string, unknown>
  requiresConfirm: boolean
}

export interface CompanionSessionSnapshot {
  id: string
  appId: string
  origin: string
  url: string
  title: string
  clientVersion: string
  connectedAt: number
  lastSeenAt: number
  approvalStatus: ApprovalStatus
  active: boolean
  toolCount: number
  sensitiveTargetCount: number
  pendingCallCount: number
}

export interface CompanionLogEntry {
  id: number
  at: number
  kind: 'system' | 'mcp' | 'page' | 'admin' | 'error'
  message: string
  meta?: unknown
}

export interface CompanionConfirmationItem {
  callId: string
  sessionId: string
  toolName: string
  arguments: Record<string, unknown>
  createdAt: number
}

export interface PersistedState {
  approvals: Record<string, ApprovalStatus>
  activeSessionId: string | null
}

export interface CompanionPaths {
  homeDir: string
  statePath: string
  tokenPath: string
  pidPath: string
}

export interface CompanionServerOptions {
  host?: string
  port?: number
  mcpPath?: string
  homeDir?: string
  heartbeatTimeoutMs?: number
  callTimeoutMs?: number
  pollIntervalMs?: number
  logger?: (message: string) => void
}

export interface CompanionServerHandle {
  endpoint: string
  adminUrl: string
  adminToken: string
  paths: CompanionPaths
  close: () => Promise<void>
}
