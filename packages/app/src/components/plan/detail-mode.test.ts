import { describe, expect, it } from 'vitest'

import { resetDetailMode, shouldReturnToPreviewAfterSave } from './detail-mode'

describe('详情视图状态机', () => {
  it('卡片切换回到预览', () => {
    expect(resetDetailMode()).toBe('preview')
  })

  it('保存成功（保存中结束且未保存修改清零）回到预览', () => {
    expect(shouldReturnToPreviewAfterSave(true, false, false)).toBe(true)
  })

  it('保存冲突或失败：未保存修改仍在，保持编辑态', () => {
    expect(shouldReturnToPreviewAfterSave(true, false, true)).toBe(false)
  })

  it('未经历保存中（无修改点保存）不切视图', () => {
    expect(shouldReturnToPreviewAfterSave(false, false, false)).toBe(false)
  })

  it('保存刚开始（进入保存中）不切视图', () => {
    expect(shouldReturnToPreviewAfterSave(false, true, true)).toBe(false)
  })
})
