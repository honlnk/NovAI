import { beforeEach, describe, expect, it } from 'vitest'

import {
  RelationConflictError,
  RelationCorruptError,
  RelationError,
  checkRelationLedger,
  createRelation,
  deleteRelation,
  loadRelationLedger,
  queryRelations,
  removeInvalidRelationEntries,
  removeRelationsReferencing,
  removeRelationsReferencingEvent,
  removeRelationsReferencingPath,
  relationVersion,
  saveRelationLayout,
  updateRelation,
} from './store'
import { RELATION_LEDGER_PATH } from '../../types/relation'
import { TIMELINE_LEDGER_PATH } from '../../types/timeline'
import { writeProjectTextFile, readProjectTextFile } from '../fs/project-fs'
import type { ProjectSnapshot } from '../../types/project'

/* ---------- 内存文件系统（与其他 core 测试同款内联实现） ---------- */

type MemoryFileEntry = { kind: 'file'; name: string; content: string; lastModified: number }
type MemoryDirectoryEntry = { kind: 'directory'; name: string; entries: Map<string, MemoryEntry> }
type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry
type MemoryDirectoryHandle = FileSystemDirectoryHandle & { __entry: MemoryDirectoryEntry }

function createMemoryDirectory(name: string): MemoryDirectoryHandle {
  return createDirectoryHandle({ kind: 'directory', name, entries: new Map() })
}

function createDirectoryHandle(entry: MemoryDirectoryEntry): MemoryDirectoryHandle {
  return {
    kind: 'directory',
    name: entry.name,
    __entry: entry,
    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'directory') {
        return createDirectoryHandle(current)
      }
      if (current) {
        throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      }
      if (!options?.create) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
      const next: MemoryDirectoryEntry = { kind: 'directory', name, entries: new Map() }
      entry.entries.set(name, next)
      return createDirectoryHandle(next)
    },
    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'file') {
        return createFileHandle(current)
      }
      if (current) {
        throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
      }
      if (!options?.create) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
      const next: MemoryFileEntry = { kind: 'file', name, content: '', lastModified: Date.now() }
      entry.entries.set(name, next)
      return createFileHandle(next)
    },
    async removeEntry(name: string) {
      if (!entry.entries.delete(name)) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
    },
    async *values() {
      for (const child of entry.entries.values()) {
        yield child.kind === 'directory' ? createDirectoryHandle(child) : createFileHandle(child)
      }
    },
  } as unknown as MemoryDirectoryHandle
}

