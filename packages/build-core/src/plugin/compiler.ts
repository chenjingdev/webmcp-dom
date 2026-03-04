import { parse as parseHtml } from 'parse5'
import MagicString from 'magic-string'
import { parse as babelParse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import type { JSXAttribute, JSXElement, JSXOpeningElement } from '@babel/types'
import type {
  WebMcpCompiledTarget,
  WebMcpDiagnostic,
  WebMcpToolStatus,
} from '../types'
import type { ResolvedWebMcpDomOptions } from './options'
import { isLikelyDynamicExpression, shortHash } from './helpers'

const TARGET_REQ_ATTRS = ['data-mcp-action', 'data-mcp-name', 'data-mcp-desc'] as const
const TARGET_OPT_ATTRS = ['data-mcp-key', 'data-mcp-group'] as const
const GROUP_META_ATTRS = [
  'data-mcp-group-name',
  'data-mcp-group-desc',
  'data-mcp-tool-name',
  'data-mcp-tool-desc',
] as const
const MCP_ATTRS = [...TARGET_REQ_ATTRS, ...TARGET_OPT_ATTRS, ...GROUP_META_ATTRS] as const
const DOM_KEY_ATTR = 'data-webmcp-key'

type TraverseFn = typeof import('@babel/traverse').default

const traverse: TraverseFn =
  (traverseModule as unknown as { default?: TraverseFn }).default ??
  (traverseModule as unknown as TraverseFn)

interface CompileResult {
  code: string
  changed: boolean
  entries: WebMcpCompiledTarget[]
  diagnostics: WebMcpDiagnostic[]
}

interface Edit {
  start: number
  end: number
  content: string
}

type AnyNode = {
  nodeName?: string
  tagName?: string
  attrs?: Array<{ name: string; value: string }>
  childNodes?: AnyNode[]
  parentNode?: AnyNode
  sourceCodeLocation?: {
    startLine: number
    startCol: number
    attrs?: Record<
      string,
      {
        startLine: number
        startCol: number
        startOffset: number
        endOffset: number
      }
    >
    startTag?: {
      startOffset: number
      endOffset: number
    }
  }
}

interface GroupContext {
  groupId: string
  groupName?: string
  groupDesc?: string
  toolNameOverride?: string
  toolDescOverride?: string
}

function buildDiagnostic(
  level: 'warning' | 'error',
  code: WebMcpDiagnostic['code'],
  message: string,
  file: string,
  line: number,
  column: number,
): WebMcpDiagnostic {
  return { level, code, message, file, line, column }
}

function mkTargetId(relativePath: string, line: number, column: number): string {
  return `mcp_${shortHash(`${relativePath}:${line}:${column}`)}`
}

function getExt(file: string): string {
  const noQuery = file.split('?')[0]
  const idx = noQuery.lastIndexOf('.')
  if (idx < 0) return ''
  return noQuery.slice(idx).toLowerCase()
}

function isHtmlLike(file: string): boolean {
  return ['.html', '.htm', '.vue', '.svelte'].includes(getExt(file))
}

function canContainJsx(file: string): boolean {
  return ['.js', '.jsx', '.ts', '.tsx'].includes(getExt(file))
}

function removeAttrEditFromRange(loc: { startOffset: number; endOffset: number }): Edit {
  return {
    start: loc.startOffset,
    end: loc.endOffset,
    content: '',
  }
}

function walkHtml(node: AnyNode, cb: (node: AnyNode) => void): void {
  cb(node)
  if (!node.childNodes?.length) return
  for (const child of node.childNodes) {
    walkHtml(child, cb)
  }
}

function findAttr(node: AnyNode, name: string): { name: string; value: string } | undefined {
  return node.attrs?.find(a => a.name === name)
}

function getAttrTrimmedValue(node: AnyNode, name: string): string | undefined {
  const attr = findAttr(node, name)
  if (!attr) return undefined
  const trimmed = attr.value.trim()
  return trimmed === '' ? undefined : trimmed
}

function readHtmlOptionalMeta(
  node: AnyNode,
  attrName: string,
  relativePath: string,
  diagnostics: WebMcpDiagnostic[],
  fallbackLine: number,
  fallbackColumn: number,
): string | undefined {
  const attr = findAttr(node, attrName)
  if (!attr) return undefined

  const loc = node.sourceCodeLocation?.attrs?.[attrName]
  const line = loc?.startLine ?? fallbackLine
  const column = loc?.startCol ?? fallbackColumn

  if (!attr.value || attr.value.trim() === '') {
    diagnostics.push(
      buildDiagnostic(
        'error',
        'WMCP_COMPILE_EMPTY_ATTR',
        `${attrName} 값은 비어 있을 수 없습니다.`,
        relativePath,
        line,
        column,
      ),
    )
    return undefined
  }

  if (isLikelyDynamicExpression(attr.value)) {
    diagnostics.push(
      buildDiagnostic(
        'error',
        'WMCP_COMPILE_DYNAMIC_ATTR',
        `${attrName}는 정적 문자열이어야 합니다.`,
        relativePath,
        line,
        column,
      ),
    )
    return undefined
  }

  return attr.value.trim()
}

function resolveHtmlGroupContext(
  node: AnyNode,
  options: ResolvedWebMcpDomOptions,
  relativePath: string,
  diagnostics: WebMcpDiagnostic[],
  fallbackLine: number,
  fallbackColumn: number,
): GroupContext {
  let cursor: AnyNode | undefined = node
  let boundaryNode: AnyNode | undefined

  while (cursor) {
    if (findAttr(cursor, options.groupAttr)) {
      boundaryNode = cursor
      break
    }
    cursor = cursor.parentNode
  }

  const context: GroupContext = {
    groupId: 'default',
  }

  const metaSourceNode = boundaryNode ?? (() => {
    let tmp: AnyNode | undefined = node
    while (tmp) {
      const current = tmp
      const hasMeta = GROUP_META_ATTRS.some(attrName => !!findAttr(current, attrName))
      if (hasMeta) return tmp
      tmp = tmp.parentNode
    }
    return undefined
  })()

  if (boundaryNode) {
    const groupId = readHtmlOptionalMeta(
      boundaryNode,
      options.groupAttr,
      relativePath,
      diagnostics,
      fallbackLine,
      fallbackColumn,
    )
    if (groupId) context.groupId = groupId
  }

  if (metaSourceNode) {
    context.groupName = readHtmlOptionalMeta(
      metaSourceNode,
      'data-mcp-group-name',
      relativePath,
      diagnostics,
      fallbackLine,
      fallbackColumn,
    )
    context.groupDesc = readHtmlOptionalMeta(
      metaSourceNode,
      'data-mcp-group-desc',
      relativePath,
      diagnostics,
      fallbackLine,
      fallbackColumn,
    )
    context.toolNameOverride = readHtmlOptionalMeta(
      metaSourceNode,
      'data-mcp-tool-name',
      relativePath,
      diagnostics,
      fallbackLine,
      fallbackColumn,
    )
    context.toolDescOverride = readHtmlOptionalMeta(
      metaSourceNode,
      'data-mcp-tool-desc',
      relativePath,
      diagnostics,
      fallbackLine,
      fallbackColumn,
    )
  }

  return context
}

function toCompiledTarget(params: {
  action: string
  status: WebMcpToolStatus
  group: GroupContext
  targetId: string
  targetName: string
  targetDesc: string
  selector: string
  relativePath: string
  sourceLine: number
  sourceColumn: number
}): WebMcpCompiledTarget {
  return {
    action: params.action,
    status: params.status,
    groupId: params.group.groupId,
    groupName: params.group.groupName,
    groupDesc: params.group.groupDesc,
    toolNameOverride: params.group.toolNameOverride,
    toolDescOverride: params.group.toolDescOverride,
    target: {
      targetId: params.targetId,
      name: params.targetName,
      desc: params.targetDesc,
      selector: params.selector,
      sourceFile: params.relativePath,
      sourceLine: params.sourceLine,
      sourceColumn: params.sourceColumn,
    },
  }
}

function htmlCompile(
  code: string,
  relativePath: string,
  options: ResolvedWebMcpDomOptions,
  emitTrackingAttr: boolean,
): CompileResult {
  const diagnostics: WebMcpDiagnostic[] = []
  const entries: WebMcpCompiledTarget[] = []
  const edits: Edit[] = []
  const attrsToStrip = new Set<string>([...MCP_ATTRS, options.groupAttr])

  let doc: AnyNode
  try {
    doc = parseHtml(code, { sourceCodeLocationInfo: true }) as unknown as AnyNode
  } catch (err) {
    diagnostics.push(
      buildDiagnostic(
        'error',
        'WMCP_COMPILE_PARSE_ERROR',
        `HTML 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
        relativePath,
        1,
        1,
      ),
    )
    return { code, changed: false, entries, diagnostics }
  }

  walkHtml(doc, node => {
    if (!node.tagName || !node.attrs || !node.sourceCodeLocation?.attrs) return

    if (!options.preserveSourceAttrs) {
      for (const attrName of attrsToStrip) {
        const loc = node.sourceCodeLocation.attrs[attrName]
        if (!loc) continue
        edits.push(removeAttrEditFromRange(loc))
      }
    }

    const actionAttr = findAttr(node, 'data-mcp-action')
    if (!actionAttr) return

    const actionLoc = node.sourceCodeLocation.attrs['data-mcp-action']
    const line = actionLoc?.startLine ?? node.sourceCodeLocation.startLine
    const column = actionLoc?.startCol ?? node.sourceCodeLocation.startCol

    const requiredValues: Record<(typeof TARGET_REQ_ATTRS)[number], string | undefined> = {
      'data-mcp-action': undefined,
      'data-mcp-name': undefined,
      'data-mcp-desc': undefined,
    }

    let hasHardError = false

    for (const attrName of TARGET_REQ_ATTRS) {
      const attr = findAttr(node, attrName)
      const attrLoc = node.sourceCodeLocation.attrs[attrName]
      const attrLine = attrLoc?.startLine ?? line
      const attrCol = attrLoc?.startCol ?? column

      if (!attr) {
        diagnostics.push(
          buildDiagnostic(
            'error',
            'WMCP_COMPILE_MISSING_ATTR',
            `${attrName} 속성이 필요합니다.`,
            relativePath,
            attrLine,
            attrCol,
          ),
        )
        hasHardError = true
        continue
      }

      if (!attr.value || attr.value.trim() === '') {
        diagnostics.push(
          buildDiagnostic(
            'error',
            'WMCP_COMPILE_EMPTY_ATTR',
            `${attrName} 값은 비어 있을 수 없습니다.`,
            relativePath,
            attrLine,
            attrCol,
          ),
        )
        hasHardError = true
        continue
      }

      if (isLikelyDynamicExpression(attr.value)) {
        diagnostics.push(
          buildDiagnostic(
            'error',
            'WMCP_COMPILE_DYNAMIC_ATTR',
            `${attrName}는 정적 문자열이어야 합니다.`,
            relativePath,
            attrLine,
            attrCol,
          ),
        )
        hasHardError = true
        continue
      }

      requiredValues[attrName] = attr.value.trim()
    }

    const explicitKey = getAttrTrimmedValue(node, 'data-mcp-key')
    if (explicitKey && isLikelyDynamicExpression(explicitKey)) {
      diagnostics.push(
        buildDiagnostic(
          'error',
          'WMCP_COMPILE_DYNAMIC_ATTR',
          'data-mcp-key는 정적 문자열이어야 합니다.',
          relativePath,
          node.sourceCodeLocation.attrs['data-mcp-key']?.startLine ?? line,
          node.sourceCodeLocation.attrs['data-mcp-key']?.startCol ?? column,
        ),
      )
      hasHardError = true
    }

    const targetId = explicitKey || mkTargetId(relativePath, line, column)
    const group = resolveHtmlGroupContext(
      node,
      options,
      relativePath,
      diagnostics,
      line,
      column,
    )

    if (!emitTrackingAttr && (!options.preserveSourceAttrs || !explicitKey)) {
      diagnostics.push(
        buildDiagnostic(
          'error',
          'WMCP_COMPILE_MISSING_ATTR',
          'emitTrackingAttr=none 사용 시 data-mcp-key를 명시하고 preserveSourceAttrs=true 여야 합니다.',
          relativePath,
          line,
          column,
        ),
      )
      hasHardError = true
    }

    if (hasHardError) return

    const action = requiredValues['data-mcp-action'] as string
    const targetName = requiredValues['data-mcp-name'] as string
    const targetDesc = requiredValues['data-mcp-desc'] as string

    const supported = action === 'click'
    const status: WebMcpToolStatus = supported ? 'active' : 'skipped_unsupported_action'

    if (!supported) {
      const diagLevel =
        options.unsupportedActionHandling === 'error' ? 'error' : 'warning'
      diagnostics.push(
        buildDiagnostic(
          diagLevel,
          'WMCP_COMPILE_UNSUPPORTED_ACTION',
          `지원하지 않는 action '${action}' 입니다. v1에서는 click만 활성화됩니다.`,
          relativePath,
          line,
          column,
        ),
      )
    }

    if (emitTrackingAttr && node.sourceCodeLocation.startTag) {
      edits.push({
        start: node.sourceCodeLocation.startTag.endOffset - 1,
        end: node.sourceCodeLocation.startTag.endOffset - 1,
        content: ` ${DOM_KEY_ATTR}="${targetId}"`,
      })
    }

    const selector = emitTrackingAttr
      ? `[${DOM_KEY_ATTR}="${targetId}"]`
      : `[data-mcp-key="${targetId}"]`

    entries.push(
      toCompiledTarget({
        action,
        status,
        group,
        targetId,
        targetName,
        targetDesc,
        selector,
        relativePath,
        sourceLine: line,
        sourceColumn: column,
      }),
    )
  })

  if (!edits.length) {
    return { code, changed: false, entries, diagnostics }
  }

  const ms = new MagicString(code)
  const overwriteEdits = edits
    .filter(edit => edit.start !== edit.end)
    .sort((a, b) => b.start - a.start)
  const insertEdits = edits
    .filter(edit => edit.start === edit.end)
    .sort((a, b) => b.start - a.start)

  for (const edit of overwriteEdits) {
    ms.overwrite(edit.start, edit.end, edit.content)
  }
  for (const edit of insertEdits) {
    ms.appendLeft(edit.start, edit.content)
  }

  return {
    code: ms.toString(),
    changed: true,
    entries,
    diagnostics,
  }
}

function getJsxAttr(
  node: JSXOpeningElement,
  name: string,
): JSXAttribute | undefined {
  return node.attributes.find(
    attr => attr.type === 'JSXAttribute' && attr.name.name === name,
  ) as JSXAttribute | undefined
}

function jsxAttrToStaticString(
  attr: JSXAttribute | undefined,
): { value?: string; isStatic: boolean } {
  if (!attr || !attr.value) return { value: undefined, isStatic: false }
  if (attr.value.type === 'StringLiteral') {
    return { value: attr.value.value, isStatic: true }
  }
  return { value: undefined, isStatic: false }
}

function readJsxOptionalMeta(
  node: JSXOpeningElement,
  attrName: string,
  relativePath: string,
  diagnostics: WebMcpDiagnostic[],
  fallbackLine: number,
  fallbackColumn: number,
): string | undefined {
  const attr = getJsxAttr(node, attrName)
  if (!attr) return undefined

  const line = attr.loc?.start.line ?? fallbackLine
  const column = attr.loc?.start.column ?? fallbackColumn
  const parsed = jsxAttrToStaticString(attr)

  if (!parsed.isStatic) {
    diagnostics.push(
      buildDiagnostic(
        'error',
        'WMCP_COMPILE_DYNAMIC_ATTR',
        `${attrName}는 정적 문자열이어야 합니다.`,
        relativePath,
        line,
        column,
      ),
    )
    return undefined
  }

  if (!parsed.value || parsed.value.trim() === '') {
    diagnostics.push(
      buildDiagnostic(
        'error',
        'WMCP_COMPILE_EMPTY_ATTR',
        `${attrName} 값은 비어 있을 수 없습니다.`,
        relativePath,
        line,
        column,
      ),
    )
    return undefined
  }

  return parsed.value.trim()
}

function getJsxAncestorOpeningElements(path: any): JSXOpeningElement[] {
  const result: JSXOpeningElement[] = []
  const seen = new Set<JSXOpeningElement>()
  const pushUnique = (opening: JSXOpeningElement | null | undefined) => {
    if (!opening || seen.has(opening)) return
    seen.add(opening)
    result.push(opening)
  }

  let cursor = path
  while (cursor) {
    if (cursor.isJSXOpeningElement?.()) {
      pushUnique(cursor.node as JSXOpeningElement)
    }
    if (cursor.isJSXElement?.()) {
      pushUnique((cursor.node as JSXElement).openingElement)
    }
    cursor = cursor.parentPath
  }
  return result
}

function resolveJsxGroupContext(
  path: any,
  options: ResolvedWebMcpDomOptions,
  relativePath: string,
  diagnostics: WebMcpDiagnostic[],
  fallbackLine: number,
  fallbackColumn: number,
): GroupContext {
  const ancestors = getJsxAncestorOpeningElements(path)
  const boundaryNode = ancestors.find((opening: JSXOpeningElement) => {
    return !!getJsxAttr(opening, options.groupAttr)
  })

  const context: GroupContext = {
    groupId: 'default',
  }

  if (boundaryNode) {
    const groupId = readJsxOptionalMeta(
      boundaryNode,
      options.groupAttr,
      relativePath,
      diagnostics,
      fallbackLine,
      fallbackColumn,
    )
    if (groupId) context.groupId = groupId
  }

  const metaSourceNode =
    boundaryNode ??
    ancestors.find((opening: JSXOpeningElement) => {
      return GROUP_META_ATTRS.some(attrName => !!getJsxAttr(opening, attrName))
    })

  if (metaSourceNode) {
    context.groupName = readJsxOptionalMeta(
      metaSourceNode,
      'data-mcp-group-name',
      relativePath,
      diagnostics,
      fallbackLine,
      fallbackColumn,
    )
    context.groupDesc = readJsxOptionalMeta(
      metaSourceNode,
      'data-mcp-group-desc',
      relativePath,
      diagnostics,
      fallbackLine,
      fallbackColumn,
    )
    context.toolNameOverride = readJsxOptionalMeta(
      metaSourceNode,
      'data-mcp-tool-name',
      relativePath,
      diagnostics,
      fallbackLine,
      fallbackColumn,
    )
    context.toolDescOverride = readJsxOptionalMeta(
      metaSourceNode,
      'data-mcp-tool-desc',
      relativePath,
      diagnostics,
      fallbackLine,
      fallbackColumn,
    )
  }

  return context
}

function jsxCompile(
  code: string,
  relativePath: string,
  options: ResolvedWebMcpDomOptions,
  emitTrackingAttr: boolean,
): CompileResult {
  const diagnostics: WebMcpDiagnostic[] = []
  const entries: WebMcpCompiledTarget[] = []
  const edits: Edit[] = []
  const attrsToStrip = new Set<string>([...MCP_ATTRS, options.groupAttr])

  const ext = getExt(relativePath)
  const useTs = ext === '.ts' || ext === '.tsx'

  let ast
  try {
    ast = babelParse(code, {
      sourceType: 'module',
      plugins: useTs ? ['jsx', 'typescript'] : ['jsx'],
      errorRecovery: false,
    })
  } catch (err) {
    diagnostics.push(
      buildDiagnostic(
        'error',
        'WMCP_COMPILE_PARSE_ERROR',
        `JSX 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
        relativePath,
        1,
        1,
      ),
    )
    return { code, changed: false, entries, diagnostics }
  }

  traverse(ast, {
    JSXOpeningElement(path: any) {
      const node = path.node as JSXOpeningElement

      if (!options.preserveSourceAttrs) {
        for (const attrName of attrsToStrip) {
          const attr = getJsxAttr(node, attrName)
          if (!attr?.start || !attr.end) continue
          edits.push({ start: attr.start, end: attr.end, content: '' })
        }
      }

      const actionAttr = getJsxAttr(node, 'data-mcp-action')
      if (!actionAttr) return

      const line = actionAttr.loc?.start.line ?? node.loc?.start.line ?? 1
      const column = actionAttr.loc?.start.column ?? node.loc?.start.column ?? 1

      let hasHardError = false
      const staticValues: Record<string, string> = {}

      for (const attrName of TARGET_REQ_ATTRS) {
        const attr = getJsxAttr(node, attrName)
        if (!attr) {
          diagnostics.push(
            buildDiagnostic(
              'error',
              'WMCP_COMPILE_MISSING_ATTR',
              `${attrName} 속성이 필요합니다.`,
              relativePath,
              line,
              column,
            ),
          )
          hasHardError = true
          continue
        }

        const parsed = jsxAttrToStaticString(attr)
        if (!parsed.isStatic) {
          diagnostics.push(
            buildDiagnostic(
              'error',
              'WMCP_COMPILE_DYNAMIC_ATTR',
              `${attrName}는 정적 문자열이어야 합니다.`,
              relativePath,
              attr.loc?.start.line ?? line,
              attr.loc?.start.column ?? column,
            ),
          )
          hasHardError = true
          continue
        }

        if (!parsed.value || parsed.value.trim() === '') {
          diagnostics.push(
            buildDiagnostic(
              'error',
              'WMCP_COMPILE_EMPTY_ATTR',
              `${attrName} 값은 비어 있을 수 없습니다.`,
              relativePath,
              attr.loc?.start.line ?? line,
              attr.loc?.start.column ?? column,
            ),
          )
          hasHardError = true
          continue
        }

        staticValues[attrName] = parsed.value.trim()
      }

      const keyAttr = getJsxAttr(node, 'data-mcp-key')
      const keyParsed = jsxAttrToStaticString(keyAttr)
      let explicitKey: string | undefined

      if (keyAttr) {
        if (!keyParsed.isStatic || !keyParsed.value || keyParsed.value.trim() === '') {
          diagnostics.push(
            buildDiagnostic(
              'error',
              'WMCP_COMPILE_DYNAMIC_ATTR',
              'data-mcp-key는 정적 문자열이어야 합니다.',
              relativePath,
              keyAttr.loc?.start.line ?? line,
              keyAttr.loc?.start.column ?? column,
            ),
          )
          hasHardError = true
        } else {
          explicitKey = keyParsed.value.trim()
        }
      }

      const targetId = explicitKey || mkTargetId(relativePath, line, column)

      const group = resolveJsxGroupContext(
        path,
        options,
        relativePath,
        diagnostics,
        line,
        column,
      )

      if (!emitTrackingAttr && (!options.preserveSourceAttrs || !explicitKey)) {
        diagnostics.push(
          buildDiagnostic(
            'error',
            'WMCP_COMPILE_MISSING_ATTR',
            'emitTrackingAttr=none 사용 시 data-mcp-key를 명시하고 preserveSourceAttrs=true 여야 합니다.',
            relativePath,
            line,
            column,
          ),
        )
        hasHardError = true
      }

      if (hasHardError) return

      const action = staticValues['data-mcp-action']
      const targetName = staticValues['data-mcp-name']
      const targetDesc = staticValues['data-mcp-desc']

      const supported = action === 'click'
      const status: WebMcpToolStatus = supported ? 'active' : 'skipped_unsupported_action'

      if (!supported) {
        const diagLevel =
          options.unsupportedActionHandling === 'error' ? 'error' : 'warning'
        diagnostics.push(
          buildDiagnostic(
            diagLevel,
            'WMCP_COMPILE_UNSUPPORTED_ACTION',
            `지원하지 않는 action '${action}' 입니다. v1에서는 click만 활성화됩니다.`,
            relativePath,
            line,
            column,
          ),
        )
      }

      if (emitTrackingAttr && node.end != null) {
        edits.push({
          start: node.end - 1,
          end: node.end - 1,
          content: ` ${DOM_KEY_ATTR}="${targetId}"`,
        })
      }

      const selector = emitTrackingAttr
        ? `[${DOM_KEY_ATTR}="${targetId}"]`
        : `[data-mcp-key="${targetId}"]`

      entries.push(
        toCompiledTarget({
          action,
          status,
          group,
          targetId,
          targetName,
          targetDesc,
          selector,
          relativePath,
          sourceLine: line,
          sourceColumn: column,
        }),
      )
    },
  })

  if (!edits.length) {
    return { code, changed: false, entries, diagnostics }
  }

  const ms = new MagicString(code)
  const overwriteEdits = edits
    .filter(edit => edit.start !== edit.end)
    .sort((a, b) => b.start - a.start)
  const insertEdits = edits
    .filter(edit => edit.start === edit.end)
    .sort((a, b) => b.start - a.start)

  for (const edit of overwriteEdits) {
    ms.overwrite(edit.start, edit.end, edit.content)
  }
  for (const edit of insertEdits) {
    ms.appendLeft(edit.start, edit.content)
  }

  return {
    code: ms.toString(),
    changed: true,
    entries,
    diagnostics,
  }
}

export function compileSource(
  code: string,
  relativePath: string,
  options: ResolvedWebMcpDomOptions,
  isDevBuild = false,
): CompileResult {
  const emitTrackingAttr = options.emitTrackingAttr !== 'none'

  if (isHtmlLike(relativePath)) {
    return htmlCompile(code, relativePath, options, emitTrackingAttr)
  }

  if (canContainJsx(relativePath)) {
    return jsxCompile(code, relativePath, options, emitTrackingAttr)
  }

  return {
    code,
    changed: false,
    entries: [],
    diagnostics: [],
  }
}
