import { inspectBrowserEnvironment } from '@novai/core/services/environment-service'
import type { EnvironmentReportView } from '@novai/core/services/types'

// 浏览器环境能力在页面生命周期内不会变化，模块加载时检测一次全局共享（同 useToast 的单例模式）。
const report: EnvironmentReportView = inspectBrowserEnvironment()

export function useEnvironmentCheck() {
  return { report }
}
