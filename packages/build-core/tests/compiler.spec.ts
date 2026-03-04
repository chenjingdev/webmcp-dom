import { describe, expect, it } from 'vitest'
import { compileSource } from '../src/plugin/compiler'
import { resolveOptions } from '../src/plugin/options'

describe('compiler', () => {
  it('html에서 click target을 수집하고 추적 키를 주입한다', () => {
    const source = `
      <button data-mcp-action="click" data-mcp-name="대시보드 이동" data-mcp-desc="메인 탭 열기">Go</button>
    `

    const result = compileSource(source, 'src/app.html', resolveOptions())

    expect(result.diagnostics).toHaveLength(0)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].status).toBe('active')
    expect(result.entries[0].action).toBe('click')
    expect(result.entries[0].groupId).toBe('default')
    expect(result.code).toContain('data-webmcp-key="mcp_')
    expect(result.code).not.toContain('data-mcp-action=')
    expect(result.code).not.toContain('data-mcp-name=')
    expect(result.code).not.toContain('data-mcp-desc=')
  })

  it('중첩 그룹에서는 가장 가까운 상위 그룹을 사용한다', () => {
    const source = `
      <section data-mcp-group="navigation" data-mcp-tool-desc="상위 네비게이션">
        <button data-mcp-action="click" data-mcp-name="home" data-mcp-desc="홈">Home</button>
        <div data-mcp-group="modal" data-mcp-tool-desc="모달 조작">
          <button data-mcp-action="click" data-mcp-name="confirm" data-mcp-desc="확인">Confirm</button>
        </div>
      </section>
    `

    const result = compileSource(source, 'src/app.html', resolveOptions())

    expect(result.entries).toHaveLength(2)
    const home = result.entries.find(entry => entry.target.name === 'home')
    const confirm = result.entries.find(entry => entry.target.name === 'confirm')

    expect(home?.groupId).toBe('navigation')
    expect(home?.toolDescOverride).toBe('상위 네비게이션')
    expect(confirm?.groupId).toBe('modal')
    expect(confirm?.toolDescOverride).toBe('모달 조작')
  })

  it('jsx에서도 상위 group/tool 메타를 수집한다', () => {
    const source = `
      const App = () => (
        <section data-mcp-group="navigation" data-mcp-tool-name="navigation_click" data-mcp-tool-desc="상위 네비게이션">
          <button data-mcp-action="click" data-mcp-name="home" data-mcp-desc="홈">Home</button>
          <div data-mcp-group="modal" data-mcp-tool-name="modal_click" data-mcp-tool-desc="모달 조작">
            <button data-mcp-action="click" data-mcp-name="confirm" data-mcp-desc="확인">Confirm</button>
          </div>
        </section>
      )
    `

    const result = compileSource(source, 'src/App.tsx', resolveOptions())

    expect(result.entries).toHaveLength(2)
    const home = result.entries.find(entry => entry.target.name === 'home')
    const confirm = result.entries.find(entry => entry.target.name === 'confirm')

    expect(home?.groupId).toBe('navigation')
    expect(home?.toolNameOverride).toBe('navigation_click')
    expect(home?.toolDescOverride).toBe('상위 네비게이션')

    expect(confirm?.groupId).toBe('modal')
    expect(confirm?.toolNameOverride).toBe('modal_click')
    expect(confirm?.toolDescOverride).toBe('모달 조작')
  })

  it('필수 속성 누락 시 컴파일 에러를 반환한다', () => {
    const source = `<button data-mcp-action="click">Go</button>`
    const result = compileSource(source, 'src/app.html', resolveOptions())

    const missing = result.diagnostics.filter(d => d.code === 'WMCP_COMPILE_MISSING_ATTR')
    expect(missing.length).toBeGreaterThan(0)
  })

  it('지원하지 않는 action은 skipped 상태로 기록하고 경고한다', () => {
    const source = `<button data-mcp-action="hover" data-mcp-name="Hover" data-mcp-desc="Hover test">Go</button>`
    const result = compileSource(source, 'src/app.html', resolveOptions())

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].status).toBe('skipped_unsupported_action')
    expect(result.diagnostics.some(d => d.code === 'WMCP_COMPILE_UNSUPPORTED_ACTION')).toBe(true)
  })

  it('jsx에서 동적 표현식 속성은 에러로 처리한다', () => {
    const source = `<button data-mcp-action={kind} data-mcp-name="X" data-mcp-desc="Y">Go</button>`
    const result = compileSource(source, 'src/App.tsx', resolveOptions())

    expect(result.diagnostics.some(d => d.code === 'WMCP_COMPILE_DYNAMIC_ATTR')).toBe(true)
  })

  it('동일 입력에서는 targetId가 결정적으로 생성된다', () => {
    const source = `
      <button data-mcp-action="click" data-mcp-name="대시보드 이동" data-mcp-desc="메인 탭 열기">Go</button>
    `
    const options = resolveOptions()
    const a = compileSource(source, 'src/app.html', options)
    const b = compileSource(source, 'src/app.html', options)

    expect(a.entries).toHaveLength(1)
    expect(b.entries).toHaveLength(1)
    expect(a.entries[0].target.targetId).toBe(b.entries[0].target.targetId)
  })
})
