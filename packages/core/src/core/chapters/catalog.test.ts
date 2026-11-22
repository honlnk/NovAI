import { describe, expect, it } from 'vitest'

import {
  buildChapterCatalog,
  chapterNumberPadWidth,
  filterChapterEntries,
  resolveChapterReference,
  suggestNextChapterNumber,
} from './catalog'
import { buildChapterFileName, resolveCreateTargetDirectory } from './create'
import type { ChapterTreeSourceNode as Node } from './catalog'

function file(path: string): Node {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { kind: 'file', name, path }
}

function dir(path: string, children: Node[]): Node {
  return { kind: 'directory', name: path.slice(path.lastIndexOf('/') + 1), path, children }
}

/** 组装「顶层含 chapters/」的项目树形态。 */
function project(...chaptersChildren: Node[]): Node[] {
  return [dir('chapters', chaptersChildren)]
}

describe('buildChapterCatalog', () => {
  it('空树 / 无 chapters 目录：空目录不抛错，maxNumber 为 null', () => {
    expect(buildChapterCatalog([])).toEqual({
      entries: [],
      duplicateNumbers: new Set(),
      maxNumber: null,
    })
    expect(buildChapterCatalog([file('novel.config.json')]).entries).toEqual([])
  })

  it('规范文件名解析出章号与标题，条目按章号升序', () => {
    const catalog = buildChapterCatalog(project(
      file('chapters/第012章-夜行.txt'),
      file('chapters/第001章-东宫听讼.txt'),
    ))

    expect(catalog.entries.map(entry => entry.number)).toEqual([1, 12])
    expect(catalog.entries[0]).toMatchObject({
      number: 1,
      title: '东宫听讼',
      fileName: '第001章-东宫听讼.txt',
      directory: '',
      path: 'chapters/第001章-东宫听讼.txt',
      ref: '第001章-东宫听讼',
      canonical: true,
    })
    expect(catalog.maxNumber).toBe(12)
    expect(catalog.duplicateNumbers.size).toBe(0)
  })

  it('卷/部子目录：directory 记录层级，ref 保留「卷/章」形态', () => {
    const catalog = buildChapterCatalog(project(
      dir('第一卷', [file('chapters/第一卷/第003章-风雨.txt')]),
      file('chapters/第010章-启程.txt'),
    ))

    expect(catalog.entries[0]).toMatchObject({
      number: 3,
      directory: '第一卷',
      ref: '第一卷/第003章-风雨',
    })
    expect(catalog.entries[1]).toMatchObject({ number: 10, directory: '', ref: '第010章-启程' })
  })

  it('非规范文件名（第1章-旧.txt）：能抢救章号，标题回退为去扩展名文件名并标记非规范', () => {
    const catalog = buildChapterCatalog(project(file('chapters/第1章-旧式.txt')))

    expect(catalog.entries[0]).toMatchObject({ number: 1, title: '第1章-旧式', canonical: false })
  })

  it('无「第N章」片段的文件跳过，不进目录', () => {
    const catalog = buildChapterCatalog(project(
      file('chapters/序章.md'),
      file('chapters/chapter-001.txt'),
      file('chapters/第005章-正常.txt'),
    ))

    expect(catalog.entries.map(entry => entry.number)).toEqual([5])
  })

  it('重复章号（草稿副本场景）：全部候选保留并进入 duplicateNumbers', () => {
    const catalog = buildChapterCatalog(project(
      file('chapters/第001章-东宫听讼.txt'),
      file('chapters/第001章-东宫听讼-草稿副本.txt'),
      file('chapters/第002章-谏臣风骨.txt'),
    ))

    expect(catalog.entries.filter(entry => entry.number === 1)).toHaveLength(2)
    expect(catalog.duplicateNumbers).toEqual(new Set([1]))
    expect(catalog.maxNumber).toBe(2)
  })
})

describe('resolveChapterReference（旧值核对）', () => {
  const catalog = buildChapterCatalog(project(
    dir('第一卷', [
      file('chapters/第一卷/第003章-风雨.txt'),
      file('chapters/第一卷/第005章-黎明.txt'),
    ]),
    file('chapters/第012章-夜行.txt'),
  ))

  it('空值 → unset', () => {
    expect(resolveChapterReference(catalog, null)).toEqual({ kind: 'unset' })
    expect(resolveChapterReference(catalog, '')).toEqual({ kind: 'unset' })
    expect(resolveChapterReference(catalog, '  ')).toEqual({ kind: 'unset' })
  })

  it('章号+卷+标题全中：精确命中，无身份不确定标记', () => {
    const resolution = resolveChapterReference(catalog, '第一卷/第003章-风雨')
    expect(resolution).toEqual({
      kind: 'chapter',
      entry: catalog.entries[0],
      uncertainIdentity: false,
    })
  })

  it('引用不带标题（第一卷/第003章）：按位置命中，不产生身份不确定', () => {
    const resolution = resolveChapterReference(catalog, '第一卷/第003章')
    expect(resolution.kind).toBe('chapter')
    expect(resolution.kind === 'chapter' && resolution.uncertainIdentity).toBe(false)
  })

  it('章号命中但标题已变（删后同号重建/改名同形）：按位置恢复展示并标记无法确认原章节', () => {
    const resolution = resolveChapterReference(catalog, '第一卷/第005章-旧的标题')
    expect(resolution.kind).toBe('chapter')
    expect(resolution.kind === 'chapter' && resolution.uncertainIdentity).toBe(true)
  })

  it('章号命中但卷不符：标记身份不确定', () => {
    const resolution = resolveChapterReference(catalog, '第二卷/第003章-风雨')
    expect(resolution.kind).toBe('chapter')
    expect(resolution.kind === 'chapter' && resolution.uncertainIdentity).toBe(true)
  })

  it('能解析章号但当前没有该章：missing（该章号当前没有章节）', () => {
    expect(resolveChapterReference(catalog, '第099章-不存在')).toEqual({ kind: 'missing', number: 99 })
    expect(resolveChapterReference(catalog, '第7章')).toEqual({ kind: 'missing', number: 7 })
  })

  it('章号命中多个候选：ambiguous，不自动选择', () => {
    const duplicated = buildChapterCatalog(project(
      file('chapters/第001章-正文.txt'),
      file('chapters/第001章-草稿.txt'),
    ))

    const resolution = resolveChapterReference(duplicated, '第001章-正文')
    expect(resolution.kind).toBe('ambiguous')
    expect(resolution.kind === 'ambiguous' && resolution.entries).toHaveLength(2)
  })

  it('无章号的自由文本：unparseable（兼容原文，不作正常章节匹配依据）', () => {
    expect(resolveChapterReference(catalog, '第三章左右再收')).toEqual({
      kind: 'unparseable',
      raw: '第三章左右再收',
    })
  })
})

