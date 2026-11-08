import { beforeEach, describe, expect, it } from 'vitest'

import {
  rhythmCreateTool,
  rhythmDeleteTool,
  rhythmListTool,
  rhythmReadTool,
  rhythmUpdateTool,
} from './rhythm-tools'
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

let root: MemoryDirectoryHandle

function runtime(): ToolRuntime {
  return { project: { handle: root } as never }
}

beforeEach(() => {
  root = createMemoryDirectory('project')
})

/** 标准样例：第二卷/第083章，冲突 3 · 温馨 · 无钩 · 收获爽点 */
async function createSample() {
  return rhythmCreateTool.run(
    rhythmCreateTool.validateInput({
      chapterRef: '第二卷/第083章',
      plannedConflict: 3,
      plannedMood: '温馨',
      plannedHook: '无',
      plannedPayoff: '收获',
      intentBody: '大高潮后的喘息章，回家吃饭、整理战利品。',
    }),
    runtime(),
  )
}

describe('RhythmCreate', () => {
  it('规划节奏卡：卡名按章段生成、卷自动推导、产出文件变更与确认预览', async () => {
    const output = await createSample()

    expect(output.id).toBe('R-001')
    expect(output.name).toBe('第083章节奏')
    expect(output.sourcePath).toBe('rhythm/R-001-第083章节奏.md')
    expect(rhythmCreateTool.extractFileChange(output)).toEqual({ type: 'created', path: output.sourcePath })
    const confirmation = rhythmCreateTool.buildConfirmation(rhythmCreateTool.validateInput({
      chapterRef: '第二卷/第083章',
      plannedConflict: 3,
      plannedMood: '温馨',
      plannedHook: '无',
      plannedPayoff: '收获',
    }))!
    expect(confirmation.kind).toBe('create')
    expect(confirmation.content).toContain('冲突 3 · 温馨')
  })

  it('校验拦截：缺章节、冲突越界、非法枚举', () => {
    expect(() => rhythmCreateTool.validateInput({
      chapterRef: '', plannedConflict: 3, plannedMood: '温馨', plannedHook: '无', plannedPayoff: '收获',
    })).toThrow('关联章节不能为空')
    expect(() => rhythmCreateTool.validateInput({
      chapterRef: '第一卷/第001章', plannedConflict: 0, plannedMood: '温馨', plannedHook: '无', plannedPayoff: '收获',
    })).toThrow('1~10')
    expect(() => rhythmCreateTool.validateInput({
      chapterRef: '第一卷/第001章', plannedConflict: 3, plannedMood: '开心', plannedHook: '无', plannedPayoff: '收获',
    })).toThrow('plannedMood')
  })
})

describe('RhythmRead / RhythmList', () => {
  it('Read 返回计划值、正文三节与 contentHash；不存在的卡返回 notFound', async () => {
    const created = await createSample()
    const output = await rhythmReadTool.run(rhythmReadTool.validateInput({ id: created.id }), runtime())

    expect('notFound' in output && output.notFound).toBeFalsy()
    if (!('notFound' in output)) {
      expect(output.volume).toBe('第二卷')
      expect(output.plannedConflict).toBe(3)
      expect(output.intentBody).toContain('喘息章')
      expect(output.contentHash).toBeTruthy()
      expect(output.actualConflict).toBeNull()
    }

    const missing = await rhythmReadTool.run(rhythmReadTool.validateInput({ id: 'R-999' }), runtime())
    expect('notFound' in missing && missing.notFound).toBe(true)
  })

  it('List 支持状态、卷与章号范围筛选', async () => {
    await createSample() // R-001 第二卷/第083章 planned
    await rhythmCreateTool.run(rhythmCreateTool.validateInput({
      chapterRef: '第二卷/第090章',
      plannedConflict: 8, plannedMood: '紧张', plannedHook: '危机', plannedPayoff: '无',
    }), runtime())
    // R-001 回写实际值 → written
    await rhythmUpdateTool.run(rhythmUpdateTool.validateInput({ id: 'R-001', actualConflict: 3, actualMood: '温馨', actualHook: '无', actualPayoff: '收获' }), runtime())

    const all = await rhythmListTool.run(rhythmListTool.validateInput({}), runtime())
    expect(all.totalCount).toBe(2)

    const written = await rhythmListTool.run(rhythmListTool.validateInput({ status: 'written' }), runtime())
    expect(written.rhythm.map((card) => card.id)).toEqual(['R-001'])

    const volume = await rhythmListTool.run(rhythmListTool.validateInput({ volume: '第二卷' }), runtime())
    expect(volume.totalCount).toBe(2)

    const range = await rhythmListTool.run(rhythmListTool.validateInput({ chapterFrom: 85, chapterTo: 95 }), runtime())
    expect(range.rhythm.map((card) => card.id)).toEqual(['R-002'])

    expect(() => rhythmListTool.validateInput({ chapterFrom: 95, chapterTo: 85 })).toThrow('chapterFrom')
  })
})

