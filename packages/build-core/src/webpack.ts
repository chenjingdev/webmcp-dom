import { webMcpDomUnplugin } from './plugin/index'
import type { WebMcpDomPluginOptions } from './types'

export default function webMcpDomWebpackPlugin(options?: WebMcpDomPluginOptions) {
  return webMcpDomUnplugin.webpack(options)
}