describe('filterChapterEntries（选择器搜索）', () => {
  const catalog = buildChapterCatalog(project(
    dir('第一卷', [file('chapters/第一卷/第012章-夜行.txt')]),
    file('chapters/第113章-大结局.txt'),
  ))
  const { entries } = catalog

  it('空查询返回全部', () => {
    expect(filterChapterEntries(entries, '')).toHaveLength(2)
    expect(filterChapterEntries(entries, '   ')).toHaveLength(2)
  })

  it('数字查询按全本章号等值匹配：不匹配章号的数字段', () => {
    expect(filterChapterEntries(entries, '12').map(entry => entry.number)).toEqual([12])
    expect(filterChapterEntries(entries, '1')).toEqual([])
    expect(filterChapterEntries(entries, '012').map(entry => entry.number)).toEqual([12])
  })

  it('非数字查询按标题 / 目录 / 引用形态子串匹配（大小写不敏感）', () => {
    expect(filterChapterEntries(entries, '夜行').map(entry => entry.number)).toEqual([12])
    expect(filterChapterEntries(entries, '第一卷').map(entry => entry.number)).toEqual([12])
    expect(filterChapterEntries(entries, '大结局').map(entry => entry.number)).toEqual([113])
    expect(filterChapterEntries(entries, '没有的内容')).toEqual([])
  })
})

describe('章号建议与文件名组装', () => {
  it('建议下一章号：最大章号 + 1，无章节时 1', () => {
    expect(suggestNextChapterNumber(buildChapterCatalog(project(
      file('chapters/第007章-最新.txt'),
    )))).toBe(8)
    expect(suggestNextChapterNumber(buildChapterCatalog([]))).toBe(1)
  })

  it('补零宽度：至少 3 位，跟随最大章号宽度', () => {
    expect(chapterNumberPadWidth(buildChapterCatalog([]))).toBe(3)
    expect(chapterNumberPadWidth(buildChapterCatalog(project(file('chapters/第099章-x.txt'))))).toBe(3)
    expect(chapterNumberPadWidth(buildChapterCatalog(project(file('chapters/第1234章-x.txt'))))).toBe(4)
  })

  it('标题留空 / 清理后为空：以「未命名」生成规范文件名', () => {
    expect(buildChapterFileName(3, null)).toBe('第003章-未命名.txt')
    expect(buildChapterFileName(3, '  ')).toBe('第003章-未命名.txt')
    expect(buildChapterFileName(3, '???')).toBe('第003章-未命名.txt')
  })

  it('标题清理非法字符并压缩空白，超过 4 位编号自然变宽', () => {
    expect(buildChapterFileName(12, '夜 行/风雨')).toBe('第012章-夜_行风雨.txt')
    expect(buildChapterFileName(1234, '终章')).toBe('第1234章-终章.txt')
    expect(buildChapterFileName(5, '终章', 4)).toBe('第0005章-终章.txt')
  })

  it('落点目录：跟随最新章所在卷；无章节落根；最新重号取路径排序第一个', () => {
    expect(resolveCreateTargetDirectory(buildChapterCatalog(project(
      dir('第一卷', [file('chapters/第一卷/第003章-风雨.txt')]),
      file('chapters/第010章-启程.txt'),
    )))).toBe('')

    expect(resolveCreateTargetDirectory(buildChapterCatalog(project(
      dir('第一卷', [file('chapters/第一卷/第012章-夜行.txt')]),
      file('chapters/第010章-启程.txt'),
    )))).toBe('第一卷')

    expect(resolveCreateTargetDirectory(buildChapterCatalog([]))).toBe('')

    expect(resolveCreateTargetDirectory(buildChapterCatalog(project(
      dir('乙卷', [file('chapters/乙卷/第009章-a.txt')]),
      dir('甲卷', [file('chapters/甲卷/第009章-b.txt')]),
    )))).toBe('乙卷')
  })
})
