import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearRuntimeProjects,
  removeRuntimeProject,
  setRuntimeProject,
} from './project-runtime'
import {
  createPlan,
  deletePlan,
  getPlanBoard,
  listPlanCards,
  readPlan,
  updatePlan,
} from './plan-service'
import { writeProjectTextFile } from '../core/fs/project-fs'
import { PlanConflictError } from '../types/plans'
import type { ProjectSnapshot } from '../types/project'

/* ---------- 内存文件系统（与其他服务测试同款内联实现） ---------- */

type MemoryFileEntry = {
  kind: 'file'
  name: string
  content: string
  lastModified: number
}

type MemoryDirectoryEntry = {
  kind: 'directory'
  name: string
  entries: Map<string, MemoryEntry>
}

type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry

type MemoryDirectoryHandle = FileSystemDirectoryHandle & {
  __entry: MemoryDirectoryEntry
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

      const next: MemoryDirectoryEntry = {
        kind: 'directory',
        name,
        entries: new Map(),
      }
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

      const next: MemoryFileEntry = {
        kind: 'file',
        name,
        content: '',
        lastModified: Date.now(),
      }
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
        yield child.kind === 'directory'
          ? createDirectoryHandle(child)
          : createFileHandle(child)
      }
    },
  } as unknown as MemoryDirectoryHandle
}

