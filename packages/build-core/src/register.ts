import manifest, { runtimeOptions } from '@webmcp-dom/build-core/manifest'
import { WEBMCP_MANIFEST_UPDATE_EVENT } from './hmr-events'
import { registerCompiledWebMcpTools } from './runtime/register-tools'

let registration = registerCompiledWebMcpTools(manifest, runtimeOptions)

function applyRegistrationUpdate(
  nextManifest: typeof manifest,
  nextRuntimeOptions: typeof runtimeOptions,
): void {
  registration.dispose()
  registration = registerCompiledWebMcpTools(nextManifest, nextRuntimeOptions)
}

const hot = (
  import.meta as ImportMeta & {
    hot?: {
      accept: (
        dep: string,
        cb: (mod: {
          default: typeof manifest
          runtimeOptions?: typeof runtimeOptions
        }) => void,
      ) => void
      on: (
        event: string,
        cb: (data: {
          manifest?: typeof manifest
          runtimeOptions?: typeof runtimeOptions
        }) => void,
      ) => void
      dispose: (cb: () => void) => void
    }
  }
).hot

if (hot) {
  hot.accept('@webmcp-dom/build-core/manifest', mod => {
    const nextManifest = mod?.default ?? manifest
    const nextRuntimeOptions = mod?.runtimeOptions ?? runtimeOptions
    applyRegistrationUpdate(nextManifest, nextRuntimeOptions)
  })

  // TODO(webmcp-dom): webpack/rollup dev 채널도 이 이벤트 계약으로 합류시킨다.
  hot.on(WEBMCP_MANIFEST_UPDATE_EVENT, data => {
    const nextManifest = data?.manifest ?? manifest
    const nextRuntimeOptions = data?.runtimeOptions ?? runtimeOptions
    applyRegistrationUpdate(nextManifest, nextRuntimeOptions)
  })

  hot.dispose(() => {
    registration.dispose()
  })
}
