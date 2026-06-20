import { describe, expect, it } from 'vitest'

import {
  parseToolPolicy,
  isToolDisabledByPolicy,
  isWriteBlockedByPathPolicy,
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

  it('disables write tools on read-only intent phrases (只读不改)', () => {
    // 「只读/只看不改」等正面表达意图是「只读不写」，应禁用写入工具但保留读取
    expect(parseToolPolicy('只读不改')).toEqual({ allowRead: true, allowWrite: false })
    expect(parseToolPolicy('只看不写')).toEqual({ allowRead: true, allowWrite: false })
    expect(parseToolPolicy('只分析不修改文件')).toEqual({ allowRead: true, allowWrite: false })
    expect(parseToolPolicy('这轮只看不改文件')).toEqual({ allowRead: true, allowWrite: false })
  })

  it('sets allowedWritePath on current-file intent when activeFilePath is provided', () => {
    expect(parseToolPolicy('只改当前文件', 'chapters/001.txt')).toEqual({
      allowRead: true,
      allowWrite: true,
      allowedWritePath: 'chapters/001.txt',
    })
    expect(parseToolPolicy('就在这个文件里改', 'chapters/002.txt')).toEqual({
      allowRead: true,
      allowWrite: true,
      allowedWritePath: 'chapters/002.txt',
    })
    expect(parseToolPolicy('别动其他文件', 'elements/characters.md')).toEqual({
      allowRead: true,
      allowWrite: true,
      allowedWritePath: 'elements/characters.md',
    })
    expect(parseToolPolicy('只改这个文件', 'prompts/system.md')).toEqual({
      allowRead: true,
      allowWrite: true,
      allowedWritePath: 'prompts/system.md',
    })
  })

  it('normalizes activeFilePath when setting allowedWritePath', () => {
    // 反斜杠 / 前后空白在 normalizeProjectPath 里会被规整
    expect(parseToolPolicy('只改当前文件', ' chapters\\001.txt ')).toEqual({
      allowRead: true,
      allowWrite: true,
      allowedWritePath: 'chapters/001.txt',
    })
  })

  it('degrades to allowWrite:false on current-file intent when activeFilePath is empty', () => {
    // 用户要求「只改当前文件」但没有打开的文件，无法确定白名单，保守禁写
    expect(parseToolPolicy('只改当前文件')).toEqual({ allowRead: true, allowWrite: false })
    expect(parseToolPolicy('只改这个文件', undefined)).toEqual({ allowRead: true, allowWrite: false })
    expect(parseToolPolicy('别动其他文件', null)).toEqual({ allowRead: true, allowWrite: false })
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

describe('isWriteBlockedByPathPolicy', () => {
  it('does not block when policy has no allowedWritePath', () => {
    expect(isWriteBlockedByPathPolicy('EditFile', { path: 'chapters/001.txt' }, DEFAULT_TOOL_POLICY)).toEqual({ blocked: false })
    expect(isWriteBlockedByPathPolicy('EditFile', { path: 'chapters/001.txt' }, undefined)).toEqual({ blocked: false })
  })

  it('does not block read-only tools', () => {
    const policy = { allowRead: true, allowWrite: true, allowedWritePath: 'chapters/001.txt' }
    expect(isWriteBlockedByPathPolicy('ReadFile', { path: 'chapters/002.txt' }, policy)).toEqual({ blocked: false })
    expect(isWriteBlockedByPathPolicy('RagSearch', { query: 'something' }, policy)).toEqual({ blocked: false })
  })

  it('always blocks RenameFile under path constraint', () => {
    const policy = { allowRead: true, allowWrite: true, allowedWritePath: 'chapters/001.txt' }
    const result = isWriteBlockedByPathPolicy('RenameFile', { fromPath: 'chapters/001.txt', toPath: 'chapters/002.txt' }, policy)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('重命名')
  })

  it('blocks EditFile/CreateFile/DeleteFile when path differs from allowed', () => {
    const policy = { allowRead: true, allowWrite: true, allowedWritePath: 'chapters/001.txt' }
    expect(isWriteBlockedByPathPolicy('EditFile', { path: 'chapters/002.txt' }, policy).blocked).toBe(true)
    expect(isWriteBlockedByPathPolicy('CreateFile', { path: 'outline.txt' }, policy).blocked).toBe(true)
    expect(isWriteBlockedByPathPolicy('DeleteFile', { path: 'elements/characters.md' }, policy).blocked).toBe(true)
  })

  it('allows EditFile/CreateFile/DeleteFile when path matches allowed', () => {
    const policy = { allowRead: true, allowWrite: true, allowedWritePath: 'chapters/001.txt' }
    expect(isWriteBlockedByPathPolicy('EditFile', { path: 'chapters/001.txt' }, policy).blocked).toBe(false)
    expect(isWriteBlockedByPathPolicy('DeleteFile', { path: 'chapters/001.txt' }, policy).blocked).toBe(false)
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

  it('mentions current-file constraint when allowedWritePath is set', () => {
    const desc = describeActivePolicy({ allowRead: true, allowWrite: true, allowedWritePath: 'chapters/001.txt' })
    expect(desc).toContain('chapters/001.txt')
    expect(desc).toContain('RenameFile')
  })
})