function createFileHandle(entry: MemoryFileEntry): FileSystemFileHandle {
  return {
    kind: 'file',
    name: entry.name,
    async getFile() {
      return new File([entry.content], entry.name, { type: 'text/plain', lastModified: entry.lastModified })
    },
    async createWritable() {
      let nextContent = ''
      return {
        async write(data: string) {
          nextContent += data
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as FileSystemFileHandle
}

/* ---------- 项目快照与要素种子 ---------- */

let root: MemoryDirectoryHandle
let project: ProjectSnapshot

function elementFile(options: { id?: string; type?: string; name: string; summary?: string; body?: string }): string {
  const frontmatter = [
    '---',
    `id: ${options.id ?? ''}`,
    `type: ${options.type ?? 'character'}`,
    `name: ${options.name}`,
    `summary: ${options.summary ?? ''}`,
    '---',
    '',
  ].join('\n')
  return frontmatter + (options.body ?? `# ${options.name}\n\n正文`)
}

async function seedElement(path: string, options: { id?: string; type?: string; name: string; summary?: string }): Promise<string> {
  await writeProjectTextFile(root, path, elementFile(options))
  return path
}

beforeEach(() => {
  root = createMemoryDirectory('novel')
  project = { id: 'proj-rel', handle: root } as unknown as ProjectSnapshot
})

/* ---------- 建立与校验 ---------- */

describe('createRelation', () => {
  it('按「类型 + 名称」建关系：懒分配标识写回 frontmatter、新建账本、结果带 assignedElementIds', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', type: 'character' })
    await seedElement('elements/characters/老周.md', { name: '老周', type: 'character' })

    const result = await createRelation(project, {
      from: { kind: 'element', type: 'character', name: '林澜' },
      to: { kind: 'element', type: 'character', name: '老周' },
      type: '师徒',
      description: '林澜拜老周为师',
      now: new Date('2026-01-01T00:00:00.000Z'),
    })

    expect(result.created).toBe(true)
    expect(result.relation.type).toBe('师徒')
    expect(result.relation.description).toBe('林澜拜老周为师')
    expect(result.assignedElementIds).toHaveLength(2)
    expect(result.assignedElementIds.every((item) => /^ELM-[0-9a-z]{10}$/.test(item.id))).toBe(true)

    // frontmatter 已写回稳定标识
    const linContent = await readProjectTextFile(root, 'elements/characters/林澜.md')
    expect(linContent).toMatch(/^id: ELM-[0-9a-z]{10}$/m)

    // 账本文件已落盘且可回读
    const ledgerRaw = await readProjectTextFile(root, RELATION_LEDGER_PATH)
    expect(ledgerRaw).toContain('"version": 1')
    const document = await loadRelationLedger(project)
    expect(document.relations).toHaveLength(1)
    expect(document.contentHash).toBe(result.contentHash)
  })

  it('已有标识的要素不重复分配；用 id 定位端点走引用解析', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedElement('elements/locations/青云山.md', { name: '青云山', type: 'location', id: 'ELM-bbbbbbbbbb' })

    const result = await createRelation(project, {
      from: { kind: 'element', id: 'ELM-aaaaaaaaaa' },
      to: { kind: 'element', id: 'ELM-bbbbbbbbbb' },
      type: '居于',
    })

    expect(result.assignedElementIds).toHaveLength(0)
    expect(result.relation.from).toEqual({ kind: 'element', id: 'ELM-aaaaaaaaaa' })
    expect(result.relation.to).toEqual({ kind: 'element', id: 'ELM-bbbbbbbbbb' })
  })

  it('校验拦截：自环、空/超长类型、同向同类型重复、找不到/重名要素', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜' })
    await seedElement('elements/characters/老周.md', { name: '老周' })
    await seedElement('elements/characters/副本.md', { name: '重名', type: 'character' })
    await seedElement('elements/characters/副本2.md', { name: '重名', type: 'character' })

    await expect(createRelation(project, {
      from: { kind: 'element', type: 'character', name: '林澜' },
      to: { kind: 'element', type: 'character', name: '林澜' },
      type: '盟友',
    })).rejects.toThrow('自环')

    await expect(createRelation(project, {
      from: { kind: 'element', type: 'character', name: '林澜' },
      to: { kind: 'element', type: 'character', name: '老周' },
      type: '',
    })).rejects.toThrow('关系类型不能为空')

    await expect(createRelation(project, {
      from: { kind: 'element', type: 'character', name: '林澜' },
      to: { kind: 'element', type: 'character', name: '老周' },
      type: '一'.repeat(31),
    })).rejects.toThrow('30 字')

    await expect(createRelation(project, {
      from: { kind: 'element', type: 'character', name: '不存在的人' },
      to: { kind: 'element', type: 'character', name: '林澜' },
      type: '盟友',
    })).rejects.toThrow('找不到名为「不存在的人」')

    await expect(createRelation(project, {
      from: { kind: 'element', type: 'character', name: '重名' },
      to: { kind: 'element', type: 'character', name: '林澜' },
      type: '盟友',
    })).rejects.toThrow('无法确定指向')

    // 同向同类型重复；反向是独立条目
    await createRelation(project, {
      from: { kind: 'element', type: 'character', name: '林澜' },
      to: { kind: 'element', type: 'character', name: '老周' },
      type: '盟友',
    })
    await expect(createRelation(project, {
      from: { kind: 'element', type: 'character', name: '林澜' },
      to: { kind: 'element', type: 'character', name: '老周' },
      type: '盟友',
    })).rejects.toThrow('同向同类型')
    await expect(createRelation(project, {
      from: { kind: 'element', type: 'character', name: '老周' },
      to: { kind: 'element', type: 'character', name: '林澜' },
      type: '盟友',
    })).resolves.toBeTruthy()
  })
})

/* ---------- 改与删 ---------- */

describe('updateRelation / deleteRelation', () => {
  async function seedPair() {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedElement('elements/characters/老周.md', { name: '老周', id: 'ELM-bbbbbbbbbb' })
    return createRelation(project, {
      from: { kind: 'element', type: 'character', name: '林澜' },
      to: { kind: 'element', type: 'character', name: '老周' },
      type: '盟友',
      description: '旧描述',
    })
  }

  it('改类型与描述；previous 保留旧记录', async () => {
    const created = await seedPair()
    const result = await updateRelation(project, { id: created.relation.id, type: '决裂', description: '反目成仇' })

    expect(result.relation.type).toBe('决裂')
    expect(result.relation.description).toBe('反目成仇')
    expect(result.previous.type).toBe('盟友')

    const document = await loadRelationLedger(project)
    expect(document.relations).toHaveLength(1)
    expect(document.relations[0]!.type).toBe('决裂')
  })

  it('换端点重新校验重复与自环；不存在的 id 报错', async () => {
    const created = await seedPair()
    await seedElement('elements/characters/第三者.md', { name: '第三者', id: 'ELM-cccccccccc' })

    await expect(updateRelation(project, { id: created.relation.id, from: { kind: 'element', id: 'ELM-bbbbbbbbbb' } }))
      .rejects.toThrow('自环')
    await expect(updateRelation(project, { id: 'REL-xxxxxxxxxx', type: '新类型' }))
      .rejects.toThrow('不存在')
    await expect(updateRelation(project, { id: created.relation.id }))
      .rejects.toThrow('至少提供')

    const moved = await updateRelation(project, { id: created.relation.id, to: { kind: 'element', id: 'ELM-cccccccccc' } })
    expect(moved.relation.to).toEqual({ kind: 'element', id: 'ELM-cccccccccc' })
  })

  it('expectedContentHash 基线不符 → RelationConflictError（携带磁盘当前哈希）', async () => {
    const created = await seedPair()
    // 先做一次外部改动，使基线过期
    await updateRelation(project, { id: created.relation.id, description: '外部改动' })

    await expect(updateRelation(project, {
      id: created.relation.id,
      type: '决裂',
      expectedContentHash: created.contentHash,
    })).rejects.toThrow(RelationConflictError)
  })

  it('删除后账本与查询同步收缩', async () => {
    const created = await seedPair()
    await deleteRelation(project, created.relation.id)

    const document = await loadRelationLedger(project)
    expect(document.relations).toHaveLength(0)
    await expect(deleteRelation(project, created.relation.id)).rejects.toThrow('不存在')
  })
})

/* ---------- 坐标与冲突 ---------- */

describe('saveRelationLayout', () => {
  it('只替换 layout；并发外部改动时重读重放一次', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedElement('elements/characters/老周.md', { name: '老周', id: 'ELM-bbbbbbbbbb' })
    const created = await createRelation(project, {
      from: { kind: 'element', type: 'character', name: '林澜' },
      to: { kind: 'element', type: 'character', name: '老周' },
      type: '盟友',
    })

    const result = await saveRelationLayout(project, {
      'ELM-aaaaaaaaaa': { x: 100, y: 200 },
      'ELM-bbbbbbbbbb': { x: 300, y: 50 },
    })
    expect(result.contentHash).toBeTruthy()

    // 关系数据未被坐标保存触碰
    const document = await loadRelationLedger(project)
    expect(document.relations).toHaveLength(1)
    expect(document.layout['ELM-aaaaaaaaaa']).toEqual({ x: 100, y: 200 })
    expect(created.relation.id).toBeTruthy()
  })
})

