import { webMcpDomUnplugin } from './plugin/index'
import type { WebMcpDomPluginOptions } from './types'

export default function webMcpDomRollupPlugin(options?: WebMcpDomPluginOptions): any {
  return webMcpDomUnplugin.rollup(options) as any
}
