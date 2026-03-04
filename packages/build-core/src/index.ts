import webMcpDomPlugin from './vite'

export default webMcpDomPlugin
export { webMcpDomPlugin }
export { webMcpDomUnplugin } from './plugin/index'

export type {
  UnsupportedActionHandling,
  WebMcpDeclarativeCompat,
  WebMcpDiagnostic,
  WebMcpDomPluginOptions,
  WebMcpEmitTrackingAttr,
  WebMcpExposureMode,
  WebMcpGroupEntry,
  WebMcpManifest,
  WebMcpRuntimeOptions,
  WebMcpToolEntry,
  WebMcpToolStatus,
  WebMcpTargetEntry,
} from './types'

export { registerCompiledWebMcpTools } from './runtime/register-tools'