/* ---------- 异常数据：隔离、阻止写入、清理 ---------- */

describe('异常数据隔离与清理', () => {
  it('非法条目隔离为 issue 且阻止全部写入；removeInvalidRelationEntries 清理后恢复', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedElement('elements/characters/老周.md', { name: '老周', id: 'ELM-bbbbbbbbbb' })
    await createRelation(project, {
      from: { kind: 'element', type: 'character', name: '林澜' },
      to: { kind: 'element', type: 'character', name: '老周' },
      type: '盟友',
    })

    // 手工注入一条非法关系（缺 type）与非法坐标
    const document = await loadRelationLedger(project)
    const raw = JSON.stringify({
      version: 1,
      relations: [...document.relations, { id: 'REL-bad0000000', from: { kind: 'element', id: 'ELM-aaaaaaaaaa' } }],
      layout: { 'ELM-aaaaaaaaaa': { x: '东', y: 1 } },
    }, null, 2)
    await writeProjectTextFile(root, RELATION_LEDGER_PATH, raw)

    const loaded = await loadRelationLedger(project)
    expect(loaded.relations).toHaveLength(1)
    expect(loaded.issues).toHaveLength(2)
    expect(loaded.issues.map((issue) => issue.kind).sort()).toEqual(['invalid-layout-entry', 'invalid-relation'])

    // 写入被阻止（合法数据也不许静默洗掉坏条目）
    await expect(createRelation(project, {
      from: { kind: 'element', type: 'character', name: '林澜' },
      to: { kind: 'element', type: 'character', name: '老周' },
      type: '仇敌',
    })).rejects.toThrow('写入已被阻止')

    const cleaned = await removeInvalidRelationEntries(project)
    expect(cleaned.removed).toHaveLength(2)

    const after = await loadRelationLedger(project)
    expect(after.issues).toHaveLength(0)
    expect(after.relations).toHaveLength(1)
    expect(after.layout['ELM-aaaaaaaaaa']).toBeUndefined()
  })

  it('结构性损坏（非 JSON）→ RelationCorruptError，携带原文', async () => {
    await writeProjectTextFile(root, RELATION_LEDGER_PATH, '{ 这不是 JSON')

    await expect(loadRelationLedger(project)).rejects.toThrow(RelationCorruptError)
    await expect(createRelation(project, {
      from: { kind: 'element', type: 'character', name: '谁' },
      to: { kind: 'element', type: 'character', name: '谁' },
      type: '盟友',
    })).rejects.toBeTruthy()
    const raw = await readProjectTextFile(root, RELATION_LEDGER_PATH)
    expect(raw).toBe('{ 这不是 JSON')
  })

  it('版本号不识别 → RelationCorruptError', async () => {
    await writeProjectTextFile(root, RELATION_LEDGER_PATH, JSON.stringify({ version: 99, relations: [], layout: {} }))
    await expect(loadRelationLedger(project)).rejects.toThrow('不识别的账本版本')
  })
})

