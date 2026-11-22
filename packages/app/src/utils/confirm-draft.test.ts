import { describe, expect, it } from 'vitest'

import { applyEditCandidate, resolveConfirmDraftBranch } from './confirm-draft'

/**
 * 确认面板五分支（数据安全计划第二波验收 4）：
 * 无草稿 / 有草稿磁盘未变 / 有草稿且磁盘已变 / 磁盘不可读 / 文件不存在——
 * 只有第一类可以按原流程直接同意。
 */
describe('resolveConfirmDraftBranch 确认面板分支判定', () => {
  const draft = { content: '人工草稿', baseContent: '磁盘基线' }

  it('无草稿且磁盘可读：none（原流程可直接同意）', () => {
    expect(resolveConfirmDraftBranch({
      probe: { kind: 'ok', content: '磁盘内容' },
      draftEntry: null,
      isCreate: false,
    })).toBe('none')
  })

  it('有草稿且磁盘未变（草稿基线==磁盘）：draft-clean，阻止直接同意', () => {
    expect(resolveConfirmDraftBranch({
      probe: { kind: 'ok', content: '磁盘基线' },
      draftEntry: draft,
      isCreate: false,
    })).toBe('draft-clean')
  })

  it('有草稿且磁盘已变（AI 已写盘）：draft-diverged，禁止直接同意', () => {
    expect(resolveConfirmDraftBranch({
      probe: { kind: 'ok', content: 'AI 修改后的磁盘' },
      draftEntry: draft,
      isCreate: false,
    })).toBe('draft-diverged')
  })

  it('磁盘读取失败：unreadable（与文件不存在分开提示，不能同意）', () => {
    expect(resolveConfirmDraftBranch({
      probe: { kind: 'unreadable' },
      draftEntry: null,
      isCreate: false,
    })).toBe('unreadable')
    // 有草稿时同样以不可读优先（无法确认安全）
    expect(resolveConfirmDraftBranch({
      probe: { kind: 'unreadable' },
      draftEntry: draft,
      isCreate: false,
    })).toBe('unreadable')
  })

  it('文件不存在：missing（edit 目标没了 / create 目标被占用）', () => {
    expect(resolveConfirmDraftBranch({
      probe: { kind: 'missing' },
      draftEntry: null,
      isCreate: false,
    })).toBe('missing')
    // create 探测到内容 = 目标被占用，同样 missing 语义
    expect(resolveConfirmDraftBranch({
      probe: { kind: 'ok', content: '已存在的目标' },
      draftEntry: null,
      isCreate: true,
    })).toBe('missing')
  })

  it('create 目标不存在是正常空目标：none，可直接同意（不误报占用）', () => {
    expect(resolveConfirmDraftBranch({
      probe: { kind: 'missing' },
      draftEntry: null,
      isCreate: true,
    })).toBe('none')
  })

  it('create 目标不存在但有人工草稿：仍按草稿分支阻止直接同意', () => {
    expect(resolveConfirmDraftBranch({
      probe: { kind: 'missing' },
      draftEntry: { content: '草稿', baseContent: '' },
      isCreate: true,
    })).toBe('draft-clean')
    expect(resolveConfirmDraftBranch({
      probe: { kind: 'missing' },
      draftEntry: draft,
      isCreate: true,
    })).toBe('draft-diverged')
  })

  it('create 目标不可读：unreadable（不当作不存在放行）', () => {
    expect(resolveConfirmDraftBranch({
      probe: { kind: 'unreadable' },
      draftEntry: null,
      isCreate: true,
    })).toBe('unreadable')
  })
})

describe('applyEditCandidate 候选写盘结果合成', () => {
  it('edit 默认只替换第一处', () => {
    expect(applyEditCandidate('A 旧 B 旧 C', { kind: 'edit', oldText: '旧', newText: '新' }))
      .toBe('A 新 B 旧 C')
  })

  it('edit replaceAll 替换全部出现', () => {
    expect(applyEditCandidate('A 旧 B 旧 C', { kind: 'edit', oldText: '旧', newText: '新', replaceAll: true }))
      .toBe('A 新 B 新 C')
  })

  it('create 即候选内容', () => {
    expect(applyEditCandidate('', { kind: 'create', content: '新文件全文' })).toBe('新文件全文')
  })

  it('候选原文不在磁盘：原样返回（外部分支另行提示）', () => {
    expect(applyEditCandidate('磁盘内容', { kind: 'edit', oldText: '已消失的原文', newText: '新' }))
      .toBe('磁盘内容')
  })
})
