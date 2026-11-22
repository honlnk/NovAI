import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // vue 插件：让 .test.ts 也能挂载 .vue 组件（此前组件挂载测试只能走不被
  // include 收录的 .spec.ts 命名，pnpm test 实际从未执行它们——2026-11-23 用户批准）
  plugins: [vue()],
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
})
