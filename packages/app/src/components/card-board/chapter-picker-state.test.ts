import { describe, expect, it } from 'vitest'

import {
  appendUniqueValue,
  badgeForResolution,
  describeChapterValue,
  displayForResolution,
  moveValueAt,
  nextHighlightIndex,
  removeValueAt,
  validateCreateForm,
} from './chapter-picker-state'
import { buildChapterCatalog } from '@novai/core/services/chapter-service'
import type { ChapterTreeSourceNode } from '@novai/core/services/chapter-service'

function tree(...paths: string[]): ChapterTreeSourceNode[] {
  const root: ChapterTreeSourceNode[] = []
  const chapters: ChapterTreeSourceNode & { children: ChapterTreeSourceNode[] } = {
    kind: 'directory',
    name: 'chapters',
    path: 'chapters',
    children: [],
  }
  root.push(chapters)

  for (const path of paths) {
    const segments = path.split('/')
    let current = chapters
    for (let depth = 1; depth < segments.length - 1; depth += 1) {
      const name = segments[depth]!
      let next = current.children.find(node => node.kind === 'directory' && node.name === name)
      if (!next) {
        next = { kind: 'directory', name, path: segments.slice(0, depth + 1).join('/'), children: [] }
        current.children.push(next)
      }
      current = next as typeof current
    }
    const fileName = segments[segments.length - 1]!
    current.children.push({ kind: 'file', name: fileName, path })
  }
  return root
}

describe('nextHighlightIndex（键盘高亮）', () => {
  it('null 起点：下落首项、上落末项', () => {
    expect(nextHighlightIndex(null, 3, 1)).toBe(0)
    expect(nextHighlightIndex(null, 3, -1)).toBe(2)
  })

  it('循环移动', () => {
    expect(nextHighlightIndex(1, 3, 1)).toBe(2)
    expect(nextHighlightIndex(2, 3, 1)).toBe(0)
    expect(nextHighlightIndex(0, 3, -1)).toBe(2)
  })

  it('没有可选项保持 null', () => {
    expect(nextHighlightIndex(0, 0, 1)).toBeNull()
    expect(nextHighlightIndex(null, 0, -1)).toBeNull()
  })
})

describe('多选标签操作', () => {
  it('追加保留全部既有项与顺序；重复引用不重复添加', () => {
    expect(appendUniqueValue(['第001章-a', '第003章-c'], '第005章-e')).toEqual([
      '第001章-a',
      '第003章-c',
      '第005章-e',
    ])
    expect(appendUniqueValue(['第001章-a'], '第001章-a')).toEqual(['第001章-a'])
  })

  it('删除指定位置', () => {
    expect(removeValueAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
    expect(removeValueAt(['a'], 0)).toEqual([])
  })

  it('重排与相邻交换；边界不动', () => {
    expect(moveValueAt(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(moveValueAt(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
    expect(moveValueAt(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveValueAt(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
  })
})

describe('validateCreateForm（新建表单校验）', () => {
  it('章号必须是正整数', () => {
    expect(validateCreateForm('abc', '标题')).toEqual({ ok: false, error: '章号必须是正整数' })
    expect(validateCreateForm('', '标题')).toEqual({ ok: false, error: '章号必须是正整数' })
    expect(validateCreateForm('0', '标题')).toEqual({ ok: false, error: '章号必须是正整数' })
    expect(validateCreateForm('-3', '标题')).toEqual({ ok: false, error: '章号必须是正整数' })
    expect(validateCreateForm('2.5', '标题')).toEqual({ ok: false, error: '章号必须是正整数' })
  })

  it('合法输入：章号数值化，标题去空白、空转 null（服务端按「未命名」生成）', () => {
    expect(validateCreateForm(' 12 ', '  夜行  ')).toEqual({ ok: true, chapterNumber: 12, title: '夜行' })
    expect(validateCreateForm('12', '   ')).toEqual({ ok: true, chapterNumber: 12, title: null })
  })
})

describe('引用解析展示', () => {
  const catalog = buildChapterCatalog(tree(
    'chapters/第一卷/第003章-风雨.txt',
    'chapters/第012章-夜行.txt',
    'chapters/第012章-夜行-草稿副本.txt',
  ))

  it('未就绪目录：只显示原始引用，不产生徽标（已选项不依赖列表读取）', () => {
    expect(describeChapterValue(catalog, false, '第一卷/第003章-风雨')).toEqual({
      text: '第一卷/第003章-风雨',
      badge: null,
    })
    expect(describeChapterValue(catalog, false, null)).toEqual({ text: '未设置', badge: null })
  })

  it('正常命中：主文案带卷与标题，无徽标', () => {
    const { text, badge } = describeChapterValue(catalog, true, '第一卷/第003章')
    expect(text).toBe('第一卷/第003章 风雨')
    expect(badge).toBeNull()
  })

  it('章号命中但引用信息与当前不一致：恢复展示徽标（无法确认是否原章节）', () => {
    const { badge } = describeChapterValue(catalog, true, '第003章-旧标题')
    expect(badge).toEqual({ label: '按章号位置恢复展示，无法确认是否原章节', tone: 'warn' })
  })

  it('章号缺失：该章号当前没有章节', () => {
    expect(badgeForResolution({ kind: 'missing', number: 9 })).toEqual({
      label: '第9章当前没有章节',
      tone: 'warn',
    })
  })

  it('重复章号：待消歧徽标；主文案退回原始引用', () => {
    const { text, badge } = describeChapterValue(catalog, true, '第012章-夜行')
    expect(badge).toEqual({ label: '章号重复，待消歧', tone: 'danger' })
    expect(text).toBe('第012章-夜行')
  })

  it('自由文本：无法解析徽标，主文案保留原文', () => {
    const { text, badge } = describeChapterValue(catalog, true, '第三章左右再收')
    expect(text).toBe('第三章左右再收')
    expect(badge).toEqual({ label: '原文无法解析为章节引用', tone: 'danger' })
  })

  it('displayForResolution 空值 → 未设置', () => {
    expect(displayForResolution({ kind: 'unset' }, null)).toBe('未设置')
  })
})