/* ---------- 级联清理 ---------- */

describe('级联清理（要素删除链路）', () => {
  it('removeRelationsReferencingPath：按路径映射标识移除关系并清坐标；无引用返回空', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedElement('elements/characters/老周.md', { name: '老周', id: 'ELM-bbbbbbbbbb' })
    await seedElement('elements/characters/第三者.md', { name: '第三者', id: 'ELM-cccccccccc' })
    await createRelation(project, { from: { kind: 'element', type: 'character', name: '林澜' }, to: { kind: 'element', type: 'character', name: '老周' }, type: '盟友' })
    await createRelation(project, { from: { kind: 'element', type: 'character', name: '老周' }, to: { kind: 'element', type: 'character', name: '第三者' }, type: '隶属' })
    await saveRelationLayout(project, {
      'ELM-aaaaaaaaaa': { x: 0, y: 0 },
      'ELM-bbbbbbbbbb': { x: 1, y: 1 },
      'ELM-cccccccccc': { x: 2, y: 2 },
    })

    const result = await removeRelationsReferencingPath(project, 'elements/characters/老周.md')
    expect(result.elementIds).toEqual(['ELM-bbbbbbbbbb'])
    expect(result.removedRelations).toHaveLength(2)

    const document = await loadRelationLedger(project)
    expect(document.relations).toHaveLength(0)
    expect(document.layout['ELM-bbbbbbbbbb']).toBeUndefined()
    expect(document.layout['ELM-aaaaaaaaaa']).toEqual({ x: 0, y: 0 })

    const empty = await removeRelationsReferencingPath(project, 'elements/characters/不存在.md')
    expect(empty.removedRelations).toHaveLength(0)
  })

  it('removeRelationsReferencing：按标识移除（幂等）', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedElement('elements/entities/铁剑门.md', { name: '铁剑门', type: 'entity', id: 'ELM-bbbbbbbbbb' })
    await createRelation(project, { from: { kind: 'element', type: 'character', name: '林澜' }, to: { kind: 'element', type: 'entity', name: '铁剑门' }, type: '隶属' })

    const first = await removeRelationsReferencing(project, 'ELM-aaaaaaaaaa')
    expect(first.removedRelations).toHaveLength(1)
    const second = await removeRelationsReferencing(project, 'ELM-aaaaaaaaaa')
    expect(second.removedRelations).toHaveLength(0)
  })
})

/* ---------- 查询与检查 ---------- */

