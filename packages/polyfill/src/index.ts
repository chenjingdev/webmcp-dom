export interface ModelContextTool {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
    [key: string]: unknown
  }>
}

export interface ModelContextLike {
  provideContext: (options?: { tools?: ModelContextTool[] }) => void
  registerTool: (tool: ModelContextTool) => void
  unregisterTool: (name: string) => void
  clearContext: () => void
}

export interface ModelContextTestingLike {
  listTools: () => Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  executeTool: (
    toolName: string,
    inputArgsJson?: string,
  ) => Promise<string | null>
}

export interface WebMcpPolyfillOptions {
  installTestingShim?: boolean | 'if-missing' | 'always'
  nativeModelContextBehavior?: 'preserve' | 'patch'
}

interface InstallState {
  installed: boolean
  modelContextDefinedByPolyfill: boolean
  testingDefinedByPolyfill: boolean
  previousModelContextDescriptor?: PropertyDescriptor
  previousTestingDescriptor?: PropertyDescriptor
}

const state: InstallState = {
  installed: false,
  modelContextDefinedByPolyfill: false,
  testingDefinedByPolyfill: false,
}

const toolRegistry = new Map<string, ModelContextTool>()

function ensureBrowser(): boolean {
  return typeof navigator !== 'undefined'
}

function validateTool(tool: ModelContextTool): void {
  if (!tool || typeof tool !== 'object') {
    throw new TypeError('tool은 객체여야 합니다.')
  }
  if (!tool.name || typeof tool.name !== 'string' || tool.name.trim() === '') {
    throw new TypeError('tool.name은 비어있지 않은 문자열이어야 합니다.')
  }
  if (
    !tool.description ||
    typeof tool.description !== 'string' ||
    tool.description.trim() === ''
  ) {
    throw new TypeError('tool.description은 비어있지 않은 문자열이어야 합니다.')
  }
  if (typeof tool.execute !== 'function') {
    throw new TypeError('tool.execute는 함수여야 합니다.')
  }
}

function makeCoreObject(): ModelContextLike {
  return {
    provideContext(options) {
      toolRegistry.clear()
      const tools = options?.tools ?? []
      for (const tool of tools) {
        validateTool(tool)
        if (toolRegistry.has(tool.name)) {
          throw new Error(`중복 tool name: ${tool.name}`)
        }
        toolRegistry.set(tool.name, {
          ...tool,
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        })
      }
    },

    registerTool(tool) {
      validateTool(tool)
      if (toolRegistry.has(tool.name)) {
        throw new Error(`중복 tool name: ${tool.name}`)
      }
      toolRegistry.set(tool.name, {
        ...tool,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      })
    },

    unregisterTool(name) {
      if (typeof name !== 'string' || name.trim() === '') return
      toolRegistry.delete(name)
    },

    clearContext() {
      toolRegistry.clear()
    },
  }
}

function makeTestingShim(): ModelContextTestingLike {
  return {
    listTools() {
      return Array.from(toolRegistry.values()).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      }))
    },

    async executeTool(toolName, inputArgsJson = '{}') {
      const tool = toolRegistry.get(toolName)
      if (!tool) {
        throw new Error(`등록되지 않은 tool: ${toolName}`)
      }

      let parsedArgs: Record<string, unknown>
      try {
        const parsed = JSON.parse(inputArgsJson)
        parsedArgs = parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        throw new Error('inputArgsJson은 유효한 JSON 문자열이어야 합니다.')
      }

      const result = await tool.execute(parsedArgs)
      return JSON.stringify(result)
    },
  }
}

function shouldInstallTestingShim(
  mode: WebMcpPolyfillOptions['installTestingShim'],
  hasNativeTesting: boolean,
): boolean {
  if (mode === false) return false
  if (mode === true || mode === 'always') return true
  return !hasNativeTesting
}

export function initializeWebMcpPolyfill(options: WebMcpPolyfillOptions = {}): void {
  if (!ensureBrowser()) return

  const installTestingShim = options.installTestingShim ?? 'if-missing'
  const nativeBehavior = options.nativeModelContextBehavior ?? 'preserve'
  const nav = navigator as Navigator & {
    modelContext?: ModelContextLike
    modelContextTesting?: ModelContextTestingLike
  }

  if (!state.installed) {
    state.previousModelContextDescriptor = Object.getOwnPropertyDescriptor(nav, 'modelContext')
    state.previousTestingDescriptor = Object.getOwnPropertyDescriptor(nav, 'modelContextTesting')
  }

  const hasNativeModelContext = Boolean(nav.modelContext)
  const hasNativeTesting = Boolean(nav.modelContextTesting)

  if (!hasNativeModelContext || nativeBehavior === 'patch') {
    Object.defineProperty(nav, 'modelContext', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: makeCoreObject(),
    })
    state.modelContextDefinedByPolyfill = true
  }

  if (shouldInstallTestingShim(installTestingShim, hasNativeTesting)) {
    Object.defineProperty(nav, 'modelContextTesting', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: makeTestingShim(),
    })
    state.testingDefinedByPolyfill = true
  }

  state.installed = true
}

export function cleanupWebMcpPolyfill(): void {
  if (!ensureBrowser()) return

  const nav = navigator as Navigator & {
    modelContext?: ModelContextLike
    modelContextTesting?: ModelContextTestingLike
  }

  if (state.modelContextDefinedByPolyfill) {
    if (state.previousModelContextDescriptor) {
      Object.defineProperty(nav, 'modelContext', state.previousModelContextDescriptor)
    } else {
      delete nav.modelContext
    }
  }

  if (state.testingDefinedByPolyfill) {
    if (state.previousTestingDescriptor) {
      Object.defineProperty(nav, 'modelContextTesting', state.previousTestingDescriptor)
    } else {
      delete nav.modelContextTesting
    }
  }

  toolRegistry.clear()
  state.installed = false
  state.modelContextDefinedByPolyfill = false
  state.testingDefinedByPolyfill = false
  state.previousModelContextDescriptor = undefined
  state.previousTestingDescriptor = undefined
}

export const initializeWebModelContextPolyfill = initializeWebMcpPolyfill
