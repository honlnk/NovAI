import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * LoadElements 工具：mock project-fs（内存文件映射，模式同 indexer.test.ts），
 * 覆盖计划 W3 的三条用例：单个/批量加载、未知名称容错、element_content 输出格式。
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

import { loadElementsTool, renderElementContent } from './load-elements'

import type { ProjectSnapshot } from '../../types/project'

function makeProject(): ProjectSnapshot {
  return {
    id: 'proj-load-elements',
    handle: {} as ProjectSnapshot['handle'],
    tree: [
      {
        kind: 'directory',
        name: 'elements',
        path: 'elements',
        children: [
          {
            kind: 'directory',
            name: 'characters',
            path: 'elements/characters',
            children: [
              { kind: 'file', name: '林晚.md', path: 'elements/characters/林晚.md' },
              { kind: 'file', name: '陈默.md', path: 'elements/characters/陈默.md' },
            ],
          },
          {
            kind: 'directory',
            name: 'locations',
            path: 'elements/locations',
            children: [
              { kind: 'file', name: '临江医院.md', path: 'elements/locations/临江医院.md' },
            ],
          },
          {
            kind: 'directory',
            name: 'plots',
            path: 'elements/plots',
            children: [
              { kind: 'file', name: '初遇事件.md', path: 'elements/plots/初遇事件.md' },
            ],
          },
        ],
      },
    ],
  } as ProjectSnapshot
}

function elementMd(fields: Record<string, string>, body: string): string {
  const frontmatter = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')
  return `---\n${frontmatter}\n---\n\n${body}\n`
}

function seed() {
  files.set('elements/characters/林晚.md', elementMd(
    { name: '林晚', type: 'character', summary: '冷静克制的外科医生' },
    '## 人物卡\n林晚，外科医生，前特工。',
  ))
  files.set('elements/characters/陈默.md', elementMd(
    { name: '陈默', type: 'character', summary: '刑警队长' },
    '## 人物卡\n陈默，刑警队长。',
  ))
  files.set('elements/locations/临江医院.md', elementMd(
    { name: '临江医院', type: 'location', summary: '故事主舞台' },
    '## 地点\n临江医院，地下三层有秘密实验室。',
  ))
  files.set('elements/plots/初遇事件.md', elementMd(
    { name: '初遇事件', type: 'plot', summary: '两人初遇' },
    '初遇剧情。',
  ))
}

const runtime = { project: makeProject() } as Parameters<typeof loadElementsTool.run>[1]

describe('loadElementsTool', () => {
  beforeEach(() => {
    files.clear()
    seed()
  })

  it('单个加载：按 name 定位并返回完整文件内容', async () => {
    const output = await loadElementsTool.run({ names: ['林晚'] }, runtime)

    expect(output.elements).toHaveLength(1)
    const element = output.elements[0]!
    expect(element.name).toBe('林晚')
    expect(element.type).toBe('character')
    expect(element.sourcePath).toBe('elements/characters/林晚.md')
    expect(element.content).toContain('冷静克制的外科医生')
    expect(element.content).toContain('林晚，外科医生，前特工')
  })

  it('批量加载：一次取齐多个要素，保持请求顺序', async () => {
    const output = await loadElementsTool.run({ names: ['临江医院', '林晚', '陈默'] }, runtime)

    expect(output.elements.map((element) => element.name)).toEqual(['临江医院', '林晚', '陈默'])
    expect(output.elements.every((element) => !element.notFound)).toBe(true)
  })

  it('未知名称：返回 notFound 标记，不抛错，其余照常加载', async () => {
    const output = await loadElementsTool.run({ names: ['林晚', '不存在的角色'] }, runtime)

    expect(output.elements).toHaveLength(2)
    expect(output.elements[0]!.notFound).toBeUndefined()
    expect(output.elements[1]).toEqual({ name: '不存在的角色', notFound: true })
    expect(loadElementsTool.summarizeOutput(output)).toBe('已加载 1 个要素定义，1 个未找到')
  })

  it('name 匹配的是 frontmatter 的 name 字段而非文件名', async () => {
    // frontmatter name 是「林晚」；用文件名之外的名字（如标题别名）查不到
    const output = await loadElementsTool.run({ names: ['林晚医生'] }, runtime)
    expect(output.elements[0]!.notFound).toBe(true)
  })

  it('plots/timeline 不在加载范围（只服务四类稳定要素）', async () => {
    const output = await loadElementsTool.run({ names: ['初遇事件'] }, runtime)
    expect(output.elements[0]!.notFound).toBe(true)
  })

  it('validateInput：names 必须是非空字符串数组', () => {
    expect(() => loadElementsTool.validateInput({})).toThrow()
    expect(() => loadElementsTool.validateInput({ names: [] })).toThrow()
    expect(() => loadElementsTool.validateInput({ names: ['林晚', ''] })).toThrow()
    expect(() => loadElementsTool.validateInput({ names: '林晚' })).toThrow()
    expect(loadElementsTool.validateInput({ names: [' 林晚 '] })).toEqual({ names: ['林晚'] })
  })
})

describe('renderElementContent', () => {
  beforeEach(() => {
    files.clear()
    seed()
  })

  it('输出符合 <element_content> 规范：name/type 属性 + 完整正文', async () => {
    const output = await loadElementsTool.run({ names: ['林晚'] }, runtime)
    const rendered = renderElementContent(output)

    expect(rendered).toContain('<element_content name="林晚" type="character" path="elements/characters/林晚.md">')
    expect(rendered).toContain('</element_content>')
    expect(rendered).toContain('林晚，外科医生，前特工')
  })

  it('未找到的要素渲染 notFound 标记与提示，不渲染空帧', async () => {
    const output = await loadElementsTool.run({ names: ['不存在'] }, runtime)
    const rendered = renderElementContent(output)

    expect(rendered).toContain('<element_content name="不存在" notFound="true"/>')
    expect(rendered).toContain('未找到名为「不存在」的要素')
  })
})