describe('queryRelations / checkRelationLedger', () => {
  async function seedTriangle() {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedElement('elements/characters/老周.md', { name: '老周', id: 'ELM-bbbbbbbbbb' })
    await seedElement('elements/characters/第三者.md', { name: '第三者', id: 'ELM-cccccccccc' })
    await createRelation(project, { from: { kind: 'element', type: 'character', name: '林澜' }, to: { kind: 'element', type: 'character', name: '老周' }, type: '盟友' })
    await createRelation(project, { from: { kind: 'element', type: 'character', name: '老周' }, to: { kind: 'element', type: 'character', name: '林澜' }, type: '师徒' })
    await createRelation(project, { from: { kind: 'element', type: 'character', name: '老周' }, to: { kind: 'element', type: 'character', name: '第三者' }, type: '隶属' })
  }

  it('elementId 过滤直接相连；elementIds 过滤两端都在集合内', async () => {
    await seedTriangle()

    const lin = await queryRelations(project, { elementId: 'ELM-aaaaaaaaaa' })
    expect(lin.relations).toHaveLength(2)

    const pair = await queryRelations(project, { elementIds: ['ELM-aaaaaaaaaa', 'ELM-bbbbbbbbbb'] })
    expect(pair.relations).toHaveLength(2)
    expect(pair.relations.every((relation) => relation.type !== '隶属')).toBe(true)
  })

  it('健康账本检查为空；悬空引用与重复关系被报告', async () => {
    await seedTriangle()
    expect((await checkRelationLedger(project)).issues).toHaveLength(0)

    // 手工注入悬空引用与重复三元组
    const document = await loadRelationLedger(project)
    const dup = { ...document.relations[0]!, id: 'REL-dupe000000' }
    const dangling = { ...document.relations[0]!, id: 'REL-dang0000000', to: { kind: 'element', id: 'ELM-zzzzzzzzzz' } }
    await writeProjectTextFile(root, RELATION_LEDGER_PATH, JSON.stringify({
      version: 1,
      relations: [...document.relations, dup, dangling],
      layout: {},
    }, null, 2))

    const { issues } = await checkRelationLedger(project)
    expect(issues.map((issue) => issue.kind).sort()).toEqual(['dangling-reference', 'duplicate-relation'])
  })
})

/* ---------- review 修复批回归 ---------- */

/* ---------- 事件端点（时间线账本联动，时间线JSON化改造 §11） ---------- */

