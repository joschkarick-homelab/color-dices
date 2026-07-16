import { defineConfig } from 'vite'

export default defineConfig({
  // Relatives Base, damit der Build sowohl unter GitHub Pages
  // (https://<user>.github.io/qwixx/) als auch hinter nginx im Homelab läuft.
  base: './',
  build: {
    target: 'es2022',
  },
})
