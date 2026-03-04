import { createUnplugin } from 'unplugin'
import picomatch from 'picomatch'
import fg from 'fast-glob'
import { promises as fs, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type {
  WebMcpCompiledTarget,
  WebMcpDiagnostic,
  WebMcpGroupEntry,
  WebMcpManifest,
  WebMcpToolEntry,
} from '../types'
import type { WebMcpDomPluginOptions } from '../types'
import { compileSource } from './compiler'
import { toGroupToolName, toPerElementToolName } from './helpers'
import { resolveOptions } from './options'
import { createViteHmrBridge } from './vite-hmr'

const VIRTUAL_MANIFEST_ID = 'virtual:webmcp-dom/manifest'
const COMPAT_MANIFEST_ID = 'webmcp-dom/manifest'
const PACKAGE_MANIFEST_ID = '@webmcp-dom/build-core/manifest'
const RESOLVED_VIRTUAL_MANIFEST_ID = 'webmcp-dom:manifest'

function formatDiagnostic(diag: WebMcpDiagnostic): string {
  return `${diag.file}:${diag.line}:${diag.column} [${diag.code}] ${diag.message}`
}

interface ToolBucket {
  groupId: string
  groupName?: string
  groupDesc?: string
  action: string
  toolNameOverride?: string
  toolDescOverride?: string
  targets: WebMcpCompiledTarget['target'][]
  hasActive: boolean
}

function toManifest(entries: WebMcpCompiledTarget[], options: ReturnType<typeof resolveOptions>): WebMcpManifest {
  const buckets = new Map<string, ToolBucket>()

  for (const entry of entries) {
    const key = `${entry.groupId}::${entry.action}`
    const bucket = buckets.get(key)
    if (!bucket) {
      buckets.set(key, {
        groupId: entry.groupId,
        groupName: entry.groupName,
        groupDesc: entry.groupDesc,
        action: entry.action,
        toolNameOverride: entry.toolNameOverride,
        toolDescOverride: entry.toolDescOverride,
        targets: [entry.target],
        hasActive: entry.status === 'active',
      })
      continue
    }

    if (!bucket.groupName && entry.groupName) bucket.groupName = entry.groupName
    if (!bucket.groupDesc && entry.groupDesc) bucket.groupDesc = entry.groupDesc
    if (!bucket.toolNameOverride && entry.toolNameOverride) {
      bucket.toolNameOverride = entry.toolNameOverride
    }
    if (!bucket.toolDescOverride && entry.toolDescOverride) {
      bucket.toolDescOverride = entry.toolDescOverride
    }
    bucket.targets.push(entry.target)
    if (entry.status === 'active') bucket.hasActive = true
  }

  const grouped = new Map<string, WebMcpGroupEntry>()

  const sortedBuckets = Array.from(buckets.values()).sort((a, b) => {
    const groupCmp = a.groupId.localeCompare(b.groupId)
    if (groupCmp !== 0) return groupCmp
    return a.action.localeCompare(b.action)
  })

  for (const bucket of sortedBuckets) {
    const groupEntry = grouped.get(bucket.groupId) ?? {
      groupId: bucket.groupId,
      groupName: bucket.groupName,
      groupDesc: bucket.groupDesc,
      tools: [],
    }

    if (!groupEntry.groupName && bucket.groupName) groupEntry.groupName = bucket.groupName
    if (!groupEntry.groupDesc && bucket.groupDesc) groupEntry.groupDesc = bucket.groupDesc

    if (options.exposureMode === 'grouped') {
      const stableSeed = bucket.targets
        .map(target => `${target.sourceFile}:${target.targetId}`)
        .sort()
        .join('|')

      const toolName =
        bucket.toolNameOverride ??
        toGroupToolName(
          options.toolPrefix,
          bucket.groupId,
          bucket.action,
          `${bucket.groupId}:${bucket.action}:${stableSeed}`,
        )

      const toolDesc =
        bucket.toolDescOverride ??
        bucket.groupDesc ??
        `${bucket.groupName ?? bucket.groupId} 그룹에서 ${bucket.action} 액션을 실행합니다.`

      const tool: WebMcpToolEntry = {
        toolName,
        toolDesc,
        action: bucket.action,
        status: bucket.hasActive ? 'active' : 'skipped_unsupported_action',
        targets: bucket.targets
          .slice()
          .sort((a, b) => a.targetId.localeCompare(b.targetId)),
      }

      groupEntry.tools.push(tool)
      grouped.set(bucket.groupId, groupEntry)
      continue
    }

    const sortedTargets = bucket.targets
      .slice()
      .sort((a, b) => a.targetId.localeCompare(b.targetId))

    for (const target of sortedTargets) {
      const tool: WebMcpToolEntry = {
        toolName: toPerElementToolName(
          options.toolPrefix,
          bucket.action,
          target.name,
          target.sourceFile,
          target.targetId,
        ),
        toolDesc: bucket.toolDescOverride ?? bucket.groupDesc ?? target.desc,
        action: bucket.action,
        status: bucket.hasActive ? 'active' : 'skipped_unsupported_action',
        targets: [target],
      }
      groupEntry.tools.push(tool)
    }

    grouped.set(bucket.groupId, groupEntry)
  }

  const groups = Array.from(grouped.values())
    .map(group => ({
      ...group,
      tools: group.tools.sort((a, b) => a.toolName.localeCompare(b.toolName)),
    }))
    .sort((a, b) => a.groupId.localeCompare(b.groupId))

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    exposureMode: options.exposureMode,
    groups,
  }
}

