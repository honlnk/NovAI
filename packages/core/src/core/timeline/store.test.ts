import { beforeEach, describe, expect, it } from 'vitest'

import {
  TimelineCorruptError,
  TimelineError,
  assertWritable,
  generateTimelineEventId,
  generateTimelineMarkerId,
  hasStructuralIssue,
  loadTimelineLedger,
  serializeTimelineLedger,
} from './store'
import { TIMELINE_LEDGER_PATH } from '../../types/timeline'
import { writeProjectTextFile } from '../fs/project-fs'
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

/* ---------- 项目快照与账本种子 ---------- */

let root: MemoryDirectoryHandle
let project: ProjectSnapshot

function pointMarker(options: { id?: string; eventId?: string; title?: string; storyTime?: unknown } = {}) {
  return {
    id: options.id ?? 'TM-a1b2c3d4e5',
    kind: 'point' as const,
    eventId: options.eventId ?? 'EVT-x1y2z3w4v5',
    event: {
      title: options.title ?? '小张出生',
      summary: '',
      storyTime: options.storyTime ?? null,
      relativeTime: null,
      participants: [],
      plotIds: [],
      chapters: [],
      causedBy: [],
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
    },
  }
}

function startMarker(options: { id?: string; endId?: string; eventId?: string; title?: string } = {}) {
  return {
    id: options.id ?? 'TM-b2c3d4e5f6',
    kind: 'start' as const,
    eventId: options.eventId ?? 'EVT-r1s2t3u4v5',
    event: {
      title: options.title ?? '小张学骑自行车',
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
    ...(options.endId ? {} : {}),
  }
}

function endMarker(options: { id?: string; startId?: string; eventId?: string } = {}) {
  return {
    id: options.id ?? 'TM-c3d4e5f6g7',
    kind: 'end' as const,
    eventId: options.eventId ?? 'EVT-r1s2t3u4v5',
    startId: options.startId ?? 'TM-b2c3d4e5f6',
  }
}

async function seedLedger(markers: unknown[], version: unknown = 1): Promise<void> {
  await writeProjectTextFile(root, TIMELINE_LEDGER_PATH, JSON.stringify({ version, markers }, null, 2))
}

beforeEach(() => {
  root = createMemoryDirectory('novel')
  project = { id: 'proj-timeline', handle: root } as unknown as ProjectSnapshot
})

/* ---------- 载入与损坏 ---------- */

describe('loadTimelineLedger', () => {
  it('文件不存在 → 空账本文档（contentHash 为 null，首次写入按新建语义）', async () => {
    const document = await loadTimelineLedger(project)

    expect(document.markers).toEqual([])
    expect(document.issues).toEqual([])
    expect(document.contentHash).toBeNull()
  })

  it('合法点事件与区间事件账本：按列表顺序载入，start/end 各自独立成条', async () => {
    const point = pointMarker()
    const start = startMarker()
    const middle = pointMarker({ id: 'TM-d4e5f6g7h8', eventId: 'EVT-m1n2o3p4q5', title: '小张进入小学' })
    const end = endMarker()
    await seedLedger([point, start, middle, end])

    const document = await loadTimelineLedger(project)

    expect(document.issues).toEqual([])
    expect(document.markers.map((marker) => marker.kind)).toEqual(['point', 'start', 'point', 'end'])
    expect(document.markers[1].kind === 'start' && document.markers[1].event.title).toBe('小张学骑自行车')
    expect(document.markers[3].kind === 'end' && document.markers[3].startId).toBe('TM-b2c3d4e5f6')
    expect(document.contentHash).toBeTruthy()
  })

  it.each([
    ['JSON 解析失败', '{{{'],
    ['根结构不是对象', '[1, 2, 3]'],
    ['版本不识别', null],
  ])('结构性损坏（%s）→ TimelineCorruptError 携带原始内容', async (_name, version) => {
    if (version === null) {
      await writeProjectTextFile(root, TIMELINE_LEDGER_PATH, JSON.stringify({ version: 99, markers: [] }))
    } else {
      await writeProjectTextFile(root, TIMELINE_LEDGER_PATH, version)
    }

    const error = await loadTimelineLedger(project).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TimelineCorruptError)
    expect((error as TimelineCorruptError).raw.length).toBeGreaterThan(0)
  })

  it('markers 整体不是数组 → 结构性 issue（写入全阻止），不是损坏', async () => {
    await writeProjectTextFile(root, TIMELINE_LEDGER_PATH, JSON.stringify({ version: 1, markers: 'nope' }))

    const document = await loadTimelineLedger(project)

    expect(document.markers).toEqual([])
    expect(document.issues).toHaveLength(1)
    expect(document.issues[0]).toMatchObject({ kind: 'invalid-marker', index: -1 })
    expect(hasStructuralIssue(document)).toBe(true)
  })
})

