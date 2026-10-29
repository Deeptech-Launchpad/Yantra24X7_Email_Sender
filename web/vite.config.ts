import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development the screens run on 5173 and the API calls go to the app on 4300.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4300', '/t': 'http://localhost:4300' },
  },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
  },
})
