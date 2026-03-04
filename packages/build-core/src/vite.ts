import { webMcpDomUnplugin } from './plugin/index'
import type { WebMcpDomPluginOptions } from './types'

export default function webMcpDomPlugin(options?: WebMcpDomPluginOptions) {
  return webMcpDomUnplugin.vite(options)
}
