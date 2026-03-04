import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import webMcpDomPlugin from '@webmcp-dom/build-core'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), webMcpDomPlugin()],
})
