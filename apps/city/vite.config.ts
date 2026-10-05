import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// SharedArrayBuffer (simulation workers) and performance.measureUserAgentSpecificMemory() both
// require a cross-origin isolated page. Production hosting must send the same two headers.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  build: { target: 'es2023' },
});