/* ---------- 单条非法与配对破坏：隔离不丢弃 ---------- */

describe('非法条目隔离', () => {
  it('形状非法（缺 id 格式 / kind 未知 / end 缺 startId / point 缺 event）→ invalid-marker 隔离', async () => {
    await seedLedger([
      { kind: 'point', eventId: 'EVT-x1y2z3w4v5', event: pointMarker().event },
      { id: 'TM-zzz', kind: 'point', eventId: 'EVT-x1y2z3w4v5', event: pointMarker().event },
      { id: 'TM-e5f6g7h8i9', kind: 'circle', eventId: 'EVT-x1y2z3w4v5' },
      { id: 'TM-f6g7h8i9j0', kind: 'end', eventId: 'EVT-r1s2t3u4v5' },
      pointMarker({ id: 'TM-g7h8i9j0k1', eventId: 'EVT-q1w2e3r4t5' }),
    ])

    const document = await loadTimelineLedger(project)

    expect(document.markers).toHaveLength(1)
    expect(document.markers[0].id).toBe('TM-g7h8i9j0k1')
    expect(document.issues.filter((issue) => issue.kind === 'invalid-marker')).toHaveLength(4)
  })

  it('事件详情字段非法（title 空 / storyTime 无 year / chapters mode 越界 / relativeTime direction 非法）→ invalid-marker', async () => {
    const badTitle = pointMarker({ id: 'TM-h8i9j0k1l2', eventId: 'EVT-a1s2d3f4g5' })
    badTitle.event.title = '  '
    const badStoryTime = pointMarker({ id: 'TM-i9j0k1l2m3', eventId: 'EVT-z1x2c3v4b5', storyTime: { calendar: '苍穹历' } })
    const badMode = pointMarker({ id: 'TM-j0k1l2m3n4', eventId: 'EVT-q1a2z3w4s5' })
    badMode.event.chapters = [{ chapterNumber: 3, mode: 'flashback' as never }]
    const badDirection = pointMarker({ id: 'TM-k1l2m3n4o5', eventId: 'EVT-p1o2i3u4y5' })
    badDirection.event.relativeTime = { anchorEventId: 'EVT-x1y2z3w4v5', offset: 1, unit: 'day', direction: 'afterwards' as never }
    await seedLedger([badTitle, badStoryTime, badMode, badDirection])

    const document = await loadTimelineLedger(project)

    expect(document.markers).toEqual([])
    expect(document.issues).toHaveLength(4)
    expect(document.issues.every((issue) => issue.kind === 'invalid-marker')).toBe(true)
  })

  it('重复标记 id（后出现者隔离）与重复事件 id（point/start 各自携带详情）', async () => {
    await seedLedger([
      pointMarker({ id: 'TM-l2m3n4o5p6', eventId: 'EVT-k1j2i3h4g5' }),
      pointMarker({ id: 'TM-l2m3n4o5p6', eventId: 'EVT-f1g2h3j4k5' }),
      startMarker({ id: 'TM-m3n4o5p6q7', eventId: 'EVT-d1f2g3h4j5' }),
      endMarker({ id: 'TM-n4o5p6q7r8', startId: 'TM-m3n4o5p6q7', eventId: 'EVT-d1f2g3h4j5' }),
      startMarker({ id: 'TM-o5p6q7r8s9', eventId: 'EVT-d1f2g3h4j5' }),
    ])

    const document = await loadTimelineLedger(project)

    // 重复 eventId 只隔离后出现的 start，首个 start+end 配对完整、不产生落单
    expect(document.issues.map((issue) => issue.kind)).toEqual(['duplicate-marker-id', 'duplicate-event-id'])
    expect(document.markers.map((marker) => marker.id)).toEqual(['TM-l2m3n4o5p6', 'TM-m3n4o5p6q7', 'TM-n4o5p6q7r8'])
  })

  it('结束回指不存在 / 事件标识不一致 / 一对多 → orphan-end 隔离，对应 start 落单', async () => {
    const dangling = endMarker({ id: 'TM-p6q7r8s9t0', startId: 'TM-zzzzzzzzzz', eventId: 'EVT-s1d2f3g4h5' })
    const mismatch = endMarker({ id: 'TM-q7r8s9t0u1', startId: 'TM-r8s9t0u1v2', eventId: 'EVT-x1c2v3b4n5' })
    const first = endMarker({ id: 'TM-s9t0u1v2w3', startId: 'TM-t0u1v2w3x4', eventId: 'EVT-m1n2b3v4c5' })
    const second = endMarker({ id: 'TM-u1v2w3x4y5', startId: 'TM-t0u1v2w3x4', eventId: 'EVT-m1n2b3v4c5' })
    await seedLedger([
      dangling,
      startMarker({ id: 'TM-r8s9t0u1v2', eventId: 'EVT-k1l2m3n4q5' }),
      mismatch,
      startMarker({ id: 'TM-t0u1v2w3x4', eventId: 'EVT-m1n2b3v4c5' }),
      first,
      second,
    ])

    const document = await loadTimelineLedger(project)

    const kinds = document.issues.map((issue) => issue.kind)
    // issues 按原列表位置排序：index 0 孤立、1 落单、2 不一致、5 一对多
    expect(kinds).toEqual(['orphan-end', 'unpaired-start', 'orphan-end', 'orphan-end'])
    // TM-r8s9t0u1v2 的唯一 end 候选（index 2）因事件标识不一致被隔离 → 它也落单隔离
    expect(document.markers.map((marker) => marker.id)).toEqual(['TM-t0u1v2w3x4', 'TM-s9t0u1v2w3'])
  })

  it('区间倒置（结束在开始之前）→ 结束隔离为 reversed-span，开始随后落单', async () => {
    const start = startMarker({ id: 'TM-v2w3x4y5z6', eventId: 'EVT-j1k2l3m4n5' })
    const end = endMarker({ id: 'TM-w3x4y5z6a7', startId: 'TM-v2w3x4y5z6', eventId: 'EVT-j1k2l3m4n5' })
    await seedLedger([end, start])

    const document = await loadTimelineLedger(project)

    expect(document.issues.map((issue) => issue.kind)).toEqual(['reversed-span', 'unpaired-start'])
    expect(document.markers).toEqual([])
  })

  it('隔离条目不丢弃：serialize(preserveIssues) 按原位置写回，再载入结果一致', async () => {
    const good = pointMarker({ id: 'TM-x4y5z6a7b8', eventId: 'EVT-h1j2k3l4z5' })
    const orphan = endMarker({ id: 'TM-y5z6a7b8c9', startId: 'TM-zzzzzzzzzz', eventId: 'EVT-g1h2j3k4l5' })
    const raw = JSON.stringify({ version: 1, markers: [good, orphan] }, null, 2)
    await writeProjectTextFile(root, TIMELINE_LEDGER_PATH, raw)

    const document = await loadTimelineLedger(project)
    const preserved = serializeTimelineLedger(document, { preserveIssues: true })

    expect(preserved).toBe(raw)
    // 不带 preserveIssues 的常规序列化只写合法数据（清理出口用）
    expect(serializeTimelineLedger(document)).toBe(
      JSON.stringify({ version: 1, markers: [good] }, null, 2),
    )
  })

  it('存在隔离条目时 assertWritable 阻止结构写入；无 issue 时放行', async () => {
    await seedLedger([pointMarker(), endMarker({ id: 'TM-z6a7b8c9d0', startId: 'TM-zzzzzzzzzz', eventId: 'EVT-f1g2h3j4k5' })])
    const document = await loadTimelineLedger(project)

    expect(() => assertWritable(document)).toThrow(TimelineError)
    expect(() => assertWritable({ markers: [], issues: [], contentHash: 'x' })).not.toThrow()
  })
})

/* ---------- 标识生成 ---------- */

describe('标识生成', () => {
  it('事件标识与标记标识：前缀 + 10 位小写字母数字', () => {
    expect(generateTimelineEventId()).toMatch(/^EVT-[0-9a-z]{10}$/)
    expect(generateTimelineMarkerId()).toMatch(/^TM-[0-9a-z]{10}$/)
  })
})
