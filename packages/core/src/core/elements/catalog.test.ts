import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * catalog.ts 的扫描逻辑依赖项目文件系统（project-fs），这里 mock 成内存映射
 * （模式同 indexer.test.ts），覆盖计划 W1 的三条用例：四类扫描跳过 plots/timeline、
 * summary 缺失兜底、digest 敏感面。
 */

const files = new Map<string, string>()

vi.mock('../fs/project-fs', () => ({
  async readProjectFile(_project: unknown, path: string) {
    const content = files.get(path)
    if (content === undefined) {
      throw new Error(`测试未提供文件: ${path}`)
    }
    return { content, updatedAt: '2026-01-01T00:00:00.000Z' }
  },
}))

import { digestElementCatalog, scanElementCatalog } from './catalog'

import type { ProjectSnapshot } from '../../types/project'
import type { ElementCatalogEntry } from '../../types/elements'

function makeProject(tree: ProjectSnapshot['tree']): ProjectSnapshot {
  return {
    id: 'proj-catalog',
    handle: {} as ProjectSnapshot['handle'],
    tree,
  } as ProjectSnapshot
}

function dir(path: string, children: ProjectSnapshot['tree']): ProjectSnapshot['tree'][number] {
  return { kind: 'directory', name: path.split('/').pop()!, path, children }
}

function fileNode(path: string): ProjectSnapshot['tree'][number] {
  return { kind: 'file', name: path.split('/').pop()!, path }
}

function elementMd(fields: Record<string, string>, body = '正文内容'): string {
  const frontmatter = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')
  return `---\n${frontmatter}\n---\n\n${body}\n`
}

/** 林晚/临江医院/密信/灵脉 四类各一条 + plots/timeline 各一条的完整树。 */
function fullTree(): ProjectSnapshot['tree'] {
  return [
    dir('elements', [
      dir('elements/characters', [fileNode('elements/characters/林晚.md')]),
      dir('elements/locations', [fileNode('elements/locations/临江医院.md')]),
      dir('elements/entities', [fileNode('elements/entities/密信.md')]),
      dir('elements/worldbuilding', [fileNode('elements/worldbuilding/灵脉体系.md')]),
      dir('elements/plots', [fileNode('elements/plots/初遇事件.md')]),
      dir('elements/timeline', [fileNode('elements/timeline/第一卷.md')]),
    ]),
    dir('chapters', [fileNode('chapters/第001章-试炼.txt')]),
    dir('prompts', [fileNode('prompts/system.md')]),
  ]
}

function seedFullProject() {
  files.set('elements/characters/林晚.md', elementMd({ name: '林晚', type: character(), summary: '冷静克制的外科医生' }))
  files.set('elements/locations/临江医院.md', elementMd({ name: '临江医院', type: 'location', summary: '故事主舞台' }))
  files.set('elements/entities/密信.md', elementMd({ name: '密信', type: 'entity', summary: '推动剧情的关键信物' }))
  files.set('elements/worldbuilding/灵脉体系.md', elementMd({ name: '灵脉体系', type: 'worldbuilding', summary: '大地灵气流动的规则体系' }))
  files.set('elements/plots/初遇事件.md', elementMd({ name: '初遇事件', type: 'plot', summary: '两人初次相遇' }))
  files.set('elements/timeline/第一卷.md', elementMd({ name: '第一卷', type: 'timeline', summary: '故事开端' }))
}

function character(): string {
  return 'character'
}

