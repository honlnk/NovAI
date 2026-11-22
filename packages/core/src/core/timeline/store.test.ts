import { beforeEach, describe, expect, it } from 'vitest'

import {
  TimelineConflictError,
  TimelineCorruptError,
  TimelineError,
  assertWritable,
  checkTimelineLedger,
  createTimelinePoint,
  createTimelineSpan,
  deleteTimelineEvent,
  generateTimelineEventId,
  generateTimelineMarkerId,
  hasStructuralIssue,
  loadTimelineLedger,
  moveTimelineMarker,
  queryTimelineEvents,
  removeTimelineReferences,
  serializeTimelineLedger,
  timelineEventVersion,
  updateTimelineEvent,
} from './store'
import { TIMELINE_LEDGER_PATH } from '../../types/timeline'
import { readProjectTextFile, writeProjectTextFile } from '../fs/project-fs'
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

/* ---------- 增删改（阶段 2 契约测试第二档：配对约束 + 引用 + 级联） ---------- */

function elementFile(options: { id?: string; type?: string; name: string }): string {
  return [
    '---',
    `id: ${options.id ?? ''}`,
    `type: ${options.type ?? 'character'}`,
    `name: ${options.name}`,
    'summary: ',
    '---',
    '',
    `# ${options.name}`,
  ].join('\n')
}

async function seedElement(path: string, options: { id?: string; type?: string; name: string }): Promise<void> {
  await writeProjectTextFile(root, path, elementFile(options))
}

async function seedChapter(fileName: string): Promise<void> {
  await writeProjectTextFile(root, `chapters/${fileName}`, '正文')
}

