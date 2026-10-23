import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectBrowserEnvironment } from './environment-service'

// vitest 跑在 node 默认环境，浏览器全局全部缺失，用 stubGlobal 桩出受控环境。
function stubBrowserEnvironment(options: {
  userAgent?: string
  isSecureContext?: boolean
  showDirectoryPicker?: boolean
  supportsColorMix?: boolean
}) {
  vi.stubGlobal('navigator', {
    userAgent: options.userAgent
      ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  vi.stubGlobal('window', {
    isSecureContext: options.isSecureContext ?? true,
    ...(options.showDirectoryPicker === false ? {} : { showDirectoryPicker: async () => {} }),
  })
  vi.stubGlobal('CSS', {
    supports: (feature: string, value: string) =>
      feature === 'color' && value === 'color-mix(in oklab, red, white)' && (options.supportsColorMix ?? true),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('inspectBrowserEnvironment', () => {
  it('现代 Chromium 桌面环境全部通过', () => {
    stubBrowserEnvironment({})

    const report = inspectBrowserEnvironment()

    expect(report.usable).toBe(true)
    expect(report.blocker).toBeNull()
    expect(report.blockerMessage).toBe('')
    expect(report.userAgent).toContain('Chrome/131')
  })

  it('Firefox 缺少目录选择 API 时判定不可用', () => {
    stubBrowserEnvironment({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
      showDirectoryPicker: false,
    })

    const report = inspectBrowserEnvironment()

    expect(report.usable).toBe(false)
    expect(report.blocker).toBe('file-system-access-missing')
    expect(report.blockerMessage).toContain('360')
  })

  it('文件 API 在但 CSS 引擎过旧（86-110 灰区内核）时判定不可用', () => {
    stubBrowserEnvironment({ supportsColorMix: false })

    const report = inspectBrowserEnvironment()

    expect(report.usable).toBe(false)
    expect(report.blocker).toBe('css-engine-outdated')
    expect(report.blockerMessage).toContain('升级')
  })

  it('非安全上下文优先于文件 API 缺失（此时 API 必然不暴露）', () => {
    stubBrowserEnvironment({ isSecureContext: false, showDirectoryPicker: false })

    const report = inspectBrowserEnvironment()

    expect(report.usable).toBe(false)
    expect(report.blocker).toBe('insecure-context')
  })

  it('微信 UA 命中内嵌浏览器判定（最高优先级，即使其余能力齐全）', () => {
    stubBrowserEnvironment({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/3.14.0.65',
    })

    const report = inspectBrowserEnvironment()

    expect(report.usable).toBe(false)
    expect(report.blocker).toBe('embedded-webview')
    expect(report.blockerMessage).toContain('复制本页链接')
  })

  it('Android WebView 的 "; wv)" UA 标记命中内嵌浏览器判定', () => {
    stubBrowserEnvironment({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36; wv)',
    })

    const report = inspectBrowserEnvironment()

    expect(report.usable).toBe(false)
    expect(report.blocker).toBe('embedded-webview')
  })

  it('浏览器全局缺失（node/构建环境）时判定不可用', () => {
    vi.stubGlobal('navigator', { userAgent: 'node-test' })

    const report = inspectBrowserEnvironment()

    expect(report.usable).toBe(false)
    expect(report.blocker).toBe('insecure-context')
  })
})
