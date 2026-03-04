// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebMcpManifest } from '../src/types'
import { registerCompiledWebMcpTools } from '../src/runtime/register-tools'

let scrollSpy: ReturnType<typeof vi.fn>

function mockRect() {
  return {
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    top: 0,
    left: 0,
    right: 120,
    bottom: 40,
    toJSON: () => ({}),
  } as DOMRect
}

function makeManifest(): WebMcpManifest {
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    exposureMode: 'grouped',
    groups: [
      {
        groupId: 'navigation',
        groupName: 'Navigation',
        groupDesc: '네비게이션 그룹',
        tools: [
          {
            toolName: 'wmcp_navigation_click__1',
            toolDesc: '네비게이션 클릭 도구',
            action: 'click',
            status: 'active',
            targets: [
              {
                targetId: 'home',
                name: 'home',
                desc: '홈 탭',
                selector: '[data-webmcp-key="home"]',
                sourceFile: 'a.html',
                sourceLine: 1,
                sourceColumn: 1,
              },
              {
                targetId: 'menu1',
                name: 'menu1',
                desc: '메뉴1 탭',
                selector: '[data-webmcp-key="menu1"]',
                sourceFile: 'a.html',
                sourceLine: 2,
                sourceColumn: 1,
              },
            ],
          },
        ],
      },
    ],
  }
}

describe('runtime', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    scrollSpy = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollSpy,
    })
  })

  it('modelContext 미존재 시 경고 후 no-op', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(navigator, 'modelContext', {
      value: undefined,
      configurable: true,
    })

    registerCompiledWebMcpTools(makeManifest())

    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('grouped click tool을 registerTool로 등록하고 target 선택 실행에 성공한다', async () => {
    const button = document.createElement('button')
    button.setAttribute('data-webmcp-key', 'home')
    button.getBoundingClientRect = () => mockRect()

    let clicked = false
    button.addEventListener('click', () => {
      clicked = true
    })

    document.body.appendChild(button)

    const tools: Array<{ execute: (args: Record<string, unknown>) => Promise<{ isError?: boolean }> }> = []
    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: {
        registerTool: (tool: { execute: (args: Record<string, unknown>) => Promise<{ isError?: boolean }> }) => {
          tools.push(tool)
        },
      },
    })

    registerCompiledWebMcpTools(makeManifest())
    expect(tools).toHaveLength(1)

    const res = await tools[0].execute({ target: 'home' })
    expect(res.isError).toBeUndefined()
    expect(clicked).toBe(true)
  })

  it('grouped 도구에서 target 누락 시 에러를 반환한다', async () => {
    const tools: Array<{ execute: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> = []
    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: {
        registerTool: (tool: { execute: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }) => {
          tools.push(tool)
        },
      },
    })

    registerCompiledWebMcpTools(makeManifest())

    const res = await tools[0].execute({})
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('target 인자가 필요합니다')
  })

  it('다중 target inputSchema에 target name/desc 메타를 포함한다', () => {
    const tools: Array<{ inputSchema: Record<string, unknown> }> = []
    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: {
        registerTool: (tool: { inputSchema: Record<string, unknown> }) => {
          tools.push(tool)
        },
      },
    })

    registerCompiledWebMcpTools(makeManifest())

    expect(tools).toHaveLength(1)
    const schema = tools[0].inputSchema as {
      properties?: {
        target?: {
          enum?: string[]
          oneOf?: Array<{ const?: string; title?: string; description?: string }>
        }
      }
    }
    const target = schema.properties?.target
    expect(target?.enum).toEqual(['home', 'menu1'])
    expect(target?.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          const: 'home',
          title: 'home',
          description: '홈 탭',
        }),
        expect.objectContaining({
          const: 'menu1',
          title: 'menu1',
          description: '메뉴1 탭',
        }),
      ]),
    )
  })

  it('disabled 요소는 구조화 에러를 반환한다', async () => {
    const button = document.createElement('button')
    button.disabled = true
    button.setAttribute('data-webmcp-key', 'home')
    button.getBoundingClientRect = () => mockRect()
    document.body.appendChild(button)

    const tools: Array<{ execute: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> = []
    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: {
        registerTool: (tool: { execute: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }) => {
          tools.push(tool)
        },
      },
    })

    registerCompiledWebMcpTools(makeManifest())

    const res = await tools[0].execute({ target: 'home' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('disabled')
  })

  it('retry + autoScroll 동작으로 지연 렌더 요소 클릭에 성공한다', async () => {
    const tools: Array<{ execute: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }> = []
    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: {
        registerTool: (tool: { execute: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }) => {
          tools.push(tool)
        },
      },
    })

    registerCompiledWebMcpTools(makeManifest(), {
      clickRetryCount: 2,
      clickRetryDelayMs: 1,
      clickAutoScroll: true,
    })

    setTimeout(() => {
      const button = document.createElement('button')
      button.setAttribute('data-webmcp-key', 'home')
      button.getBoundingClientRect = () => mockRect()
      document.body.appendChild(button)
    }, 0)

    const res = await tools[0].execute({ target: 'home' })
    expect(res.isError).toBeUndefined()
    expect(res.content[0].text).toContain('Clicked')
    expect(scrollSpy).toHaveBeenCalled()
  })

  it('재등록 시 이전 tool을 정리하고 최신 tool로 교체한다', () => {
    const registerTool = vi.fn()
    const unregisterTool = vi.fn()

    Object.defineProperty(navigator, 'modelContext', {
      configurable: true,
      value: {
        registerTool,
        unregisterTool,
      },
    })

    const first = makeManifest()
    const second = makeManifest()
    second.groups[0].tools[0].toolName = 'wmcp_navigation_click__2'

    registerCompiledWebMcpTools(first)
    const latest = registerCompiledWebMcpTools(second)

    expect(
      unregisterTool.mock.calls.some(([name]) => name === 'wmcp_navigation_click__1'),
    ).toBe(true)
    expect(
      registerTool.mock.calls.some(([tool]) => tool.name === 'wmcp_navigation_click__2'),
    ).toBe(true)

    latest.dispose()
    expect(
      unregisterTool.mock.calls.some(([name]) => name === 'wmcp_navigation_click__2'),
    ).toBe(true)
  })
})