describe('createTimelinePoint', () => {
  it('空账本首条：落盘合法结构，created 语义；锚定插入定位生效', async () => {
    const first = await createTimelinePoint(project, {
      event: { title: '小张出生' },
      position: { at: 'last' },
    })
    expect(first.marker.kind).toBe('point')
    expect(first.created).toBe(true)
    expect(first.contentHash).toBeTruthy()

    const second = await createTimelinePoint(project, {
      event: { title: '旧桥决裂' },
      position: { at: 'before', anchorMarkerId: first.marker.id },
    })
    expect(second.created).toBe(false)

    const document = await loadTimelineLedger(project)
    expect(document.markers.map((marker) => (marker.kind === 'end' ? null : marker.event.title)))
      .toEqual(['旧桥决裂', '小张出生'])
  })

  it('参与者按名称定位：懒分配 ELM 标识并写回 frontmatter；情节引用限 plot 类型', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜' })
    await seedElement('elements/plots/夺剑.md', { name: '夺剑', type: 'plot' })
    await seedElement('elements/locations/旧桥.md', { name: '旧桥', type: 'location' })

    const result = await createTimelinePoint(project, {
      event: {
        title: '旧桥伏击',
        participants: [{ kind: 'element', type: 'character', name: '林澜', role: '主谋' }],
        plots: [{ kind: 'element', type: 'plot', name: '夺剑' }],
      },
      position: { at: 'last' },
    })
    expect(result.assignedElementIds).toHaveLength(2)
    expect(result.marker.kind === 'point' && result.marker.event.participants[0]).toMatchObject({ role: '主谋' })
    // 懒分配已写回要素文件
    const content = await readProjectTextFile(root, 'elements/characters/林澜.md')
    expect(content).toMatch(/^id: ELM-[0-9a-z]{10}$/m)

    // 参与者引用情节 → 类型不符拒绝
    await expect(createTimelinePoint(project, {
      event: { title: 'x', participants: [{ kind: 'element', type: 'plot', name: '夺剑' }] },
      position: { at: 'last' },
    })).rejects.toThrow('不在允许范围')
    // 情节槽位引用地点 → 同样拒绝
    await expect(createTimelinePoint(project, {
      event: { title: 'x', plots: [{ kind: 'element', type: 'location', name: '旧桥' }] },
      position: { at: 'last' },
    })).rejects.toThrow('不在允许范围')
  })

  it('无标识要素按路径定位（UI 选择器口径）：懒分配标识；路径不存在则教学式报错', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜' })
    await seedElement('elements/characters/苏晚.md', { name: '苏晚' })
    await seedElement('elements/plots/夺剑.md', { name: '夺剑', type: 'plot' })

    const result = await createTimelinePoint(project, {
      event: {
        title: '旧桥伏击',
        participants: [
          { kind: 'element', sourcePath: 'elements/characters/林澜.md' },
          { kind: 'element', sourcePath: 'elements/characters/苏晚.md', role: '旁观' },
        ],
        plots: [{ kind: 'element', sourcePath: 'elements/plots/夺剑.md' }],
      },
      position: { at: 'last' },
    })
    // 两个同为空标识的要素各自解析到自己的文件，不被当作「同一标识被多个要素占用」
    expect(result.assignedElementIds.map((item) => item.sourcePath)).toEqual([
      'elements/characters/林澜.md',
      'elements/characters/苏晚.md',
      'elements/plots/夺剑.md',
    ])
    const event = result.marker.kind === 'point' ? result.marker.event : null
    expect(event?.participants.map((participant) => participant.id)).toEqual(result.assignedElementIds.slice(0, 2).map((item) => item.id))
    expect(event?.participants[1]).toMatchObject({ role: '旁观' })
    expect(event?.plotIds).toEqual([result.assignedElementIds[2]!.id])

    await expect(createTimelinePoint(project, {
      event: { title: 'x', participants: [{ kind: 'element', sourcePath: 'elements/characters/不存在.md' }] },
      position: { at: 'last' },
    })).rejects.toThrow('找不到')
  })

  it('章节引用经章节目录解析：章号缺失拒绝；事件互引（causedBy / 相对锚）必须已存在', async () => {
    await seedChapter('第001章-开端.txt')
    await seedChapter('第002章-旧桥.txt')
    const base = await createTimelinePoint(project, { event: { title: '旧桥伏击' }, position: { at: 'last' } })
    const baseEventId = base.marker.eventId

    // 章号存在 → 通过
    await createTimelinePoint(project, {
      event: { title: '复盘', chapters: [{ chapterNumber: 2, mode: 'recall' }] },
      position: { at: 'last' },
    })
    // 章号缺失 → 拒绝
    await expect(createTimelinePoint(project, {
      event: { title: 'x', chapters: [{ chapterNumber: 9, mode: 'current' }] },
      position: { at: 'last' },
    })).rejects.toThrow('无法解析')

    await createTimelinePoint(project, {
      event: {
        title: '决战前夜',
        causedBy: [baseEventId],
        relativeTime: { anchorEventId: baseEventId, offset: 3, unit: 'day', direction: 'after' },
      },
      position: { at: 'last' },
    })
    await expect(createTimelinePoint(project, {
      event: { title: 'x', causedBy: ['EVT-0000000000'] },
      position: { at: 'last' },
    })).rejects.toThrow('不存在')
    await expect(createTimelinePoint(project, {
      event: { title: 'x', relativeTime: { anchorEventId: 'EVT-0000000000', offset: 1, unit: 'day', direction: 'after' } },
      position: { at: 'last' },
    })).rejects.toThrow('锚事件')
  })

  it('锚标记不存在 → 教学式报错', async () => {
    await expect(createTimelinePoint(project, {
      event: { title: 'x' },
      position: { at: 'after', anchorMarkerId: 'TM-0000000000' },
    })).rejects.toThrow('锚标记')
  })
})

describe('createTimelineSpan', () => {
  it('区间跨事件合法（并行/嵌套语义）：两端中间夹其他标记；end 与 start 相邻也合法', async () => {
    const first = await createTimelinePoint(project, { event: { title: 'a' }, position: { at: 'last' } })
    const span = await createTimelineSpan(project, {
      event: { title: '三年修行' },
      startPosition: { at: 'after', anchorMarkerId: first.marker.id },
      endPosition: { at: 'last' },
    })
    const middle = await createTimelinePoint(project, {
      event: { title: '山中奇遇' },
      position: { at: 'after', anchorMarkerId: span.marker.id },
    })

    const document = await loadTimelineLedger(project)
    expect(document.markers.map((marker) => marker.kind)).toEqual(['point', 'start', 'point', 'end'])
    expect(document.issues).toEqual([])

    // 相邻区间（start 与 end 之间无其他标记）
    const tight = await createTimelineSpan(project, {
      event: { title: '顿悟' },
      startPosition: { at: 'after', anchorMarkerId: middle.marker.id },
      endPosition: { at: 'after', anchorMarkerId: middle.marker.id },
    })
    const after = await loadTimelineLedger(project)
    const tightIndex = after.markers.findIndex((marker) => marker.id === tight.marker.id)
    expect(after.markers[tightIndex + 1]?.kind).toBe('end')
    expect(after.issues).toEqual([])
  })

  it('结束位置先于开始位置 → 拒绝', async () => {
    const first = await createTimelinePoint(project, { event: { title: 'a' }, position: { at: 'first' } })
    await expect(createTimelineSpan(project, {
      event: { title: '倒置' },
      startPosition: { at: 'last' },
      endPosition: { at: 'before', anchorMarkerId: first.marker.id },
    })).rejects.toThrow('结束标记必须位于开始标记之后')
  })
})

