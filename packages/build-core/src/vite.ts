import { webMcpDomUnplugin } from './plugin/index'
import type { WebMcpDomPluginOptions } from './types'

// NOTE: linked-local installs can end up with duplicate Vite type instances.
// Keep the public return type broad to avoid cross-package type-identity errors.
export default function webMcpDomPlugin(options?: WebMcpDomPluginOptions): any {
  return webMcpDomUnplugin.vite(options) as any
}
