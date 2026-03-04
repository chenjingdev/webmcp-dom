import type { WebMcpManifest, WebMcpRuntimeOptions, WebMcpTargetEntry, WebMcpToolEntry } from '../types'

const DEFAULT_OPTIONS: WebMcpRuntimeOptions = {
  clickAutoScroll: true,
  clickRetryCount: 2,
  clickRetryDelayMs: 120,
}

type WebMcpRegisterTool = (tool: {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
  }>
}) => void

interface ModelContextLike {
  registerTool?: WebMcpRegisterTool
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isVisible(el: HTMLElement): boolean {
  if (typeof window === 'undefined') return false
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function buildToolInputSchema(tool: WebMcpToolEntry): Record<string, unknown> {
  if (tool.targets.length <= 1) {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }
  }

  return {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: tool.targets.map(target => target.targetId),
        description: '실행할 클릭 타겟 ID',
      },
    },
    required: ['target'],
    additionalProperties: false,
  }
}

function buildTargetMap(tools: WebMcpToolEntry[]): Map<string, WebMcpTargetEntry> {
  const map = new Map<string, WebMcpTargetEntry>()
  for (const tool of tools) {
    for (const target of tool.targets) {
      map.set(target.targetId, target)
    }
  }
  return map
}

function pickTarget(tool: WebMcpToolEntry, args: Record<string, unknown>): WebMcpTargetEntry | null {
  if (tool.targets.length === 0) return null
  if (tool.targets.length === 1) return tool.targets[0]

  const rawTarget = args.target
  if (typeof rawTarget !== 'string' || rawTarget.trim() === '') return null
  return tool.targets.find(target => target.targetId === rawTarget.trim()) ?? null
}

export function registerCompiledWebMcpTools(
  manifest: WebMcpManifest,
  options: Partial<WebMcpRuntimeOptions> = {},
): void {
  if (typeof navigator === 'undefined') {
    console.warn('[webmcp-dom] navigator가 없어 등록을 건너뜁니다.')
    return
  }

  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    console.warn('[webmcp-dom] DOM API를 사용할 수 없어 등록을 건너뜁니다.')
    return
  }

  const runtime = { ...DEFAULT_OPTIONS, ...options }
  const nav = navigator as Navigator & { modelContext?: ModelContextLike }
  const modelContext = nav.modelContext

  if (!modelContext?.registerTool) {
    console.warn(
      '[webmcp-dom] navigator.modelContext.registerTool 를 찾을 수 없어 등록을 건너뜁니다.',
    )
    return
  }

  const activeTools = manifest.groups
    .flatMap(group => group.tools)
    .filter(tool => tool.status === 'active' && tool.action === 'click')

  const targetMap = buildTargetMap(activeTools)
  const elementIndex = new Map<string, HTMLElement>()

  const rescan = () => {
    if (typeof document === 'undefined') return
    for (const [targetId, target] of targetMap.entries()) {
      const el = document.querySelector<HTMLElement>(target.selector)
      if (el) elementIndex.set(targetId, el)
      else elementIndex.delete(targetId)
    }
  }

  rescan()

  const observer = new MutationObserver(() => {
    rescan()
  })

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-webmcp-key', 'data-mcp-key', 'style', 'class', 'disabled', 'hidden'],
    })
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(
      'pagehide',
      () => {
        observer.disconnect()
      },
      { once: true },
    )
  }

  for (const tool of activeTools) {
    modelContext.registerTool({
      name: tool.toolName,
      description: tool.toolDesc,
      inputSchema: buildToolInputSchema(tool),
      execute: async (args: Record<string, unknown>) => {
        const selectedTarget = pickTarget(tool, args)

        if (!selectedTarget) {
          const available = tool.targets.map(target => target.targetId).join(', ')
          return {
            content: [
              {
                type: 'text',
                text:
                  tool.targets.length > 1
                    ? `target 인자가 필요합니다. 사용 가능: ${available}`
                    : '실행 가능한 타겟이 없습니다.',
              },
            ],
            isError: true,
          }
        }

        for (let attempt = 0; attempt <= runtime.clickRetryCount; attempt += 1) {
          const targetEl =
            elementIndex.get(selectedTarget.targetId) ??
            document.querySelector<HTMLElement>(selectedTarget.selector)

          if (!targetEl) {
            if (attempt < runtime.clickRetryCount) {
              await sleep(runtime.clickRetryDelayMs)
              continue
            }
            return {
              content: [{ type: 'text', text: `Element not found: ${selectedTarget.selector}` }],
              isError: true,
            }
          }

          if (runtime.clickAutoScroll) {
            targetEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' })
          }

          if ('disabled' in targetEl && (targetEl as HTMLButtonElement).disabled) {
            return {
              content: [{ type: 'text', text: `Element is disabled: ${selectedTarget.selector}` }],
              isError: true,
            }
          }

          if (!isVisible(targetEl)) {
            if (attempt < runtime.clickRetryCount) {
              await sleep(runtime.clickRetryDelayMs)
              continue
            }
            return {
              content: [{ type: 'text', text: `Element is not visible: ${selectedTarget.selector}` }],
              isError: true,
            }
          }

          try {
            targetEl.click()
            return {
              content: [{ type: 'text', text: `Clicked: ${tool.toolName} -> ${selectedTarget.targetId}` }],
            }
          } catch (error) {
            if (attempt < runtime.clickRetryCount) {
              await sleep(runtime.clickRetryDelayMs)
              continue
            }
            return {
              content: [
                {
                  type: 'text',
                  text: `Click failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
            }
          }
        }

        return {
          content: [{ type: 'text', text: 'Unexpected click failure' }],
          isError: true,
        }
      },
    })
  }
}