describe('updateTimelineEvent', () => {
  async function seedTwo() {
    const a = await createTimelinePoint(project, { event: { title: 'a', summary: '旧摘要' }, position: { at: 'last' } })
    const b = await createTimelinePoint(project, { event: { title: 'b' }, position: { at: 'last' } })
    return { a, b }
  }

  it('补丁合并：只改给定的字段，其余原样保留；null 清空可空时间', async () => {
    const { a } = await seedTwo()
    await createTimelinePoint(project, {
      event: { title: 'c', storyTime: { year: 100 } },
      position: { at: 'last' },
    })
    const document = await loadTimelineLedger(project)

    const result = await updateTimelineEvent(project, {
      eventId: a.marker.eventId,
      patch: { title: 'a2', storyTime: null },
    })
    expect(result.marker.kind === 'point' && result.marker.event.title).toBe('a2')
    expect(result.marker.kind === 'point' && result.marker.event.summary).toBe('旧摘要')
    expect(result.marker.kind === 'point' && result.marker.event.storyTime).toBeNull()
    expect(result.previous.title).toBe('a')
    // 其他事件不受影响
    const after = await loadTimelineLedger(project)
    expect(after.contentHash).not.toBe(document.contentHash)
    const other = after.markers.find((marker) => marker.kind !== 'end' && marker.event.title === 'c')!
    expect(other.kind !== 'end' && other.event.storyTime).toMatchObject({ year: 100 })
  })

  it('整本哈希冲突：expectedContentHash 过期 → TimelineConflictError', async () => {
    const { a, b } = await seedTwo()
    const stale = (await loadTimelineLedger(project)).contentHash
    await updateTimelineEvent(project, { eventId: b.marker.eventId, patch: { title: 'b2' } })

    await expect(updateTimelineEvent(project, {
      eventId: a.marker.eventId,
      patch: { title: 'a3' },
      expectedContentHash: stale!,
    })).rejects.toThrow(TimelineConflictError)
  })

  it('单事件版本令牌：本事件被改过 → 冲突；只改过别的事件 → 放行', async () => {
    const { a, b } = await seedTwo()
    const versionA = timelineEventVersion(
      (await loadTimelineLedger(project)).markers.find((marker) => marker.id === a.marker.id)!.kind === 'end'
        ? null!
        : ((await loadTimelineLedger(project)).markers.find((marker) => marker.id === a.marker.id) as { event: import('../../types/timeline').TimelineEvent }).event,
    )

    // 别的事件先被改：a 的版本令牌仍有效
    await updateTimelineEvent(project, { eventId: b.marker.eventId, patch: { title: 'b2' } })
    await updateTimelineEvent(project, {
      eventId: a.marker.eventId,
      patch: { title: 'a2' },
      expectedEventVersion: versionA,
    })

    // a 自己被改后旧令牌失效
    const versionA2 = timelineEventVersion(
      ((await loadTimelineLedger(project)).markers.find((marker) => marker.id === a.marker.id) as { event: import('../../types/timeline').TimelineEvent }).event,
    )
    await updateTimelineEvent(project, { eventId: a.marker.eventId, patch: { title: 'a3' } })
    await expect(updateTimelineEvent(project, {
      eventId: a.marker.eventId,
      patch: { title: 'a4' },
      expectedEventVersion: versionA2,
    })).rejects.toThrow(TimelineConflictError)
  })

  it('旧相对锚已失效时：不给 relativeTime 的编辑不被阻塞（失效提示交给检查层）', async () => {
    const anchor = await createTimelinePoint(project, { event: { title: '锚' }, position: { at: 'last' } })
    const dependent = await createTimelinePoint(project, {
      event: {
        title: '三天后',
        relativeTime: { anchorEventId: anchor.marker.eventId, offset: 3, unit: 'day', direction: 'after' },
      },
      position: { at: 'last' },
    })
    await deleteTimelineEvent(project, { eventId: anchor.marker.eventId })

    // 锚已删除，但只改标题应放行；relativeTime 原样保留
    const result = await updateTimelineEvent(project, {
      eventId: dependent.marker.eventId,
      patch: { title: '三天后（改）' },
    })
    expect(result.marker.kind === 'point' && result.marker.event.relativeTime).toMatchObject({
      anchorEventId: anchor.marker.eventId,
    })
  })

  it('空补丁 → 拒绝', async () => {
    const { a } = await seedTwo()
    await expect(updateTimelineEvent(project, { eventId: a.marker.eventId, patch: {} }))
      .rejects.toThrow('至少提供一项')
  })
})

