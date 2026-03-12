import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/ocs-lifecycle-analyzer/',
  build: {
    minify: false,
    sourcemap: true,
  },
  server: {
    open: true
  }
})
