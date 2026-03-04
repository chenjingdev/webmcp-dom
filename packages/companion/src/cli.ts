import {
  ensureAdminToken,
  isProcessRunning,
  loadPersistedState,
  readPid,
  removePid,
  resolveCompanionPaths,
  writePid,
} from './state-store.js'
import { getCompanionRuntimeInfo, startCompanionServer } from './index.js'
import type { CompanionServerOptions } from './types.js'

type CliCommand = 'start' | 'status' | 'stop'

function getCommand(raw: string | undefined): CliCommand {
  if (raw === 'start' || raw === 'status' || raw === 'stop') {
    return raw
  }
  return 'start'
}

function readOptionsFromEnv(): CompanionServerOptions {
  const portRaw = process.env.WEBMCP_COMPANION_PORT
  let port: number | undefined

  if (portRaw) {
    const parsed = Number(portRaw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('WEBMCP_COMPANION_PORT must be a positive number')
    }
    port = parsed
  }

  return {
    host: process.env.WEBMCP_COMPANION_HOST,
    port,
    mcpPath: process.env.WEBMCP_COMPANION_MCP_PATH,
    homeDir: process.env.WEBMCP_COMPANION_HOME,
  }
}

async function runStart(options: CompanionServerOptions): Promise<void> {
  const info = getCompanionRuntimeInfo(options)
  const existingPid = readPid(info.paths)
  if (existingPid && isProcessRunning(existingPid)) {
    console.error(`[companion] already running (pid=${existingPid})`)
    process.exit(1)
  }
  if (existingPid) {
    removePid(info.paths)
  }

  const handle = await startCompanionServer(options)
  writePid(handle.paths, process.pid)

  console.error(`[companion] endpoint: ${handle.endpoint}`)
  console.error(`[companion] admin: ${handle.adminUrl}?token=${handle.adminToken}`)
  console.error(`[companion] token path: ${handle.paths.tokenPath}`)
  console.error(`[companion] pid path: ${handle.paths.pidPath}`)

  const shutdown = async (signal: string) => {
    console.error(`[companion] ${signal} received, shutting down...`)
    try {
      await handle.close()
    } finally {
      removePid(handle.paths)
      process.exit(0)
    }
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
}

function runStatus(options: CompanionServerOptions): void {
  const info = getCompanionRuntimeInfo(options)
  const token = ensureAdminToken(info.paths)
  const state = loadPersistedState(info.paths)
  const pid = readPid(info.paths)
  const running = Boolean(pid && isProcessRunning(pid))

  console.log(
    JSON.stringify(
      {
        running,
        pid: running ? pid : null,
        endpoint: info.endpoint,
        adminUrl: `${info.adminUrl}?token=${token}`,
        tokenPath: info.paths.tokenPath,
        pidPath: info.paths.pidPath,
        homeDir: info.paths.homeDir,
        activeSessionId: state.activeSessionId,
        approvals: state.approvals,
      },
      null,
      2,
    ),
  )
}

function runStop(options: CompanionServerOptions): void {
  const info = getCompanionRuntimeInfo(options)
  const pid = readPid(info.paths)
  if (!pid) {
    console.error('[companion] no pid file')
    return
  }

  if (!isProcessRunning(pid)) {
    console.error(`[companion] stale pid (${pid}), cleaning up`)
    removePid(info.paths)
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
    console.error(`[companion] sent SIGTERM to pid=${pid}`)
  } catch (error) {
    console.error(`[companion] failed to stop pid=${pid}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const command = getCommand(process.argv[2])
const options = readOptionsFromEnv()

if (command === 'status') {
  runStatus(options)
} else if (command === 'stop') {
  runStop(options)
} else {
  await runStart(options)
}
