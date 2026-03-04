declare module '@webmcp-dom/build-core/manifest' {
  import type { WebMcpManifest, WebMcpRuntimeOptions } from './types'
  export const runtimeOptions: WebMcpRuntimeOptions
  const manifest: WebMcpManifest
  export default manifest
}

declare module 'webmcp-dom/manifest' {
  import type { WebMcpManifest, WebMcpRuntimeOptions } from './types'
  export const runtimeOptions: WebMcpRuntimeOptions
  const manifest: WebMcpManifest
  export default manifest
}

declare module 'virtual:webmcp-dom/manifest' {
  import type { WebMcpManifest, WebMcpRuntimeOptions } from './types'
  export const runtimeOptions: WebMcpRuntimeOptions
  const manifest: WebMcpManifest
  export default manifest
}
