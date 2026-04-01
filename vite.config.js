import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1]

export default defineConfig({
  plugins: [vue()],
  // GitHub Pages project sites are served from /<repo>/ during Actions builds.
  base: process.env.GITHUB_ACTIONS && repoName ? `/${repoName}/` : '/',
})