describe('RhythmUpdate', () => {
  it('回写实际值自动流转状态：阈值内 → written；不改 status 的计划值更新不碰状态', async () => {
    const created = await createSample()

    const plannedOnly = await rhythmUpdateTool.run(
      rhythmUpdateTool.validateInput({ id: created.id, plannedConflict: 4 }),
      runtime(),
    )
    expect(plannedOnly.status).toBe('planned')

    const written = await rhythmUpdateTool.run(
      rhythmUpdateTool.validateInput({ id: created.id, actualConflict: 4, actualMood: '温馨', actualHook: '无', actualPayoff: '收获' }),
      runtime(),
    )
    expect(written.status).toBe('written')
    expect(written.deviationFlag).toBe(false)
  })

  it('回写超阈值自动判偏差：状态 deviated 且带偏差说明', async () => {
    const created = await createSample()
    const output = await rhythmUpdateTool.run(
      rhythmUpdateTool.validateInput({ id: created.id, actualConflict: 7, actualMood: '温馨', actualHook: '悬念', actualPayoff: '收获' }),
      runtime(),
    )

    expect(output.status).toBe('deviated')
    expect(output.deviationFlag).toBe(true)
    expect(output.deviationNote).toContain('冲突强度偏差：计划 3 实际 7')
    expect(output.deviationNote).toContain('章末钩子翻转：计划 无 实际 悬念')
  })

  it('五项 actual_* 全清回到 planned（撤销回写）', async () => {
    const created = await createSample()
    await rhythmUpdateTool.run(
      rhythmUpdateTool.validateInput({ id: created.id, actualConflict: 3, actualMood: '温馨' }),
      runtime(),
    )
    const output = await rhythmUpdateTool.run(
      rhythmUpdateTool.validateInput({
        id: created.id,
        actualConflict: null, actualMood: null, actualHook: null, actualPayoff: null, actualNote: null,
      }),
      runtime(),
    )
    expect(output.status).toBe('planned')
    expect(output.deviationFlag).toBe(false)
  })

  it('更新正文三节必须带 expectedContentHash', async () => {
    const created = await createSample()
    expect(() => rhythmUpdateTool.validateInput({ id: created.id, intentBody: '新意图' }))
      .toThrow('expectedContentHash')
    expect(() => rhythmUpdateTool.validateInput({ id: created.id }))
      .toThrow('至少提供')
  })

  it('确认卡：改正文走预览分支；回写实际值注明系统自动判定', async () => {
    const bodyConfirmation = rhythmUpdateTool.buildConfirmation(
      rhythmUpdateTool.validateInput({ id: 'R-001', intentBody: '新意图', expectedContentHash: 'x' }),
    )!
    expect(bodyConfirmation.kind).toBe('edit')
    expect(bodyConfirmation.newText).toContain('新意图')

    const actualConfirmation = rhythmUpdateTool.buildConfirmation(
      rhythmUpdateTool.validateInput({ id: 'R-001', actualConflict: 7 }),
    )!
    expect(actualConfirmation.newText).toContain('系统自动判定')
  })
})

describe('RhythmDelete', () => {
  it('移入回收站并产出删除变更', async () => {
    const created = await createSample()
    const output = await rhythmDeleteTool.run(rhythmDeleteTool.validateInput({ id: created.id }), runtime())

    expect(output.trashPath.startsWith('.novel/trash/')).toBe(true)
    expect(rhythmDeleteTool.extractFileChange(output)).toMatchObject({ type: 'deleted', path: created.sourcePath })

    const list = await rhythmListTool.run(rhythmListTool.validateInput({}), runtime())
    expect(list.totalCount).toBe(0)
  })
})
