import { beforeEach, describe, expect, it } from 'vitest'

import { useToast } from './useToast'

/**
 * 错误提示持续性（数据安全计划第三波 F11，自动化验收 4）：
 * 普通错误默认持续显示到用户手动关闭（不设自动时长）；
 * 成功、普通信息与归档撤销保持既定时长（3 秒缺省 / 撤销 5 秒）不回归。
 */
describe('useToast 错误提示持续性', () => {
  beforeEach(() => {
    const { toasts } = useToast()
    toasts.value.splice(0)
  })

  it('error 默认 persistent：不安排自动关闭时长', () => {
    const toast = useToast()
    toast.error('保存失败：磁盘版本已变化')

    expect(toast.toasts.value).toHaveLength(1)
    const item = toast.toasts.value[0]
    expect(item.type).toBe('error')
    expect(item.persistent).toBe(true)
    expect(item.duration).toBeUndefined()
  })

  it('error 显式传 duration：按指定时长自动关闭（不 persistent）', () => {
    const toast = useToast()
    toast.error('轻量错误', { duration: 8000 })

    const item = toast.toasts.value[0]
    expect(item.persistent).not.toBe(true)
    expect(item.duration).toBe(8000)
  })

  it('success / info / warning 不 persistent：保持默认 3 秒时长', () => {
    const toast = useToast()
    toast.success('已保存')
    toast.info('已恢复 2 份草稿')
    toast.warning('该文件已被外部修改')

    for (const item of toast.toasts.value) {
      expect(item.persistent).toBeUndefined()
      expect(item.duration).toBeUndefined()
    }
  })

  it('归档撤销（actions + duration 5000）：时长透传不回归', () => {
    const toast = useToast()
    toast.success('已归档「对话」', {
      duration: 5000,
      actions: [{ label: '撤销', run: () => {} }],
    })

    const item = toast.toasts.value[0]
    expect(item.duration).toBe(5000)
    expect(item.actions).toHaveLength(1)
    expect(item.persistent).toBeUndefined()
  })

  it('remove 关闭指定提示（持续错误的唯一出口）', () => {
    const toast = useToast()
    toast.error('持续错误')
    const id = toast.toasts.value[0].id
    toast.remove(id)
    expect(toast.toasts.value).toHaveLength(0)
  })
})
