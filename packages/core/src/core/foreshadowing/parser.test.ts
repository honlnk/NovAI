import { describe, expect, it } from 'vitest'

import {
  buildForeshadowingBody,
  parseForeshadowingFile,
  replaceForeshadowingBodySections,
  serializeForeshadowingCard,
  splitForeshadowingBody,
  toForeshadowingCardView,
} from './parser'
import type { ForeshadowingCard } from '../../types/foreshadowing'

function baseCard(overrides: Partial<Omit<ForeshadowingCard, 'sourcePath'>> = {}): Omit<ForeshadowingCard, 'sourcePath'> {
  return {
    id: 'F-001',
    name: '旧照片之谜',
    status: 'developed',
    order: 100,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    plantedAt: '第一卷/第012章',
    payoffWindow: ['第二卷/第080章', '第二卷/第090章'],
    payoffStart: null,
    payoffEnd: null,
    relatedCharacters: ['主角', '研究员K', '母亲'],
    relatedEntities: ['旧照片'],
    relatedChapters: ['第一卷/第028章', '第一卷/第051章'],
    isRedHerring: false,
    resolvedAt: null,
    abandonedReason: null,
    body: buildForeshadowingBody(
      '主角在旧书店发现一张褪色的照片。',
      '主角是研究员的复制体。',
    ),
    ...overrides,
  }
}

describe('parseForeshadowingFile', () => {
  it('解析标准伏笔文件（含列表字段与两节正文）', () => {
    const content = serializeForeshadowingCard(baseCard())
    const parsed = parseForeshadowingFile('foreshadowing/F-001-旧照片之谜.md', content)

    expect(parsed.card).toEqual(baseCard())
    expect(parsed.contentHash).toBeTruthy()
    expect(parsed.readerBody).toContain('旧书店')
    expect(parsed.readerBody).not.toContain('复制体')
    expect(parsed.truthBody).toContain('复制体')
  })

  it('缺失/非法元数据回退默认值，不丢正文', () => {
    const content = [
      '---',
      'id: F-002',
      'status: 不存在的状态',
      '---',
      '',
      '## 读者视角（当时可见事实）',
      '',
      '正文内容',
    ].join('\n')

    const parsed = parseForeshadowingFile('foreshadowing/x.md', content)

    expect(parsed.card.status).toBe('planted')
    expect(parsed.card.order).toBe(0)
    expect(parsed.card.plantedAt).toBe('')
    expect(parsed.card.payoffWindow).toBeNull()
    expect(parsed.readerBody).toBe('## 读者视角（当时可见事实）\n\n正文内容')
  })

  it('frontmatter 注释行不影响解析', () => {
    const content = [
      '---',
      '# 分组注释',
      'id: F-003',
      'related_characters: [主角, 师妹]',
      '---',
      '',
      '正文',
    ].join('\n')

    const parsed = parseForeshadowingFile('foreshadowing/x.md', content)
    expect(parsed.card.id).toBe('F-003')
    expect(parsed.card.relatedCharacters).toEqual(['主角', '师妹'])
  })
})

describe('splitForeshadowingBody', () => {
  it('无作者真相节时全文都是读者视角', () => {
    const body = '## 读者视角（当时可见事实）\n\n只有读者内容'
    const result = splitForeshadowingBody(body)
    expect(result.readerBody).toBe(body)
    expect(result.truthBody).toBe('')
  })

  it('真相节后还有其他节时，其他节归读者侧', () => {
    const body = [
      '## 读者视角（当时可见事实）',
      '',
      '读者内容',
      '',
      '## 作者真相',
      '',
      '真相内容',
      '',
      '## 作者备注',
      '',
      '备注内容',
    ].join('\n')

    const result = splitForeshadowingBody(body)

    expect(result.truthBody).toBe('真相内容')
    expect(result.readerBody).toContain('读者内容')
    expect(result.readerBody).toContain('## 作者备注')
    expect(result.readerBody).not.toContain('真相内容')
    expect(result.readerBody).not.toContain('## 作者真相')
  })

  it('节前导语归读者侧', () => {
    const body = '随手记一句\n\n## 作者真相\n\n真相'
    const result = splitForeshadowingBody(body)
    expect(result.readerBody).toBe('随手记一句')
    expect(result.truthBody).toBe('真相')
  })
})

describe('serialize/parse 往返', () => {
  it('空窗口与空列表序列化为 null/[]，往返字段无损', () => {
    const card = baseCard({
      payoffWindow: null,
      relatedCharacters: [],
      relatedEntities: [],
      relatedChapters: [],
      isRedHerring: true,
      resolvedAt: '第二卷/第085章',
      abandonedReason: null,
    })

    const serialized = serializeForeshadowingCard(card)
    const parsed = parseForeshadowingFile('foreshadowing/F-001-x.md', serialized)

    expect(parsed.card).toEqual(card)
  })
})

describe('replaceForeshadowingBodySections', () => {
  it('只替换读者视角，真相保持原样', () => {
    const body = buildForeshadowingBody('旧读者', '旧真相')
    const next = replaceForeshadowingBodySections(body, { readerView: '新读者' })

    const parsed = splitForeshadowingBody(next)
    expect(parsed.readerBody).toContain('新读者')
    expect(parsed.truthBody).toBe('旧真相')
  })

  it('只替换作者真相（含清除）', () => {
    const body = buildForeshadowingBody('旧读者', '旧真相')

    const replaced = replaceForeshadowingBodySections(body, { authorTruth: '新真相' })
    expect(splitForeshadowingBody(replaced).truthBody).toBe('新真相')

    const cleared = replaceForeshadowingBodySections(body, { authorTruth: '' })
    expect(splitForeshadowingBody(cleared).truthBody).toBe('')
  })
})

describe('toForeshadowingCardView', () => {
  it('summary 取读者视角首个非空行，readerBody 不含真相', () => {
    const card = { ...baseCard(), sourcePath: 'foreshadowing/F-001-x.md' } as ForeshadowingCard
    const view = toForeshadowingCardView(card)

    expect(view.summary).toBe('主角在旧书店发现一张褪色的照片。')
    expect(view.readerBody).not.toContain('复制体')
  })
})