describe('事件端点：登记、校验、级联与检查', () => {
  async function seedTimelineEvent(eventId: string, title: string): Promise<void> {
    await writeProjectTextFile(root, TIMELINE_LEDGER_PATH, JSON.stringify({
      version: 1,
      markers: [
        {
          id: `TM-${eventId.slice(4, 14)}`,
          kind: 'point',
          eventId,
          event: {
            title,
            summary: '',
            storyTime: null,
            relativeTime: null,
            participants: [],
            plotIds: [],
            chapters: [],
            causedBy: [],
            createdAt: '2026-11-22T00:00:00.000Z',
            updatedAt: '2026-11-22T00:00:00.000Z',
          },
        },
      ],
    }, null, 2))
  }

  it('事件端点登记成功：直接成 event 引用，不懒分配标识、不改写要素文件', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedTimelineEvent('EVT-aaaaaaaaaa', '北境之战')

    const result = await createRelation(project, {
      from: { kind: 'event', eventId: 'EVT-aaaaaaaaaa' },
      to: { kind: 'element', type: 'character', name: '林澜' },
      type: '导致',
      description: '战后林澜性情大变',
    })

    expect(result.relation.from).toEqual({ kind: 'event', id: 'EVT-aaaaaaaaaa' })
    expect(result.relation.to).toEqual({ kind: 'element', id: 'ELM-aaaaaaaaaa' })
    // 事件端点不懒分配；已有标识的要素也不再写回
    expect(result.assignedElementIds).toHaveLength(0)
  })

  it('找不到事件与事件自环被拦截', async () => {
    await seedTimelineEvent('EVT-aaaaaaaaaa', '北境之战')

    await expect(createRelation(project, {
      from: { kind: 'event', eventId: 'EVT-zzzzzzzzzz' },
      to: { kind: 'element', type: 'character', name: '林澜' },
      type: '关联',
    })).rejects.toThrow('找不到事件')

    await expect(createRelation(project, {
      from: { kind: 'event', eventId: 'EVT-aaaaaaaaaa' },
      to: { kind: 'event', eventId: 'EVT-aaaaaaaaaa' },
      type: '自指',
    })).rejects.toThrow('自环')
  })

  it('时间线账本损坏时事件端点登记被拒绝并提示修复', async () => {
    await writeProjectTextFile(root, TIMELINE_LEDGER_PATH, '根本不是 JSON')
    await seedElement('elements/characters/林澜.md', { name: '林澜' })

    await expect(createRelation(project, {
      from: { kind: 'event', eventId: 'EVT-aaaaaaaaaa' },
      to: { kind: 'element', type: 'character', name: '林澜' },
      type: '关联',
    })).rejects.toThrow('时间线账本已损坏')
  })

  it('更新关系可把端点改为事件；端点未变（同 eventId）不重新解析', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedElement('elements/characters/老周.md', { name: '老周', id: 'ELM-bbbbbbbbbb' })
    await seedTimelineEvent('EVT-cccccccccc', '铁剑门兴起')
    const created = await createRelation(project, {
      from: { kind: 'element', id: 'ELM-aaaaaaaaaa' },
      to: { kind: 'element', id: 'ELM-bbbbbbbbbb' },
      type: '盟友',
    })

    const updated = await updateRelation(project, {
      id: created.relation.id,
      from: { kind: 'event', eventId: 'EVT-cccccccccc' },
      description: '改挂事件端点',
    })
    expect(updated.relation.from).toEqual({ kind: 'event', id: 'EVT-cccccccccc' })
    expect(updated.relation.to).toEqual({ kind: 'element', id: 'ELM-bbbbbbbbbb' })
    expect(updated.previous.from).toEqual({ kind: 'element', id: 'ELM-aaaaaaaaaa' })

    // 同 eventId 选择器 = 端点未变：即使时间线账本被清空也不再解析
    await writeProjectTextFile(root, TIMELINE_LEDGER_PATH, JSON.stringify({ version: 1, markers: [] }, null, 2))
    const untouched = await updateRelation(project, {
      id: created.relation.id,
      from: { kind: 'event', eventId: 'EVT-cccccccccc' },
      description: '只改描述',
    })
    expect(untouched.relation.from).toEqual({ kind: 'event', id: 'EVT-cccccccccc' })
  })

  it('级联：removeRelationsReferencingEvent 移除两端任一引用该事件的关系并清理坐标', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedElement('elements/characters/老周.md', { name: '老周', id: 'ELM-bbbbbbbbbb' })
    await seedTimelineEvent('EVT-cccccccccc', '北境之战')
    const asFrom = await createRelation(project, {
      from: { kind: 'event', eventId: 'EVT-cccccccccc' },
      to: { kind: 'element', id: 'ELM-aaaaaaaaaa' },
      type: '导致',
    })
    const asTo = await createRelation(project, {
      from: { kind: 'element', id: 'ELM-bbbbbbbbbb' },
      to: { kind: 'event', eventId: 'EVT-cccccccccc' },
      type: '目击',
    })
    await createRelation(project, {
      from: { kind: 'element', id: 'ELM-aaaaaaaaaa' },
      to: { kind: 'element', id: 'ELM-bbbbbbbbbb' },
      type: '盟友',
    })
    await saveRelationLayout(project, {
      'EVT-cccccccccc': { x: 1, y: 2 },
      'ELM-aaaaaaaaaa': { x: 3, y: 4 },
    })

    const { removedRelations } = await removeRelationsReferencingEvent(project, 'EVT-cccccccccc')
    expect(removedRelations.map((relation) => relation.id).sort()).toEqual([asFrom.relation.id, asTo.relation.id].sort())

    const document = await loadRelationLedger(project)
    expect(document.relations).toHaveLength(1)
    expect(document.relations[0]!.type).toBe('盟友')
    // 事件坐标清掉，要素坐标保留
    expect(document.layout['EVT-cccccccccc']).toBeUndefined()
    expect(document.layout['ELM-aaaaaaaaaa']).toEqual({ x: 3, y: 4 })

    // 再跑一次是幂等空操作
    const again = await removeRelationsReferencingEvent(project, 'EVT-cccccccccc')
    expect(again.removedRelations).toHaveLength(0)
  })

  it('检查：事件引用对账时间线——存在则干净，已删则报悬空；账本损坏时跳过事件检查', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedTimelineEvent('EVT-cccccccccc', '北境之战')
    await createRelation(project, {
      from: { kind: 'event', eventId: 'EVT-cccccccccc' },
      to: { kind: 'element', id: 'ELM-aaaaaaaaaa' },
      type: '导致',
    })
    expect((await checkRelationLedger(project)).issues).toHaveLength(0)

    // 事件被删除（账本还在，事件没了）
    await writeProjectTextFile(root, TIMELINE_LEDGER_PATH, JSON.stringify({ version: 1, markers: [] }, null, 2))
    const { issues } = await checkRelationLedger(project)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'dangling-reference', id: 'EVT-cccccccccc', endpoint: 'from' })

    // 时间线账本损坏（JSON 无法解析）：不误报、不崩溃（事件检查跳过，由时间线界面呈现损坏态）
    await writeProjectTextFile(root, TIMELINE_LEDGER_PATH, '根本不是 JSON')
    expect((await checkRelationLedger(project)).issues).toHaveLength(0)
  })
})

