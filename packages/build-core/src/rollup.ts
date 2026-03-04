import { webMcpDomUnplugin } from './plugin/index'
import type { WebMcpDomPluginOptions } from './types'

export default function webMcpDomRollupPlugin(options?: WebMcpDomPluginOptions) {
  return webMcpDomUnplugin.rollup(options)
}
