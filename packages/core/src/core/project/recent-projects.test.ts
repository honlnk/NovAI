import { describe, expect, it, vi } from 'vitest'

import { hasProjectPermission, requestProjectPermission } from './recent-projects'

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

function createHandle(overrides: Partial<PermissionHandle> = {}): PermissionHandle {
  return {
    kind: 'directory',
    name: 'novel',
    ...overrides,
  } as PermissionHandle
}

describe('project permission', () => {
  it('已授权：查询返回 true，请求不再弹授权框直接返回 true', async () => {
    const requestPermission = vi.fn(async () => 'granted' as PermissionState)
    const handle = createHandle({
      queryPermission: async () => 'granted',
      requestPermission,
    })

    await expect(hasProjectPermission(handle)).resolves.toBe(true)
    await expect(requestProjectPermission(handle)).resolves.toBe(true)
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('未授权：请求后浏览器返回拒绝，结果为 false', async () => {
    const handle = createHandle({
      queryPermission: async () => 'prompt',
      requestPermission: async () => 'denied',
    })

    await expect(hasProjectPermission(handle)).resolves.toBe(false)
    await expect(requestProjectPermission(handle)).resolves.toBe(false)
  })

  it('请求权限抛异常（没有用户点击时浏览器直接拒绝）：按未获授权处理，不向上抛出', async () => {
    const handle = createHandle({
      queryPermission: async () => 'prompt',
      requestPermission: async () => {
        throw new DOMException('Permission request was not triggered by user activation', 'NotAllowedError')
      },
    })

    await expect(requestProjectPermission(handle)).resolves.toBe(false)
  })

  it('查询权限抛异常：按未获授权处理，不向上抛出', async () => {
    const requestPermission = vi.fn(async () => 'granted' as PermissionState)
    const handle = createHandle({
      queryPermission: async () => {
        throw new DOMException('Invalid state', 'InvalidStateError')
      },
      requestPermission,
    })

    await expect(hasProjectPermission(handle)).resolves.toBe(false)
    // 查询失败不等于已授权：仍然走一次请求
    await expect(requestProjectPermission(handle)).resolves.toBe(true)
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('浏览器不支持权限接口：一律 false，不抛错', async () => {
    const handle = createHandle()

    await expect(hasProjectPermission(handle)).resolves.toBe(false)
    await expect(requestProjectPermission(handle)).resolves.toBe(false)
  })
})
