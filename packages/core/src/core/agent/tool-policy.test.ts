import { describe, expect, it } from 'vitest'

import {
  parseToolPolicy,
  isToolDisabledByPolicy,
  describePolicyDenial,
  filterAvailableTools,
  describeActivePolicy,
  DEFAULT_TOOL_POLICY,
} from './tool-policy'

describe('parseToolPolicy', () => {
  it('returns default policy when there is no constraint', () => {
    expect(parseToolPolicy('帮我写下一章')).toEqual({ allowRead: true, allowWrite: true })
    expect(parseToolPolicy('总结一下这个故事')).toEqual({ allowRead: true, allowWrite: true })
    expect(parseToolPolicy('')).toEqual(DEFAULT_TOOL_POLICY)
  })

  it('disables read tools on read-denial phrases', () => {
    expect(parseToolPolicy('直接回答，不要读任何文件')).toEqual({ allowRead: false, allowWrite: true })
    expect(parseToolPolicy('别看文件，凭记忆回答')).toEqual({ allowRead: false, allowWrite: true })
    expect(parseToolPolicy('不要查项目文件')).toEqual({ allowRead: false, allowWrite: true })
    expect(parseToolPolicy('不用找文件了')).toEqual({ allowRead: false, allowWrite: true })
  })

  it('disables write tools on write-denial phrases', () => {
    expect(parseToolPolicy('只分析，不要写文件')).toEqual({ allowRead: true, allowWrite: false })
    expect(parseToolPolicy('别改这个章节')).toEqual({ allowRead: true, allowWrite: false })
    expect(parseToolPolicy('不要新建任何文件')).toEqual({ allowRead: true, allowWrite: false })
    expect(parseToolPolicy('不要删除这个文件')).toEqual({ allowRead: true, allowWrite: false })
  })

  it('disables both read and write on combined denials', () => {
    expect(parseToolPolicy('不要读也不要写文件')).toEqual({ allowRead: false, allowWrite: false })
    expect(parseToolPolicy('别看文件也别改')).toEqual({ allowRead: false, allowWrite: false })
  })

  it('handles generic denials like 不要碰文件', () => {
    expect(parseToolPolicy('不要碰任何文件')).toEqual({ allowRead: false, allowWrite: false })
    expect(parseToolPolicy('别动文件')).toEqual({ allowRead: false, allowWrite: false })
  })

  it('does not trigger on affirmative mentions', () => {
    // 「读」「写」单独出现但无否定前缀，不应禁用
    expect(parseToolPolicy('读一下第一章然后写第二章')).toEqual({ allowRead: true, allowWrite: true })
    expect(parseToolPolicy('请读取文件并修改')).toEqual({ allowRead: true, allowWrite: true })
  })
})

describe('isToolDisabledByPolicy', () => {
  const readOnlyTool = { isReadOnly: true }
  const writeTool = { isReadOnly: false }

  it('allows everything under default policy', () => {
    expect(isToolDisabledByPolicy(readOnlyTool, DEFAULT_TOOL_POLICY)).toBe(false)
    expect(isToolDisabledByPolicy(writeTool, DEFAULT_TOOL_POLICY)).toBe(false)
  })

  it('disables read tools when allowRead is false', () => {
    const policy = { allowRead: false, allowWrite: true }
    expect(isToolDisabledByPolicy(readOnlyTool, policy)).toBe(true)
    expect(isToolDisabledByPolicy(writeTool, policy)).toBe(false)
  })

  it('disables write tools when allowWrite is false', () => {
    const policy = { allowRead: true, allowWrite: false }
    expect(isToolDisabledByPolicy(readOnlyTool, policy)).toBe(false)
    expect(isToolDisabledByPolicy(writeTool, policy)).toBe(true)
  })
})

describe('describePolicyDenial', () => {
  it('describes read denial', () => {
    expect(describePolicyDenial({ isReadOnly: true }, { allowRead: false, allowWrite: true })).toContain('读取')
  })

  it('describes write denial', () => {
    expect(describePolicyDenial({ isReadOnly: false }, { allowRead: true, allowWrite: false })).toContain('修改')
  })
})

describe('filterAvailableTools', () => {
  const tools = [
    { name: 'ReadFile', isReadOnly: true },
    { name: 'ListDirectory', isReadOnly: true },
    { name: 'EditFile', isReadOnly: false },
    { name: 'CreateFile', isReadOnly: false },
  ]

  it('returns all tools when no policy', () => {
    expect(filterAvailableTools(tools, undefined)).toHaveLength(4)
  })

  it('filters out read tools when allowRead is false', () => {
    const result = filterAvailableTools(tools, { allowRead: false, allowWrite: true })
    expect(result.map((t) => t.name)).toEqual(['EditFile', 'CreateFile'])
  })

  it('filters out write tools when allowWrite is false', () => {
    const result = filterAvailableTools(tools, { allowRead: true, allowWrite: false })
    expect(result.map((t) => t.name)).toEqual(['ReadFile', 'ListDirectory'])
  })

  it('filters out everything when both are false', () => {
    expect(filterAvailableTools(tools, { allowRead: false, allowWrite: false })).toHaveLength(0)
  })
})

describe('describeActivePolicy', () => {
  it('returns empty string when no constraint', () => {
    expect(describeActivePolicy(DEFAULT_TOOL_POLICY)).toBe('')
  })

  it('mentions read tools when allowRead is false', () => {
    const desc = describeActivePolicy({ allowRead: false, allowWrite: true })
    expect(desc).toContain('读取类工具')
    expect(desc).not.toContain('写入类工具')
  })

  it('mentions write tools when allowWrite is false', () => {
    const desc = describeActivePolicy({ allowRead: true, allowWrite: false })
    expect(desc).toContain('写入类工具')
    expect(desc).not.toContain('读取类工具')
  })

  it('mentions both when both are false', () => {
    const desc = describeActivePolicy({ allowRead: false, allowWrite: false })
    expect(desc).toContain('读取类工具')
    expect(desc).toContain('写入类工具')
  })
})