function createFileHandle(entry: MemoryFileEntry): FileSystemFileHandle {
  return {
    kind: 'file',
    name: entry.name,
    async getFile() {
      return new File([entry.content], entry.name, {
        type: 'text/plain',
        lastModified: entry.lastModified,
      })
    },
    async createWritable() {
      let nextContent = ''

      return {
        async write(data: FileSystemWriteChunkType) {
          nextContent = typeof data === 'string'
            ? data
            : data instanceof Blob
              ? await data.text()
              : String(data)
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as unknown as FileSystemFileHandle
}

function createProjectSnapshot(id: string): ProjectSnapshot {
  const root = createDirectoryHandle({
    kind: 'directory',
    name: `${id}-root`,
    entries: new Map(),
  })

  return {
    id,
    name: id,
    rootName: root.name,
    handle: root as FileSystemDirectoryHandle,
    config: {} as ProjectSnapshot['config'],
    manifest: {} as ProjectSnapshot['manifest'],
    tree: [],
    metadata: {
      id,
      name: id,
      updatedAt: '',
      chapterCount: 0,
      elementCount: 0,
      wordCount: 0,
    },
  }
}

/* ---------- 测试 ---------- */

const PROJECT_A = 'plan-service-test-a'
const PROJECT_B = 'plan-service-test-b'

let snapshotA: ProjectSnapshot
let snapshotB: ProjectSnapshot

beforeEach(() => {
  clearRuntimeProjects()
  snapshotA = createProjectSnapshot(PROJECT_A)
  snapshotB = createProjectSnapshot(PROJECT_B)
  setRuntimeProject(snapshotA)
  setRuntimeProject(snapshotB)
})

afterEach(() => {
  clearRuntimeProjects()
})

describe('getPlanBoard', () => {
  it('旧项目无 plans 目录：五列全空、无异常，不抛错', async () => {
    const board = await getPlanBoard(PROJECT_A)

    expect(board.columns.inbox).toEqual([])
    expect(board.columns.planned).toEqual([])
    expect(board.columns['in-progress']).toEqual([])
    expect(board.columns.done).toEqual([])
    expect(board.columns['on-hold']).toEqual([])
    expect(board.issues).toEqual([])
  })

  it('看板视图按列分组且列内有序；摘要不含全文正文', async () => {
    const a = await createPlan(PROJECT_A, { body: '# 第一条\n\n正文一' })
    const b = await createPlan(PROJECT_A, { body: '# 第二条' })
    await updatePlan(PROJECT_A, { id: b.id, status: 'in-progress' })

    const board = await getPlanBoard(PROJECT_A)

    expect(board.columns.inbox.map((card) => card.id)).toEqual([a.id])
    expect(board.columns['in-progress'].map((card) => card.id)).toEqual([b.id])
    expect(board.columns.inbox[0]?.title).toBe('第一条')
    expect(board.columns.inbox[0]?.summary).toBe('# 第一条')
    // 摘要不携带全文
    expect((board.columns.inbox[0] as Record<string, unknown>).body).toBeUndefined()
  })

  it('重复标识进入 issues 报告', async () => {
    await writeProjectTextFile(snapshotA.handle, 'plans/计划-1-aaaa1111.md', '---\nid: plan-dup\nstatus: inbox\n---\n\n# 一')
    await writeProjectTextFile(snapshotA.handle, 'plans/计划-2-bbbb2222.md', '---\nid: plan-dup\nstatus: planned\n---\n\n# 二')

    const board = await getPlanBoard(PROJECT_A)

    expect(board.issues).toHaveLength(1)
    expect(board.issues[0]).toMatchObject({ kind: 'duplicate-id', id: 'plan-dup' })
  })
})

describe('listPlanCards', () => {
  it('可按状态筛选；返回摘要字段不返回全文', async () => {
    const a = await createPlan(PROJECT_A, { body: '# 收集箱卡片' })
    const b = await createPlan(PROJECT_A, { body: '# 计划中卡片', status: 'planned' })

    const all = await listPlanCards(PROJECT_A)
    const planned = await listPlanCards(PROJECT_A, 'planned')

    expect(all.map((card) => card.id).sort()).toEqual([a.id, b.id].sort())
    expect(planned.map((card) => card.id)).toEqual([b.id])
    expect(planned[0]).toMatchObject({
      title: '计划中卡片',
      summary: '# 计划中卡片',
      status: 'planned',
    })
    expect((planned[0] as Record<string, unknown>).body).toBeUndefined()
  })

  it('项目隔离：A 项目的卡片不出现在 B 项目', async () => {
    const a = await createPlan(PROJECT_A, { body: 'A 项目的计划' })
    const boardB = await getPlanBoard(PROJECT_B)
    const listB = await listPlanCards(PROJECT_B)

    expect(boardB.columns.inbox).toEqual([])
    expect(listB).toEqual([])
    expect((await listPlanCards(PROJECT_A)).map((c) => c.id)).toEqual([a.id])
  })
})

describe('readPlan / createPlan / updatePlan / deletePlan', () => {
  it('createPlan：默认收集箱列尾；readPlan 按 id 读全文', async () => {
    const created = await createPlan(PROJECT_A, { body: '# 详情正文\n\n多行内容' })

    expect(created.status).toBe('inbox')

    const read = await readPlan(PROJECT_A, created.id)
    expect(read?.body).toBe('# 详情正文\n\n多行内容')
    expect(read?.title).toBe('详情正文')
    expect(read?.sourcePath).toBe(created.sourcePath)
  })

  it('readPlan 读不到返回 null；updatePlan/deletePlan 报错', async () => {
    expect(await readPlan(PROJECT_A, 'plan-none')).toBeNull()
    await expect(updatePlan(PROJECT_A, { id: 'plan-none', body: 'x' })).rejects.toThrow('计划不存在')
    await expect(deletePlan(PROJECT_A, 'plan-none')).rejects.toThrow('计划不存在')
  })

  it('updatePlan：外部修改后带旧 hash 保存抛冲突；手动直接保存（无 hash）成功', async () => {
    const created = await createPlan(PROJECT_A, { body: '原始' })
    const read = await readPlan(PROJECT_A, created.id)

    // 外部修改
    await writeProjectTextFile(
      snapshotA.handle,
      created.sourcePath,
      `---\nid: ${created.id}\nstatus: inbox\norder: 0\ncreatedAt: ${created.createdAt}\nupdatedAt: 2026-11-03T00:00:00.000Z\n---\n\n外部正文`,
    )

    await expect(
      updatePlan(PROJECT_A, { id: created.id, body: '面板正文', expectedContentHash: read?.contentHash ?? undefined }),
    ).rejects.toThrow(PlanConflictError)

    // 手动面板不传 hash：直接保存（面板保存前有自己的冲突提示流程）
    const saved = await updatePlan(PROJECT_A, { id: created.id, body: '面板正文' })
    expect(saved.body).toBe('面板正文')
  })

  it('updatePlan：只改状态不动正文（状态更新与正文更新互不误覆盖）', async () => {
    const created = await createPlan(PROJECT_A, { body: '正文保持' })

    const updated = await updatePlan(PROJECT_A, { id: created.id, status: 'done' })

    expect(updated.status).toBe('done')
    expect(updated.body).toBe('正文保持')
  })

  it('deletePlan：移入回收站并从看板消失', async () => {
    const created = await createPlan(PROJECT_A, { body: '将被删除' })

    const result = await deletePlan(PROJECT_A, created.id)

    expect(result.trashPath).toMatch(/^\.novel\/trash\//)
    expect(await readPlan(PROJECT_A, created.id)).toBeNull()
    expect((await listPlanCards(PROJECT_A))).toEqual([])
  })

  it('createPlan 空正文拒绝', async () => {
    await expect(createPlan(PROJECT_A, { body: '' })).rejects.toThrow('计划正文不能为空')
  })
})

describe('项目运行时隔离', () => {
  it('未打开的项目：报「项目未打开」', async () => {
    removeRuntimeProject(PROJECT_B)

    await expect(getPlanBoard(PROJECT_B)).rejects.toThrow('项目未打开或运行时已释放')
  })
})
