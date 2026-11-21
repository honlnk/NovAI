import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  relationCheckTool,
  relationCreateTool,
  relationDeleteTool,
  relationListTool,
  relationQueryTool,
  relationReadTool,
  relationUpdateTool,
} from './relation-tools'
import { deleteFileTool } from './file-tools'
import { setRuntimeProject, clearRuntimeProjects } from '../../services/project-runtime'
import { writeProjectTextFile, readProjectTextFile } from '../fs/project-fs'
import { RELATION_LEDGER_PATH } from '../../types/relation'
import type { ProjectSnapshot } from '../../types/project'
import type { ToolRuntime } from './types'

/* ---------- 内存文件系统（与其他工具测试同款内联实现） ---------- */

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

function runtime(): ToolRuntime {
  return { project }
}

function elementFile(options: { id?: string; type?: string; name: string; summary?: string }): string {
  return [
    '---',
    `id: ${options.id ?? ''}`,
    `type: ${options.type ?? 'character'}`,
    `name: ${options.name}`,
    `summary: ${options.summary ?? ''}`,
    '---',
    '',
    `# ${options.name}`,
  ].join('\n')
}

async function seedElement(path: string, options: { id?: string; type?: string; name: string }): Promise<void> {
  await writeProjectTextFile(root, path, elementFile(options))
}

beforeEach(() => {
  root = createMemoryDirectory('novel')
  project = {
    id: 'proj-reltools',
    name: 'Relation Tools Test',
    rootName: 'novel',
    handle: root,
    config: {} as ProjectSnapshot['config'],
    manifest: { projectId: 'proj-reltools', version: 1, createdAt: '', lastOpenedAt: '' },
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  }
  setRuntimeProject(project)
})

afterEach(() => {
  clearRuntimeProjects()
})

async function seedPair() {
  await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
  await seedElement('elements/characters/老周.md', { name: '老周', id: 'ELM-bbbbbbbbbb' })
}

/* ---------- RelationCreate ---------- */

describe('RelationCreate', () => {
  it('按名称建关系：端点名称解析、产出 created 文件变更、确认预览与懒分配提示', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜' })
    await seedElement('elements/characters/老周.md', { name: '老周' })

    const input = relationCreateTool.validateInput({
      from: { type: 'character', name: '林澜' },
      to: { type: 'character', name: '老周' },
      type: '师徒',
      description: '林澜拜老周为师',
    })
    const output = await relationCreateTool.run(input, runtime())

    expect(output.id).toMatch(/^REL-[0-9a-z]{10}$/)
    expect(output.from).toMatchObject({ name: '林澜', type: 'character' })
    expect(output.to).toMatchObject({ name: '老周', type: 'character' })
    expect(output.created).toBe(true)
    expect(output.sourcePath).toBe(RELATION_LEDGER_PATH)
    expect(output.assignedElementIds).toHaveLength(2)
    expect(relationCreateTool.extractFileChange(output)).toEqual({ type: 'created', path: RELATION_LEDGER_PATH })
    expect(relationCreateTool.extractChangeDiff(output)!.linesAdded).toBeGreaterThan(0)

    const confirmation = relationCreateTool.buildConfirmation(input)!
    expect(confirmation.kind).toBe('create')
    // path 必须是真实账本路径（不带展示后缀）：写确认面板按它探测磁盘
    expect(confirmation.path).toBe(RELATION_LEDGER_PATH)
    expect(confirmation.content).toContain('林澜（character） → 老周（character）')
    expect(confirmation.content).toContain('师徒')

    // 懒分配的标识已写进要素文件
    const content = await readProjectTextFile(root, 'elements/characters/林澜.md')
    expect(content).toMatch(/^id: ELM-[0-9a-z]{10}$/m)
  })

  it('第二条关系：文件变更为 updated；重复登记被拒', async () => {
    await seedPair()
    await relationCreateTool.run(relationCreateTool.validateInput({
      from: { id: 'ELM-aaaaaaaaaa' }, to: { id: 'ELM-bbbbbbbbbb' }, type: '盟友',
    }), runtime())
    const second = await relationCreateTool.run(relationCreateTool.validateInput({
      from: { id: 'ELM-aaaaaaaaaa' }, to: { id: 'ELM-bbbbbbbbbb' }, type: '仇敌',
    }), runtime())
    expect(second.created).toBe(false)
    expect(relationCreateTool.extractFileChange(second)).toEqual({ type: 'updated', path: RELATION_LEDGER_PATH })

    await expect(relationCreateTool.run(relationCreateTool.validateInput({
      from: { id: 'ELM-aaaaaaaaaa' }, to: { id: 'ELM-bbbbbbbbbb' }, type: '盟友',
    }), runtime())).rejects.toThrow('同向同类型')
  })

  it('校验拦截：节点定位缺字段、非要素类型、kind 非 element', () => {
    expect(() => relationCreateTool.validateInput({
      from: {}, to: { type: 'character', name: '老周' }, type: '盟友',
    })).toThrow('必须提供 id')
    expect(() => relationCreateTool.validateInput({
      from: { type: 'character' }, to: { id: 'ELM-aaaaaaaaaa' }, type: '盟友',
    })).toThrow('type 与 name 都必须提供')
    expect(() => relationCreateTool.validateInput({
      from: { type: 'timeline', name: '大事件' }, to: { id: 'ELM-aaaaaaaaaa' }, type: '关联',
    })).toThrow('旧时间线要素不是关系节点')
    expect(() => relationCreateTool.validateInput({
      from: { kind: 'event', id: 'EVT-0001' }, to: { id: 'ELM-aaaaaaaaaa' }, type: '关联',
    })).toThrow('第一版只支持 element')
  })
})

