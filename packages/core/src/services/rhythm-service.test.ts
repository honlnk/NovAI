import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearRuntimeProjects,
  removeRuntimeProject,
  setRuntimeProject,
} from './project-runtime'
import {
  createRhythm,
  deleteRhythm,
  getRhythmBoard,
  listRhythmCards,
  readRhythm,
  splitRhythmBody,
  updateRhythm,
} from './rhythm-service'
import { RhythmConflictError } from '../types/rhythm'
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

function createProjectSnapshot(id: string, threshold?: number): ProjectSnapshot {
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
    config: (threshold !== undefined
      ? { settings: { rhythmDeviationThreshold: threshold } }
      : {}) as ProjectSnapshot['config'],
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

const PROJECT_A = 'rhythm-service-test-a'
const PROJECT_B = 'rhythm-service-test-b'

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

/** 标准创建输入：第二卷/第083章，冲突 3 · 温馨 · 无钩 · 收获 */
function sampleCreateInput() {
  return {
    chapterRef: '第二卷/第083章',
    name: '第083章节奏',
    plannedConflict: 3,
    plannedMood: '温馨' as const,
    plannedHook: '无' as const,
    plannedPayoff: '收获' as const,
    intentBody: '大高潮后的喘息章。',
  }
}

describe('getRhythmBoard', () => {
  it('旧项目无 rhythm 目录：三列全空、无异常，不抛错', async () => {
    const board = await getRhythmBoard(PROJECT_A)
    expect(board.issues).toEqual([])
    expect(board.columns.planned).toEqual([])
    expect(board.columns.written).toEqual([])
    expect(board.columns.deviated).toEqual([])
  })

  it('看板按状态归列；摘要带计划值/实际值/偏差标记，不含正文三节', async () => {
    const card = await createRhythm(PROJECT_A, sampleCreateInput())
    await updateRhythm(PROJECT_A, {
      id: card.id,
      actualConflict: 7,
      actualMood: '温馨',
      actualHook: '悬念',
      actualPayoff: '收获',
    })

    const board = await getRhythmBoard(PROJECT_A)
    expect(board.columns.planned).toEqual([])
    expect(board.columns.written).toEqual([])
    expect(board.columns.deviated).toHaveLength(1)
    const summary = board.columns.deviated[0]!
    expect(summary.id).toBe(card.id)
    expect(summary.plannedConflict).toBe(3)
    expect(summary.actualConflict).toBe(7)
    expect(summary.deviationFlag).toBe(true)
    expect(summary).not.toHaveProperty('intentBody')
  })
})

describe('createRhythm / readRhythm / listRhythmCards', () => {
  it('R-001 起步、文件落在 rhythm/、view 带正文三节与 contentHash', async () => {
    const card = await createRhythm(PROJECT_A, sampleCreateInput())

    expect(card.id).toBe('R-001')
    expect(card.sourcePath.startsWith('rhythm/R-001-')).toBe(true)
    expect(card.intentBody).toContain('喘息章')
    expect(card.contentHash).toBeTruthy()

    const read = await readRhythm(PROJECT_A, card.id)
    expect(read?.plannedMood).toBe('温馨')
    expect(read?.actualConflict).toBeNull()
  })

  it('listRhythmCards 可按状态筛选；项目隔离', async () => {
    const card = await createRhythm(PROJECT_A, sampleCreateInput())
    await createRhythm(PROJECT_B, sampleCreateInput())
    await updateRhythm(PROJECT_A, { id: card.id, actualConflict: 3, actualMood: '温馨', actualHook: '无', actualPayoff: '收获' })

    const written = await listRhythmCards(PROJECT_A, 'written')
    expect(written.map((item) => item.id)).toEqual([card.id])

    // 项目 B 未回写：仍是一张规划中
    const planned = await listRhythmCards(PROJECT_B, 'planned')
    expect(planned).toHaveLength(1)
  })

  it('readRhythm 读不到返回 null', async () => {
    expect(await readRhythm(PROJECT_A, 'R-999')).toBeNull()
  })
})

describe('updateRhythm 偏差阈值从项目设置读取', () => {
  it('默认阈值 3：|3-5| < 3 → written；服务层自动注入阈值', async () => {
    const card = await createRhythm(PROJECT_A, sampleCreateInput())
    const updated = await updateRhythm(PROJECT_A, {
      id: card.id,
      actualConflict: 5,
      actualMood: '温馨',
      actualHook: '无',
      actualPayoff: '收获',
    })
    expect(updated.status).toBe('written')
    expect(updated.deviationFlag).toBe(false)
  })

  it('项目设置阈值收紧到 1：|3-4| ≥ 1 → deviated（服务层读取 config 注入）', async () => {
    setRuntimeProject(createProjectSnapshot(PROJECT_A, 1))
    const card = await createRhythm(PROJECT_A, sampleCreateInput())
    const updated = await updateRhythm(PROJECT_A, {
      id: card.id,
      actualConflict: 4,
      actualMood: '温馨',
      actualHook: '无',
      actualPayoff: '收获',
    })
    expect(updated.status).toBe('deviated')
    expect(updated.deviationNote).toContain('冲突强度偏差：计划 3 实际 4')
  })

  it('改正文带最新 hash 成功；外部修改后带旧 hash 抛 RhythmConflictError', async () => {
    const card = await createRhythm(PROJECT_A, sampleCreateInput())

    const saved = await updateRhythm(PROJECT_A, {
      id: card.id,
      intentBody: '新意图',
      expectedContentHash: card.contentHash,
    })
    expect(saved.intentBody).toBe('新意图')

    // 外部改盘后再用旧 hash 保存 → 冲突
    await createRhythm(PROJECT_A, { ...sampleCreateInput(), chapterRef: '第二卷/第084章' }) // 触发一次无关写入不影响
    const external = await readRhythm(PROJECT_A, card.id)
    expect(external).not.toBeNull()
    await updateRhythm(PROJECT_A, { id: card.id, intentBody: '外部之后的又一次保存', expectedContentHash: external!.contentHash })
    await expect(updateRhythm(PROJECT_A, {
      id: card.id,
      intentBody: '过期的草稿',
      expectedContentHash: saved.contentHash,
    })).rejects.toBeInstanceOf(RhythmConflictError)
  })

  it('只做列内重排（afterId）不需要 hash；正文原样保留', async () => {
    const first = await createRhythm(PROJECT_A, sampleCreateInput())
    const second = await createRhythm(PROJECT_A, { ...sampleCreateInput(), chapterRef: '第二卷/第084章' })

    // 初始顺序 [R-001, R-002]；把 R-001 移到 R-002 之后 → [R-002, R-001]
    const moved = await updateRhythm(PROJECT_A, { id: first.id, afterId: second.id })
    expect(moved.status).toBe('planned')
    expect(moved.intentBody).toContain('喘息章')

    const board = await getRhythmBoard(PROJECT_A)
    expect(board.columns.planned.map((item) => item.id)).toEqual([second.id, first.id])
  })
})

describe('deleteRhythm', () => {
  it('移入回收站并从看板消失', async () => {
    const card = await createRhythm(PROJECT_A, sampleCreateInput())
    const result = await deleteRhythm(PROJECT_A, card.id)

    expect(result.trashPath.startsWith('.novel/trash/')).toBe(true)
    const board = await getRhythmBoard(PROJECT_A)
    expect(board.columns.planned).toEqual([])
  })
})

describe('splitRhythmBody 服务层再导出', () => {
  it('与 AI 工具同一拆分口径：正文三节拆开', () => {
    const sections = splitRhythmBody('## 节奏意图\n\n意图内容\n\n## 作者备注\n\n备注内容')
    expect(sections.intentBody).toContain('意图内容')
    expect(sections.authorNoteBody).toContain('备注内容')
    expect(sections.linkBody).toBe('')
  })
})

describe('项目运行时隔离', () => {
  it('未打开的项目：报「项目未打开」', async () => {
    removeRuntimeProject(PROJECT_B)
    await expect(getRhythmBoard(PROJECT_B)).rejects.toThrow('项目未打开')
  })
})
