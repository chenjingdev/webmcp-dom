import manifest, { runtimeOptions } from '@webmcp-dom/build-core/manifest'
import { registerCompiledWebMcpTools } from './runtime/register-tools'

registerCompiledWebMcpTools(manifest, runtimeOptions)