export const webMcpDomUnplugin = createUnplugin<WebMcpDomPluginOptions | undefined>(
  (rawOptions, meta) => {
    const options = resolveOptions(rawOptions)
    const entriesByFile = new Map<string, WebMcpCompiledTarget[]>()
    const matchers = options.include.map(pattern => picomatch(pattern))
    const ignoreMatchers = options.exclude.map(pattern => picomatch(pattern))
    const webpackOutputDir = (meta as { webpack?: { compiler?: { options?: { output?: { path?: string } } } } }).webpack?.compiler?.options?.output?.path
    const webpackVirtualManifestId = path.join(
      os.tmpdir(),
      `webmcp-dom-manifest-${process.pid}.js`,
    )

    const shouldHandleFile = (id: string): boolean => {
      if (id.includes('\0')) return false
      const cleanId = id.split('?')[0]
      if (ignoreMatchers.some(isMatch => isMatch(cleanId))) return false
      return matchers.some(isMatch => isMatch(cleanId))
    }

    const toCurrentManifest = (): WebMcpManifest => {
      const entries = Array.from(entriesByFile.values()).flat()
      return toManifest(entries, options)
    }

    const updateEntries = (
      relativePath: string,
      nextEntries: WebMcpCompiledTarget[],
    ): { changed: boolean } => {
      const prev = entriesByFile.get(relativePath)
      const prevSerialized = prev ? JSON.stringify(prev) : ''
      const nextSerialized = nextEntries.length > 0 ? JSON.stringify(nextEntries) : ''

      if (nextEntries.length > 0) {
        entriesByFile.set(relativePath, nextEntries)
      } else {
        entriesByFile.delete(relativePath)
      }

      return { changed: prevSerialized !== nextSerialized }
    }

    const viteHmr = createViteHmrBridge({
      options,
      shouldHandleFile,
      toCurrentManifest,
      updateEntries,
    })

    return {
      name: 'webmcp-dom',
      enforce: 'pre',

      async buildStart() {
        entriesByFile.clear()

        const files = await fg(options.include, {
          ignore: options.exclude,
          absolute: true,
          cwd: process.cwd(),
        })

        for (const file of files) {
          try {
            const code = await fs.readFile(file, 'utf8')
            const relativePath = path.relative(process.cwd(), file)
            const result = compileSource(code, relativePath, options, false)
            if (result.entries.length > 0) {
              entriesByFile.set(relativePath, result.entries)
            }
          } catch {
            // pre-scan best effort
          }
        }
      },

      resolveId(id) {
        if (
          id === VIRTUAL_MANIFEST_ID ||
          id === COMPAT_MANIFEST_ID ||
          id === PACKAGE_MANIFEST_ID
        ) {
          if (meta.framework === 'webpack') {
            if (!existsSync(webpackVirtualManifestId)) {
              writeFileSync(webpackVirtualManifestId, 'export default {};\n', 'utf8')
            }
            return webpackVirtualManifestId
          }
          return RESOLVED_VIRTUAL_MANIFEST_ID
        }
        return null
      },

      load(id) {
        if (id !== RESOLVED_VIRTUAL_MANIFEST_ID && id !== webpackVirtualManifestId) {
          return null
        }
        return [
          `export const runtimeOptions = ${JSON.stringify(options.click, null, 2)};`,
          `export default ${JSON.stringify(toCurrentManifest(), null, 2)};`,
        ].join('\n')
      },

      transform(this: any, code, id) {
        const cleanId = id.split('?')[0]
        if (!shouldHandleFile(cleanId)) return null

        const relativePath = path.relative(process.cwd(), cleanId)
        const result = compileSource(
          code,
          relativePath,
          options,
          Boolean(this.meta?.watchMode),
        )

        const { changed: entriesChanged } = updateEntries(relativePath, result.entries)

        const warnings = result.diagnostics.filter(d => d.level === 'warning')
        const errors = result.diagnostics.filter(d => d.level === 'error')

        for (const warn of warnings) {
          this.warn(`[webmcp-dom] ${formatDiagnostic(warn)}`)
        }

        if (errors.length > 0) {
          if (options.strict) {
            const all = errors.map(formatDiagnostic).join('\n')
            this.error(`[webmcp-dom]\n${all}`)
          } else {
            for (const err of errors) {
              this.warn(`[webmcp-dom] ${formatDiagnostic(err)}`)
            }
          }
        }

        if (!result.changed) return null

        if (Boolean(this.meta?.watchMode) && entriesChanged) {
          viteHmr.emitManifestUpdate()
        }

        return {
          code: result.code,
          map: null,
        }
      },

      // TODO(webmcp-dom): webpack/rollup dev 훅도 adapter bridge로 동일 패턴 적용.
      vite: {
        configureServer(server) {
          viteHmr.configureServer(server)
        },

        async handleHotUpdate(ctx) {
          return viteHmr.handleHotUpdate(ctx)
        },
      },

      generateBundle(this: any) {
        const manifest = toCurrentManifest()

        const seen = new Map<string, { file: string; line: number; column: number }>()
        const dupes: WebMcpDiagnostic[] = []

        for (const group of manifest.groups) {
          for (const tool of group.tools) {
            const firstTarget = tool.targets[0]
            const prev = seen.get(tool.toolName)
            if (prev) {
              dupes.push({
                level: 'error',
                code: 'WMCP_COMPILE_DUPLICATE_TOOL',
                message: `중복 toolName: ${tool.toolName}`,
                file: firstTarget?.sourceFile ?? prev.file,
                line: firstTarget?.sourceLine ?? prev.line,
                column: firstTarget?.sourceColumn ?? prev.column,
              })
            } else {
              seen.set(tool.toolName, {
                file: firstTarget?.sourceFile ?? 'unknown',
                line: firstTarget?.sourceLine ?? 1,
                column: firstTarget?.sourceColumn ?? 1,
              })
            }
          }
        }

        if (dupes.length > 0) {
          const all = dupes.map(formatDiagnostic).join('\n')
          this.error(`[webmcp-dom]\n${all}`)
          return
        }

        this.emitFile({
          type: 'asset',
          fileName: options.manifestFile,
          source: JSON.stringify(manifest, null, 2),
        })
      },

      async writeBundle() {
        if (meta.framework !== 'webpack') return
        if (!webpackOutputDir) return
        const manifest = toCurrentManifest()
        await fs.mkdir(webpackOutputDir, { recursive: true })
        await fs.writeFile(
          path.join(webpackOutputDir, options.manifestFile),
          JSON.stringify(manifest, null, 2),
          'utf8',
        )
      },
    }
  },
)

export default webMcpDomUnplugin