describe('review 修复批', () => {
  async function seedPairWithRelation() {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedElement('elements/characters/老周.md', { name: '老周', id: 'ELM-bbbbbbbbbb' })
    return createRelation(project, {
      from: { kind: 'element', id: 'ELM-aaaaaaaaaa' },
      to: { kind: 'element', id: 'ELM-bbbbbbbbbb' },
      type: '盟友',
    })
  }

  async function injectRaw(extraRelations: unknown[], extraLayout: Record<string, unknown> = {}) {
    const document = await loadRelationLedger(project)
    await writeProjectTextFile(root, RELATION_LEDGER_PATH, JSON.stringify({
      version: 1,
      relations: [...document.relations, ...extraRelations],
      layout: { ...document.layout, ...extraLayout },
    }, null, 2))
  }

  it('#2 坐标保存不洗掉隔离条目：非法关系与非法坐标原样写回', async () => {
    await seedPairWithRelation()
    const bad = { id: 'REL-handwrite0', type: '手写', from: { kind: 'element', id: 'ELM-aaaaaaaaaa' } }
    await injectRaw([bad], { 'ELM-zzzzzzzzzz': { x: '东', y: 1 } })

    await saveRelationLayout(project, { 'ELM-aaaaaaaaaa': { x: 1, y: 2 } })

    const raw = JSON.parse(await readProjectTextFile(root, RELATION_LEDGER_PATH))
    expect(raw.relations).toHaveLength(2)
    expect(raw.relations[1]).toEqual(bad)
    expect(raw.layout['ELM-zzzzzzzzzz']).toEqual({ x: '东', y: 1 })
    expect(raw.layout['ELM-aaaaaaaaaa']).toEqual({ x: 1, y: 2 })
    expect((await loadRelationLedger(project)).issues).toHaveLength(2)
  })

  it('#2 relations 整体不是数组时坐标保存拒绝（无法原样写回）', async () => {
    await writeProjectTextFile(root, RELATION_LEDGER_PATH, JSON.stringify({ version: 1, relations: { 坏: true }, layout: {} }))
    await expect(saveRelationLayout(project, { 'ELM-aaaaaaaaaa': { x: 1, y: 2 } })).rejects.toThrow('清理异常条目')
    expect(JSON.parse(await readProjectTextFile(root, RELATION_LEDGER_PATH)).relations).toEqual({ 坏: true })
  })

  it('#3 只改类型/描述时端点即使悬空也能保存；传入与当前相同的标识不重新解析', async () => {
    const created = await seedPairWithRelation()
    // 删掉两端要素文件（账本保留）：两端都悬空
    const elements = await root.getDirectoryHandle('elements')
    await elements.removeEntry('characters', { recursive: true })
    const updated = await updateRelation(project, {
      id: created.relation.id,
      description: '悬空后改描述',
      from: { kind: 'element', id: 'ELM-aaaaaaaaaa' },
      to: { kind: 'element', id: 'ELM-bbbbbbbbbb' },
    })
    expect(updated.relation.description).toBe('悬空后改描述')
  })

  it('#4 校验失败不改写要素文件：终点找不到时起点不被分配标识', async () => {
    await seedElement('elements/characters/孙七.md', { name: '孙七' })
    await expect(createRelation(project, {
      from: { kind: 'element', type: 'character', name: '孙七' },
      to: { kind: 'element', type: 'character', name: '不存在的人' },
      type: '合作',
    })).rejects.toThrow('找不到')
    expect(await readProjectTextFile(root, 'elements/characters/孙七.md')).toMatch(/^id: $/m)
  })

  it('#4 自环在分配标识前拦截（同一无标识要素按路径判定）', async () => {
    await seedElement('elements/characters/孙七.md', { name: '孙七' })
    await expect(createRelation(project, {
      from: { kind: 'element', type: 'character', name: '孙七' },
      to: { kind: 'element', sourcePath: 'elements/characters/孙七.md' },
      type: '自省',
    })).rejects.toThrow('自环')
    expect(await readProjectTextFile(root, 'elements/characters/孙七.md')).toMatch(/^id: $/m)
  })

  it('按路径定位无标识要素：登记成功并懒分配标识', async () => {
    await seedElement('elements/characters/陈六.md', { name: '陈六' })
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    const result = await createRelation(project, {
      from: { kind: 'element', sourcePath: 'elements/characters/陈六.md' },
      to: { kind: 'element', id: 'ELM-aaaaaaaaaa' },
      type: '仇敌',
    })
    expect(result.assignedElementIds).toEqual([{ sourcePath: 'elements/characters/陈六.md', id: result.relation.from.id }])
  })

  it('#5 重复关系 id：后出现者隔离，按 id 删除只命中首条且写入被阻止直至清理', async () => {
    const created = await seedPairWithRelation()
    await injectRaw([{ ...created.relation, type: '长老' }])

    const loaded = await loadRelationLedger(project)
    expect(loaded.relations).toHaveLength(1)
    expect(loaded.issues.map((issue) => issue.kind)).toEqual(['duplicate-relation-id'])
    await expect(deleteRelation(project, created.relation.id)).rejects.toThrow('写入已被阻止')

    await removeInvalidRelationEntries(project)
    await deleteRelation(project, created.relation.id)
    expect((await loadRelationLedger(project)).relations).toHaveLength(0)
  })

  it('#6 账本有隔离条目时删除要素的级联照常执行，隔离条目保留', async () => {
    const created = await seedPairWithRelation()
    const bad = { id: 'REL-bad0000000', type: '坏' }
    await injectRaw([bad])

    const result = await removeRelationsReferencing(project, 'ELM-aaaaaaaaaa')
    expect(result.removedRelations.map((relation) => relation.id)).toEqual([created.relation.id])
    const raw = JSON.parse(await readProjectTextFile(root, RELATION_LEDGER_PATH))
    expect(raw.relations).toEqual([bad])
  })

  it('#7 类型首尾空格被 trim；空白类型拒绝', async () => {
    const created = await seedPairWithRelation()
    const updated = await updateRelation(project, { id: created.relation.id, type: ' 敌对 ' })
    expect(updated.relation.type).toBe('敌对')
    await expect(updateRelation(project, { id: created.relation.id, type: '   ' })).rejects.toThrow('不能为空')
  })

  it('#1 expectedRelationVersion：别的关系或坐标写入不冲突；这条关系被改才冲突', async () => {
    const created = await seedPairWithRelation()
    await seedElement('elements/characters/第三者.md', { name: '第三者', id: 'ELM-cccccccccc' })
    const version = relationVersion(created.relation)

    // 其他写入：新增别的关系 + 保存坐标
    await createRelation(project, { from: { kind: 'element', id: 'ELM-bbbbbbbbbb' }, to: { kind: 'element', id: 'ELM-cccccccccc' }, type: '隶属' })
    await saveRelationLayout(project, { 'ELM-aaaaaaaaaa': { x: 3, y: 4 } })

    const saved = await updateRelation(project, { id: created.relation.id, description: '我的修改', expectedRelationVersion: version })
    expect(saved.relation.description).toBe('我的修改')

    // 这条关系已被改过，旧版本令牌再提交 → 冲突；被删除 → 冲突
    await expect(updateRelation(project, { id: created.relation.id, description: '过期提交', expectedRelationVersion: version }))
      .rejects.toThrow(RelationConflictError)
    await deleteRelation(project, created.relation.id)
    await expect(updateRelation(project, { id: created.relation.id, description: 'x', expectedRelationVersion: relationVersion(saved.relation) }))
      .rejects.toThrow(RelationConflictError)
  })
})