describe('moveTimelineMarker', () => {
  it('移动后重校验配对：把开始移进自己区间内部 → 拒绝；移到区间外 → 成功', async () => {
    const first = await createTimelinePoint(project, { event: { title: 'a' }, position: { at: 'last' } })
    const span = await createTimelineSpan(project, {
      event: { title: '修行' },
      startPosition: { at: 'after', anchorMarkerId: first.marker.id },
      endPosition: { at: 'last' },
    })
    const inner = await createTimelinePoint(project, {
      event: { title: '山中奇遇' },
      position: { at: 'after', anchorMarkerId: span.marker.id },
    })

    // 把区间结束移到开始之前 → 破坏配对，拒绝
    await expect(moveTimelineMarker(project, {
      markerId: span.endMarker!.id,
      position: { at: 'before', anchorMarkerId: span.marker.id },
    })).rejects.toThrow('区间配对')

    // 把开始移到自己结束之后（区间倒置）→ 同样破坏，拒绝
    await expect(moveTimelineMarker(project, {
      markerId: span.marker.id,
      position: { at: 'last' },
    })).rejects.toThrow('区间配对')

    // 以自己为锚 → 拒绝
    await expect(moveTimelineMarker(project, {
      markerId: span.marker.id,
      position: { at: 'after', anchorMarkerId: span.marker.id },
    })).rejects.toThrow('不能以它自己为锚点')

    // 合法移动：把中间事件移到区间之前
    const moved = await moveTimelineMarker(project, {
      markerId: inner.marker.id,
      position: { at: 'before', anchorMarkerId: span.marker.id },
    })
    expect(moved.markers.map((marker) => marker.kind)).toEqual(['point', 'point', 'start', 'end'])
  })
})

describe('deleteTimelineEvent', () => {
  it('区间事件两端同删；causedBy 级联清除；relativeTime 锚保留成失效引用', async () => {
    const anchor = await createTimelinePoint(project, { event: { title: '锚事件' }, position: { at: 'last' } })
    const span = await createTimelineSpan(project, {
      event: {
        title: '长战争',
        causedBy: [anchor.marker.eventId],
      },
      startPosition: { at: 'last' },
      endPosition: { at: 'last' },
    })
    const dependent = await createTimelinePoint(project, {
      event: {
        title: '战后重建',
        causedBy: [span.marker.eventId],
        relativeTime: { anchorEventId: span.marker.eventId, offset: 1, unit: 'year', direction: 'after' },
      },
      position: { at: 'last' },
    })

    const result = await deleteTimelineEvent(project, { eventId: span.marker.eventId })
    expect(result.removed).toHaveLength(2)

    const document = await loadTimelineLedger(project)
    expect(document.issues).toEqual([])
    // causedBy 已级联清除；relativeTime 锚保留（失效提示）
    const survivor = document.markers.find((marker) => marker.id === dependent.marker.id)!
    expect(survivor.kind !== 'end' && survivor.event.causedBy).toEqual([])
    expect(survivor.kind !== 'end' && survivor.event.relativeTime).toMatchObject({ anchorEventId: span.marker.eventId })

    // 锚失效可被检查层发现
    const check = await checkTimelineLedger(project)
    expect(check.issues.some((issue) => 'eventId' in issue && issue.eventId === dependent.marker.eventId && issue.kind === 'dangling-relative-anchor')).toBe(true)
  })

  it('删除不存在的事件 → 报错', async () => {
    await expect(deleteTimelineEvent(project, { eventId: 'EVT-0000000000' })).rejects.toThrow('不存在')
  })
})

