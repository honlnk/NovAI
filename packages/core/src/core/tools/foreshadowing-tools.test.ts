import { beforeEach, describe, expect, it } from 'vitest'

import {
  createForeshadowingTool,
  deleteForeshadowingTool,
  listForeshadowingTool,
  readForeshadowingForPlanningTool,
  readForeshadowingTool,
  updateForeshadowingTool,
} from './foreshadowing-tools'
import { scanForeshadowingCards } from '../foreshadowing/catalog'
import type { ToolRuntime } from './types'
import { writeProjectTextFile } from '../fs/project-fs'

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

let root: MemoryDirectoryHandle

function runtime(): ToolRuntime {
  return { project: { handle: root } as never }
}

beforeEach(() => {
  root = createMemoryDirectory('project')
})

async function createSample() {
  return createForeshadowingTool.run(
    createForeshadowingTool.validateInput({
      name: '旧照片之谜',
      readerView: '主角在旧书店发现一张褪色的照片。',
      authorTruth: '主角是研究员的复制体。',
      plantedAt: '第一卷/第012章',
      payoffWindow: ['第二卷/第080章', '第二卷/第090章'],
      relatedCharacters: ['主角', '母亲'],
    }),
    runtime(),
  )
}

describe('CreateForeshadowing', () => {
  it('登记伏笔并产出文件变更与确认预览', async () => {
    const output = await createSample()

    expect(output.id).toBe('F-001')
    expect(output.sourcePath).toBe('foreshadowing/F-001-旧照片之谜.md')
    expect(createForeshadowingTool.extractFileChange(output)).toEqual({ type: 'created', path: output.sourcePath })
    expect(createForeshadowingTool.extractChangeDiff(output)?.newText).toContain('作者真相')
    const confirmation = createForeshadowingTool.buildConfirmation(createForeshadowingTool.validateInput({
      name: 'A', readerView: '读者内容', authorTruth: '真相内容', plantedAt: '第一卷/第001章',
    }))!
    expect(confirmation.kind).toBe('create')
    expect(confirmation.content).toContain('读者内容')
    expect(confirmation.content).not.toContain('真相内容')
    expect(confirmation.content).toContain('已填写')
  })

  it('缺读者视角或埋设章节时校验失败', () => {
    expect(() => createForeshadowingTool.validateInput({ name: 'A', readerView: '', plantedAt: 'x' }))
      .toThrow('读者视角不能为空')
    expect(() => createForeshadowingTool.validateInput({ name: 'A', readerView: 'r', plantedAt: ' ' }))
      .toThrow('埋设章节不能为空')
    expect(() => createForeshadowingTool.validateInput({ name: 'A', readerView: 'r', plantedAt: 'x', payoffWindow: ['只有一章'] }))
      .toThrow('payoffWindow')
  })
})

describe('ListForeshadowing / Read 链路', () => {
  it('List 按状态过滤，摘要不含真相', async () => {
    await createSample()
    const output = await listForeshadowingTool.run(listForeshadowingTool.validateInput({ status: 'planted' }), runtime())

    expect(output.totalCount).toBe(1)
    expect(output.foreshadowing[0]!.name).toBe('旧照片之谜')
    expect(output.foreshadowing[0]!.summary).toContain('旧书店')
    expect(output.foreshadowing[0]!.summary).not.toContain('复制体')

    const empty = await listForeshadowingTool.run(listForeshadowingTool.validateInput({ status: 'resolved' }), runtime())
    expect(empty.totalCount).toBe(0)
  })

  it('ReadForeshadowing 永不含作者真相', async () => {
    const created = await createSample()
    const output = await readForeshadowingTool.run(readForeshadowingTool.validateInput({ id: created.id }), runtime())

    expect('notFound' in output).toBe(false)
    expect(output.truthHidden).toBe(true)
    expect(output.body).toContain('旧书店')
    expect(output.body).not.toContain('复制体')
    expect(output.body).not.toContain('作者真相')
    expect(output.contentHash).toBeTruthy()
  })

  it('ReadForeshadowingForPlanning 含作者真相', async () => {
    const created = await createSample()
    const output = await readForeshadowingForPlanningTool.run(
      readForeshadowingForPlanningTool.validateInput({ id: created.id }),
      runtime(),
    )

    expect(output.authorTruth).toBe('主角是研究员的复制体。')
    expect(output.body).toContain('作者真相')
  })

  it('不存在的伏笔返回 notFound 而非抛错', async () => {
    const output = await readForeshadowingTool.run(readForeshadowingTool.validateInput({ id: 'F-404' }), runtime())
    expect('notFound' in output).toBe(true)
  })
})

describe('UpdateForeshadowing', () => {
  it('只改状态不需要 hash；改正文必须先读后写', async () => {
    const created = await createSample()

    const statusOnly = updateForeshadowingTool.validateInput({ id: created.id, status: 'hinted' })
    expect(statusOnly.status).toBe('hinted')

    expect(() => updateForeshadowingTool.validateInput({ id: created.id, readerView: '新内容' }))
      .toThrow('expectedContentHash')
  })

  it('追加暗示历史 + 推进状态', async () => {
    const created = await createSample()
    const output = await updateForeshadowingTool.run(
      updateForeshadowingTool.validateInput({
        id: created.id,
        status: 'hinted',
        addRelatedChapters: ['第一卷/第028章'],
      }),
      runtime(),
    )

    expect(output.status).toBe('hinted')

    const scan = await scanForeshadowingCards({ handle: root })
    expect(scan.cards[0]!.relatedChapters).toEqual(['第一卷/第028章'])
  })

  it('放弃必须给原因（校验层拦截）', async () => {
    const created = await createSample()
    expect(() => updateForeshadowingTool.validateInput({ id: created.id, status: 'abandoned' }))
      .toThrow('abandonedReason')
  })

  it('带旧 hash 且文件被外部改过时执行失败', async () => {
    const created = await createSample()
    const read = await readForeshadowingTool.run(readForeshadowingTool.validateInput({ id: created.id }), runtime())
    const raw = (await import('../fs/project-fs')).readProjectTextFile
    const content = await raw(root, created.sourcePath)
    await writeProjectTextFile(root, created.sourcePath, `${content}\n<!-- 外部 -->`)

    const validated = updateForeshadowingTool.validateInput({
      id: created.id,
      status: 'hinted',
      expectedContentHash: 'notFound' in read ? '' : read.contentHash,
    })
    const execution = await updateForeshadowingTool.run(validated, runtime()).then(
      () => null,
      (error: Error) => error,
    )

    expect(execution).toBeInstanceOf(Error)
    expect(execution!.message).toContain('外部修改')
  })
})

describe('DeleteForeshadowing', () => {
  it('移入回收站并产出删除变更', async () => {
    const created = await createSample()
    const output = await deleteForeshadowingTool.run(deleteForeshadowingTool.validateInput({ id: created.id }), runtime())

    expect(output.trashPath.startsWith('.novel/trash/')).toBe(true)
    expect(deleteForeshadowingTool.extractFileChange(output)).toMatchObject({ type: 'deleted', path: created.sourcePath })
    const scan = await scanForeshadowingCards({ handle: root })
    expect(scan.cards).toHaveLength(0)
  })
})
