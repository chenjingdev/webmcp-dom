import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initializeWebMcpPolyfill } from '@webmcp-dom/polyfill'
import { initializeWebMcpCompanionClient } from '@webmcp-dom/companion-client'
import App from './App.tsx'

initializeWebMcpPolyfill({
  nativeModelContextBehavior: 'patch',
  installTestingShim: true,
})

// register는 폴리필 초기화 뒤에 로드
void import('@webmcp-dom/build-core/register')

initializeWebMcpCompanionClient({
  appId: '@webmcp-apps/mcp-test-page',
  onGuideRequired: reason => {
    if (reason === 'companion-unavailable') {
      console.warn('[mcp-test-page] companion이 실행되지 않았습니다. webmcp-companion start를 실행하세요.')
    }
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