/* ---------- RelationList / RelationRead / RelationQuery ---------- */

describe('RelationList / RelationRead / RelationQuery', () => {
  async function seedGraph() {
    await seedPair()
    await seedElement('elements/entities/铁剑门.md', { name: '铁剑门', type: 'entity', id: 'ELM-cccccccccc' })
    await relationCreateTool.run(relationCreateTool.validateInput({
      from: { id: 'ELM-aaaaaaaaaa' }, to: { id: 'ELM-bbbbbbbbbb' }, type: '盟友',
    }), runtime())
    await relationCreateTool.run(relationCreateTool.validateInput({
      from: { id: 'ELM-bbbbbbbbbb' }, to: { id: 'ELM-cccccccccc' }, type: '隶属',
    }), runtime())
  }

  it('List 全量与筛选（elementType / relationType）；guidance 提示查询入口', async () => {
    await seedGraph()

    const all = await relationListTool.run(relationListTool.validateInput({}), runtime())
    expect(all.totalCount).toBe(2)
    expect(all.relations[0]!.from.name).toBe('林澜')

    const entity = await relationListTool.run(relationListTool.validateInput({ elementType: 'entity' }), runtime())
    expect(entity.totalCount).toBe(1)

    const ally = await relationListTool.run(relationListTool.validateInput({ relationType: '盟友' }), runtime())
    expect(ally.totalCount).toBe(1)

    expect(() => relationListTool.validateInput({ elementType: 'timeline' })).toThrow('elementType')
  })

  it('Read 命中与 notFound；带端点摘要与时间', async () => {
    await seedGraph()
    const list = await relationListTool.run(relationListTool.validateInput({}), runtime())

    const read = await relationReadTool.run(relationReadTool.validateInput({ id: list.relations[0]!.id }), runtime())
    expect('notFound' in read && read.notFound).toBeFalsy()
    if (!('notFound' in read)) {
      expect(read.type).toBe('盟友')
      expect(read.createdAt).toBeTruthy()
      expect(read.resolutionNote).toBe('')
    }

    const missing = await relationReadTool.run(relationReadTool.validateInput({ id: 'REL-xxxxxxxxxx' }), runtime())
    expect('notFound' in missing && missing.notFound).toBe(true)
  })

  it('Query：elementId 相连关系；elementIds 集合内关系；入参互斥校验', async () => {
    await seedGraph()

    const lin = await relationQueryTool.run(relationQueryTool.validateInput({ elementId: 'ELM-aaaaaaaaaa' }), runtime())
    expect(lin.totalCount).toBe(1)

    const pair = await relationQueryTool.run(relationQueryTool.validateInput({ elementIds: ['ELM-bbbbbbbbbb', 'ELM-cccccccccc'] }), runtime())
    expect(pair.totalCount).toBe(1)
    expect(pair.relations[0]!.type).toBe('隶属')

    expect(() => relationQueryTool.validateInput({ elementId: 'ELM-aaaaaaaaaa', elementIds: ['ELM-aaaaaaaaaa'] }))
      .toThrow('二选一')
    expect(() => relationQueryTool.validateInput({})).toThrow('必须提供')
    expect(() => relationQueryTool.validateInput({ elementIds: [] })).toThrow('至少')
  })

  it('超过 50 条截断并提示', async () => {
    await seedPair()
    for (let index = 1; index <= 55; index += 1) {
      await relationCreateTool.run(relationCreateTool.validateInput({
        from: { id: 'ELM-aaaaaaaaaa' }, to: { id: 'ELM-bbbbbbbbbb' }, type: `关系${String(index).padStart(2, '0')}`,
      }), runtime())
    }

    const all = await relationListTool.run(relationListTool.validateInput({}), runtime())
    expect(all.totalCount).toBe(55)
    expect(all.relations).toHaveLength(50)
    expect(all.truncated).toBe(true)
    expect(all.guidance).toContain('前 50 条')
  })
})

/* ---------- RelationUpdate / RelationDelete ---------- */

