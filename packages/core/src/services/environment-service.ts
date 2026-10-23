import { isFileSystemAccessSupported } from '../core/fs/project-fs'
import type { EnvironmentBlockerReason, EnvironmentReportView } from './types'

/**
 * 内嵌/WebView 环境的 UA 标记：微信（含企业微信）、钉钉、飞书、Android WebView（"; wv)"）。
 * 这类环境即使内核版本达标，宿主 App 也会拦截文件授权弹窗，统一引导到系统浏览器打开。
 */
const EMBEDDED_WEBVIEW_UA_PATTERN = /MicroMessenger|WeChat|wxwork|DingTalk|Feishu|Lark|;\s*wv\)/

/**
 * Chromium 111（Tailwind CSS 4 的最低内核要求）起才支持 color-mix()，
 * 用它作 CSS 引擎门槛探针，挡住「文件 API 在、能选目录、但界面样式整页崩坏」的
 * 86-110 灰区旧内核（老版 QQ 浏览器 / 360 安全浏览器等）。
 */
const MODERN_CSS_PROBE = 'color-mix(in oklab, red, white)'

const BLOCKER_MESSAGES: Record<EnvironmentBlockerReason, string> = {
  'embedded-webview':
    '检测到你正在内嵌浏览器（如微信、钉钉、飞书）中打开 NovAI，本地文件读写能力在其中不可用。请复制本页链接，在 Chrome、Edge 或 360 浏览器中打开。',
  'insecure-context':
    '当前页面不是安全上下文（HTTPS 或 localhost）。NovAI 依赖的本地文件读写能力仅在安全上下文中可用，请通过 HTTPS 或 localhost 访问。',
  'file-system-access-missing':
    '当前浏览器不支持本地文件读写（File System Access API）。请使用 Chrome、Edge 或 360 浏览器的最新版本。',
  'css-engine-outdated':
    '当前浏览器内核版本过旧，无法正常显示 NovAI 界面。请将浏览器升级到最新版本，或改用 Chrome、Edge、360 浏览器。',
}

function isEmbeddedWebview(userAgent: string): boolean {
  return EMBEDDED_WEBVIEW_UA_PATTERN.test(userAgent)
}

function isSecureContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true
}

function supportsModernCss(): boolean {
  return (
    typeof CSS !== 'undefined'
    && typeof CSS.supports === 'function'
    && CSS.supports('color', MODERN_CSS_PROBE)
  )
}

/**
 * 对当前浏览器做一次性环境自检（同步、无副作用）。
 * usable=false 时 blocker/blockerMessage 指向首要阻塞原因：HomeView 据此整页替换为
 * 不可用提示，project-service 的入口断言复用同一份报告，保证两条路径文案一致。
 */
export function inspectBrowserEnvironment(): EnvironmentReportView {
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const blocker = detectBlocker(userAgent)

  return {
    usable: blocker === null,
    blocker,
    blockerMessage: blocker === null ? '' : BLOCKER_MESSAGES[blocker],
    userAgent,
  }
}

/**
 * 阻塞原因按优先级判定：内嵌浏览器 > 非安全上下文 > 文件 API 缺失 > CSS 引擎过旧。
 * 非安全上下文时文件 API 必然不暴露，此时报更根本的访问方式问题而不是误导用户换浏览器。
 */
function detectBlocker(userAgent: string): EnvironmentBlockerReason | null {
  if (isEmbeddedWebview(userAgent)) {
    return 'embedded-webview'
  }
  if (!isSecureContext()) {
    return 'insecure-context'
  }
  if (!isFileSystemAccessSupported()) {
    return 'file-system-access-missing'
  }
  if (!supportsModernCss()) {
    return 'css-engine-outdated'
  }
  return null
}