describe('scanElementCatalog', () => {
  beforeEach(() => {
    files.clear()
  })

  it('扫描四类目录产出条目，跳过 plots/timeline 及其他目录', async () => {
    seedFullProject()

    const entries = await scanElementCatalog(makeProject(fullTree()))

    expect(entries.map((entry) => entry.name)).toEqual(['林晚', '临江医院', '密信', '灵脉体系'])
    expect(entries.every((entry) => !entry.sourcePath.startsWith('elements/plots/'))).toBe(true)
    expect(entries.every((entry) => !entry.sourcePath.startsWith('elements/timeline/'))).toBe(true)
  })

  it('条目按类型分组序 + name 序稳定排列（与枚举顺序无关）', async () => {
    seedFullProject()

    const tree = fullTree()
    const elementsDir = tree[0]!.children!
    elementsDir.reverse()

    const entries = await scanElementCatalog(makeProject(tree))

    expect(entries.map((entry) => entry.type)).toEqual(['character', 'location', 'entity', 'worldbuilding'])
  })

  it('summary 缺失时用 name 兜底，name 缺失时用文件名兜底', async () => {
    files.set('elements/characters/林晚.md', elementMd({ name: '林晚', type: character() }))
    files.set('elements/locations/临江医院.md', elementMd({ type: 'location', summary: '故事主舞台' }))

    const entries = await scanElementCatalog(makeProject([
      dir('elements', [
        dir('elements/characters', [fileNode('elements/characters/林晚.md')]),
        dir('elements/locations', [fileNode('elements/locations/临江医院.md')]),
      ]),
    ]))

    expect(entries).toEqual([
      { type: 'character', name: '林晚', summary: '林晚', sourcePath: 'elements/characters/林晚.md' },
      { type: 'location', name: '临江医院', summary: '故事主舞台', sourcePath: 'elements/locations/临江医院.md' },
    ])
  })

  it('单个文件读取失败时跳过该条，不阻塞其余条目', async () => {
    files.set('elements/characters/林晚.md', elementMd({ name: '林晚', type: character(), summary: '医生' }))
    // 临江医院.md 不注入 files → readProjectFile 抛错

    const entries = await scanElementCatalog(makeProject([
      dir('elements', [
        dir('elements/characters', [fileNode('elements/characters/林晚.md')]),
        dir('elements/locations', [fileNode('elements/locations/临江医院.md')]),
      ]),
    ]))

    expect(entries.map((entry) => entry.name)).toEqual(['林晚'])
  })

  it('四类目录均无文件时返回空数组（不注入目录 reminder 的判定基础）', async () => {
    const entries = await scanElementCatalog(makeProject([
      dir('elements', [dir('elements/plots', [fileNode('elements/plots/初遇事件.md')])]),
    ]))

    expect(entries).toEqual([])
  })
})

describe('digestElementCatalog', () => {
  const baseEntries: ElementCatalogEntry[] = [
    { type: 'character', name: '林晚', summary: '冷静克制的外科医生', sourcePath: 'elements/characters/林晚.md' },
    { type: 'location', name: '临江医院', summary: '故事主舞台', sourcePath: 'elements/locations/临江医院.md' },
  ]

  it('对条目数量、name、summary 敏感', () => {
    const base = digestElementCatalog(baseEntries)

    expect(digestElementCatalog([baseEntries[0]!])).not.toBe(base)
    expect(digestElementCatalog([
      { ...baseEntries[0]!, name: '陈默' },
      baseEntries[1]!,
    ])).not.toBe(base)
    expect(digestElementCatalog([
      { ...baseEntries[0]!, summary: '前特工' },
      baseEntries[1]!,
    ])).not.toBe(base)
  })

  it('对文件正文、sourcePath、mtime 类版本信息不敏感', () => {
    const base = digestElementCatalog(baseEntries)

    // sourcePath 变化（文件挪了子目录）：name/summary 不变 → digest 不变
    expect(digestElementCatalog([
      { ...baseEntries[0]!, sourcePath: 'elements/characters/归档/林晚.md' },
      baseEntries[1]!,
    ])).toBe(base)
  })

  it('同一批条目重排后 digest 不变（排序归一）', () => {
    const base = digestElementCatalog(baseEntries)
    expect(digestElementCatalog([baseEntries[1]!, baseEntries[0]!])).toBe(base)
  })
})