describe('RelationUpdate / RelationDelete', () => {
  it('Update 改类型与描述，产出 updated 变更与 diff 行数', async () => {
    await seedPair()
    const created = await relationCreateTool.run(relationCreateTool.validateInput({
      from: { id: 'ELM-aaaaaaaaaa' }, to: { id: 'ELM-bbbbbbbbbb' }, type: '盟友', description: '旧',
    }), runtime())

    const input = relationUpdateTool.validateInput({ id: created.id, type: '决裂', description: '反目' })
    const output = await relationUpdateTool.run(input, runtime())
    expect(output.type).toBe('决裂')
    expect(output.description).toBe('反目')
    expect(output.from.name).toBe('林澜')
    expect(output.linesAdded).toBeGreaterThan(0)
    expect(relationUpdateTool.extractFileChange(output)).toEqual({ type: 'updated', path: RELATION_LEDGER_PATH })

    const confirmation = relationUpdateTool.buildConfirmation(input)!
    expect(confirmation.kind).toBe('edit')
    expect(confirmation.newText).toContain('决裂')

    expect(() => relationUpdateTool.validateInput({ id: created.id })).toThrow('至少提供')
    expect(() => relationUpdateTool.validateInput({ id: '' })).toThrow('不能为空')
  })

  it('Delete 移除并输出端点名称；确认卡为 delete', async () => {
    await seedPair()
    const created = await relationCreateTool.run(relationCreateTool.validateInput({
      from: { id: 'ELM-aaaaaaaaaa' }, to: { id: 'ELM-bbbbbbbbbb' }, type: '盟友',
    }), runtime())

    const input = relationDeleteTool.validateInput({ id: created.id })
    const output = await relationDeleteTool.run(input, runtime())
    expect(output.fromName).toBe('林澜')
    expect(output.toName).toBe('老周')
    expect(output.type).toBe('盟友')
    expect(output.linesRemoved).toBeGreaterThan(0)
    expect(relationDeleteTool.extractFileChange(output)).toEqual({ type: 'updated', path: RELATION_LEDGER_PATH })
    expect(relationDeleteTool.buildConfirmation(input)!.kind).toBe('delete')

    const list = await relationListTool.run(relationListTool.validateInput({}), runtime())
    expect(list.totalCount).toBe(0)
  })
})

/* ---------- RelationCheck ---------- */

describe('RelationCheck', () => {
  it('健康账本 ok；悬空引用渲染成中文 detail', async () => {
    await seedPair()
    await relationCreateTool.run(relationCreateTool.validateInput({
      from: { id: 'ELM-aaaaaaaaaa' }, to: { id: 'ELM-bbbbbbbbbb' }, type: '盟友',
    }), runtime())

    const healthy = await relationCheckTool.run(relationCheckTool.validateInput({}), runtime())
    expect(healthy.ok).toBe(true)
    expect(healthy.issues).toHaveLength(0)

    // 删除要素文件制造悬空引用（不经 DeleteFile，避免级联把关系清掉）
    const lin = root.__entry.entries.get('elements') as MemoryDirectoryEntry
    const characters = lin.entries.get('characters') as MemoryDirectoryEntry
    characters.entries.delete('林澜.md')

    const broken = await relationCheckTool.run(relationCheckTool.validateInput({}), runtime())
    expect(broken.ok).toBe(false)
    expect(broken.totalCount).toBeGreaterThan(0)
    expect(broken.issues.some((issue) => issue.kind === 'dangling-reference' && issue.detail.includes('找不到要素'))).toBe(true)
  })

  it('账本损坏时读写工具统一报损坏提示', async () => {
    await seedPair()
    await writeProjectTextFile(root, RELATION_LEDGER_PATH, '坏掉的内容')

    await expect(relationListTool.run(relationListTool.validateInput({}), runtime())).rejects.toThrow('已损坏')
    await expect(relationCreateTool.run(relationCreateTool.validateInput({
      from: { id: 'ELM-aaaaaaaaaa' }, to: { id: 'ELM-bbbbbbbbbb' }, type: '盟友',
    }), runtime())).rejects.toThrow('已损坏')
  })
})

/* ---------- DeleteFile 级联 ---------- */

describe('DeleteFile 级联清理', () => {
  it('删除要素文件级联移除引用关系并在结果中说明；非要素文件不触发', async () => {
    await seedPair()
    await relationCreateTool.run(relationCreateTool.validateInput({
      from: { id: 'ELM-aaaaaaaaaa' }, to: { id: 'ELM-bbbbbbbbbb' }, type: '盟友',
    }), runtime())
    await writeProjectTextFile(root, 'notes/随笔.md', '内容')

    const deleteElement = await deleteFileTool.run(deleteFileTool.validateInput({ path: 'elements/characters/林澜.md' }), runtime())
    expect(deleteElement.removedRelationCount).toBe(1)
    expect(deleteFileTool.summarizeOutput(deleteElement)).toContain('级联移除 1 条')

    const list = await relationListTool.run(relationListTool.validateInput({}), runtime())
    expect(list.totalCount).toBe(0)

    const deleteNote = await deleteFileTool.run(deleteFileTool.validateInput({ path: 'notes/随笔.md' }), runtime())
    expect(deleteNote.removedRelationCount).toBe(0)
  })
})
