// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupWebMcpPolyfill,
  initializeWebMcpPolyfill,
} from '../src/index'

afterEach(() => {
  cleanupWebMcpPolyfill()
})

describe('polyfill', () => {
  it('modelContext가 없으면 strict core를 설치한다', () => {
    delete (navigator as Navigator & { modelContext?: unknown }).modelContext

    initializeWebMcpPolyfill()

    expect(typeof (navigator as Navigator & { modelContext?: { registerTool?: unknown } }).modelContext?.registerTool).toBe(
      'function',
    )
  })

  it('preserve 모드에서는 기존 modelContext를 유지한다', () => {
    const native = {
      provideContext() {},
      registerTool() {},
      unregisterTool() {},
      clearContext() {},
    }

    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      writable: true,
      value: native,
    })

    initializeWebMcpPolyfill({ nativeModelContextBehavior: 'preserve' })

    expect((navigator as Navigator & { modelContext?: unknown }).modelContext).toBe(native)
  })

  it('patch 모드에서는 기존 modelContext를 교체한다', () => {
    const native = {
      provideContext() {},
      registerTool() {},
      unregisterTool() {},
      clearContext() {},
    }

    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      writable: true,
      value: native,
    })

    initializeWebMcpPolyfill({ nativeModelContextBehavior: 'patch' })

    expect((navigator as Navigator & { modelContext?: unknown }).modelContext).not.toBe(native)
  })

  it('registerTool 중복 이름은 예외를 던진다', () => {
    delete (navigator as Navigator & { modelContext?: unknown }).modelContext
    initializeWebMcpPolyfill({ nativeModelContextBehavior: 'patch' })

    const modelContext = (navigator as Navigator & {
      modelContext: {
        registerTool: (tool: {
          name: string
          description: string
          execute: () => Promise<{ content: Array<{ type: 'text'; text: string }> }>
        }) => void
      }
    }).modelContext

    const tool = {
      name: 'dup',
      description: 'dup tool',
      async execute() {
        return { content: [{ type: 'text' as const, text: 'ok' }] }
      },
    }

    modelContext.registerTool(tool)
    expect(() => modelContext.registerTool(tool)).toThrow(/중복 tool name/)
  })

  it('testing shim으로 list/execute가 동작한다', async () => {
    delete (navigator as Navigator & { modelContext?: unknown }).modelContext
    delete (navigator as Navigator & { modelContextTesting?: unknown }).modelContextTesting

    initializeWebMcpPolyfill({ installTestingShim: true })

    const nav = navigator as Navigator & {
      modelContext: {
        registerTool: (tool: {
          name: string
          description: string
          execute: (args: Record<string, unknown>) => Promise<{
            content: Array<{ type: 'text'; text: string }>
          }>
        }) => void
      }
      modelContextTesting: {
        listTools: () => Array<{ name: string }>
        executeTool: (name: string, args: string) => Promise<string | null>
      }
    }

    nav.modelContext.registerTool({
      name: 'echo',
      description: 'echo tool',
      async execute(args) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(args) }],
        }
      },
    })

    const tools = nav.modelContextTesting.listTools()
    expect(tools.some(tool => tool.name === 'echo')).toBe(true)

    const raw = await nav.modelContextTesting.executeTool('echo', JSON.stringify({ a: 1 }))
    const parsed = JSON.parse(raw ?? '{}') as { content?: Array<{ text?: string }> }
    expect(parsed.content?.[0]?.text).toContain('"a":1')
  })
})