describe('queryTimelineEvents', () => {
  it('按参与者/章号/年份过滤；区间端随开始保留，开始被滤掉时端也移除', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedChapter('第001章-开端.txt')
    await createTimelinePoint(project, {
      event: {
        title: '出生',
        storyTime: { year: 100 },
        participants: [{ kind: 'element', id: 'ELM-aaaaaaaaaa' }],
        chapters: [{ chapterNumber: 1, mode: 'current' }],
      },
      position: { at: 'last' },
    })
    await createTimelineSpan(project, {
      event: { title: '修行', storyTime: { year: 101 } },
      startPosition: { at: 'last' },
      endPosition: { at: 'last' },
    })
    await createTimelinePoint(project, { event: { title: '出山', storyTime: { year: 105 } }, position: { at: 'last' } })

    const byParticipant = await queryTimelineEvents(project, { participantElementId: 'ELM-aaaaaaaaaa' })
    expect(byParticipant.markers.filter((marker) => marker.kind !== 'end')).toHaveLength(1)

    const byYear = await queryTimelineEvents(project, { yearFrom: 101, yearTo: 104 })
    // 修行（start+end）命中；出生/出山被滤掉
    expect(byYear.markers.map((marker) => marker.kind)).toEqual(['start', 'end'])

    const byChapter = await queryTimelineEvents(project, { chapterNumber: 1 })
    expect(byChapter.markers).toHaveLength(1)
  })
})

describe('removeTimelineReferences', () => {
  it('按要素标识剥离参与者与情节关联（要素删除级联链路）', async () => {
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    await seedElement('elements/plots/夺剑.md', { name: '夺剑', type: 'plot', id: 'ELM-bbbbbbbbbb' })
    await createTimelinePoint(project, {
      event: {
        title: '旧桥伏击',
        participants: [{ kind: 'element', id: 'ELM-aaaaaaaaaa' }],
        plots: [{ kind: 'element', id: 'ELM-bbbbbbbbbb' }],
      },
      position: { at: 'last' },
    })

    const result = await removeTimelineReferences(project, 'ELM-aaaaaaaaaa')
    expect(result).toEqual({ removedParticipants: 1, removedPlotLinks: 0 })

    const document = await loadTimelineLedger(project)
    const marker = document.markers[0]!
    expect(marker.kind === 'point' && marker.event.participants).toEqual([])
    expect(marker.kind === 'point' && marker.event.plotIds).toEqual(['ELM-bbbbbbbbbb'])
  })
})

describe('updateTimelineEvent 基线透传（阶段 3）', () => {
  it('未变更的悬空参与者/已删章号/失效锚不阻塞其他字段编辑；新引用照常校验', async () => {
    await seedChapter('第001章-开端.txt')
    await seedElement('elements/characters/林澜.md', { name: '林澜', id: 'ELM-aaaaaaaaaa' })
    const anchor = await createTimelinePoint(project, {
      event: { title: '锚事件' },
      position: { at: 'last' },
    })
    const dependent = await createTimelinePoint(project, {
      event: {
        title: '三天后',
        participants: [{ kind: 'element', id: 'ELM-aaaaaaaaaa' }],
        chapters: [{ chapterNumber: 1, mode: 'current' }],
        relativeTime: { anchorEventId: anchor.marker.eventId, offset: 3, unit: 'day', direction: 'after' },
      },
      position: { at: 'last' },
    })

    // 外部删掉参与者要素与锚事件、再删章节 → 引用悬空
    await deleteTimelineEvent(project, { eventId: anchor.marker.eventId })
    await writeProjectTextFile(root, 'chapters/第001章-开端.txt', '__deleted__')
    await (await import('../fs/project-fs')).removeProjectFile(root, 'chapters/第001章-开端.txt')

    // 只改标题：悬空参与者 + 失效锚 + 已删章号全部原样保留，保存成功
    const result = await updateTimelineEvent(project, {
      eventId: dependent.marker.eventId,
      patch: { title: '三天后（改）' },
    })
    expect(result.marker.kind === 'point' && result.marker.event.participants).toEqual([
      { kind: 'element', id: 'ELM-aaaaaaaaaa' },
    ])
    expect(result.marker.kind === 'point' && result.marker.event.chapters).toEqual([
      { chapterNumber: 1, mode: 'current' },
    ])
    expect(result.marker.kind === 'point' && result.marker.event.relativeTime).toMatchObject({
      anchorEventId: anchor.marker.eventId,
    })

    // 新增的悬空参与者照常拒绝
    await expect(updateTimelineEvent(project, {
      eventId: dependent.marker.eventId,
      patch: { participants: [{ kind: 'element', id: 'ELM-zzzzzzzzzz' }] },
    })).rejects.toThrow('找不到')

    // 新章号照常拒绝
    await expect(updateTimelineEvent(project, {
      eventId: dependent.marker.eventId,
      patch: { chapters: [{ chapterNumber: 7, mode: 'current' }] },
    })).rejects.toThrow('无法解析')
  })
})
