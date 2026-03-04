import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initializeWebMcpPolyfill } from '@webmcp-dom/polyfill'
import App from './App.tsx'

initializeWebMcpPolyfill({
  nativeModelContextBehavior: 'patch',
  installTestingShim: true,
})

// register는 폴리필 초기화 뒤에 로드
void import('@webmcp-dom/build-core/register')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
