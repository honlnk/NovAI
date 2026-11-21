import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  timelineCreatePointTool,
  timelineCreateSpanTool,
  timelineDeleteTool,
  timelineListTool,
  timelineReadTool,
  timelineUpdateTool,
} from './timeline-tools'
import { setRuntimeProject, clearRuntimeProjects } from '../../services/project-runtime'
import { readProjectTextFile, writeProjectTextFile } from '../fs/project-fs'
import { TIMELINE_LEDGER_PATH } from '../../types/timeline'
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

/* ---------- 项目快照与种子 ---------- */

let root: MemoryDirectoryHandle
let project: ProjectSnapshot

function runtime(): ToolRuntime {
  return { project }
}

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

beforeEach(() => {
  root = createMemoryDirectory('novel')
  project = {
    id: 'proj-tltools',
    name: 'Timeline Tools Test',
    rootName: 'novel',
    handle: root,
    config: {} as ProjectSnapshot['config'],
    manifest: { projectId: 'proj-tltools', version: 1, createdAt: '', lastOpenedAt: '' },
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  }
  setRuntimeProject(project)
})

afterEach(() => {
  clearRuntimeProjects()
})

async function seedWorld() {
  await seedElement('elements/characters/林澜.md', { name: '林澜' })
  await seedElement('elements/characters/老周.md', { name: '老周', id: 'ELM-bbbbbbbbbb' })
  await seedElement('elements/plots/夺剑.md', { name: '夺剑', type: 'plot', id: 'ELM-cccccccccc' })
  await writeProjectTextFile(root, 'chapters/第001章-旧桥.txt', '正文一')
  await writeProjectTextFile(root, 'chapters/第002章-复盘.txt', '正文二')
}

/* ---------- TimelineCreatePoint / TimelineCreateSpan ---------- */

describe('TimelineCreatePoint', () => {
  it('按名称登记：懒分配写回、名称解析输出、created 变更与确认预览', async () => {
    await seedWorld()

    const input = timelineCreatePointTool.validateInput({
      event: {
        title: '旧桥伏击',
        summary: '林澜在旧桥设伏',
        participants: [{ type: 'character', name: '林澜', role: '主谋' }, { id: 'ELM-bbbbbbbbbb' }],
        plots: [{ type: 'plot', name: '夺剑' }],
        chapters: [{ chapterNumber: 1, mode: 'current' }],
        storyTime: { calendar: '苍穹历', year: 312 },
      },
    })
    const output = await timelineCreatePointTool.run(input, runtime())

    expect(output.eventId).toMatch(/^EVT-[0-9a-z]{10}$/)
    expect(output.kind).toBe('point')
    expect(output.created).toBe(true)
    expect(output.sourcePath).toBe(TIMELINE_LEDGER_PATH)
    expect(output.assignedElementIds).toHaveLength(1)
    expect(timelineCreatePointTool.extractFileChange(output)).toEqual({ type: 'created', path: TIMELINE_LEDGER_PATH })
    expect(timelineCreatePointTool.extractExtraFileChanges(output)).toEqual([
      { type: 'updated', path: 'elements/characters/林澜.md' },
    ])

    const confirmation = timelineCreatePointTool.buildConfirmation(input)!
    expect(confirmation.kind).toBe('create')
    expect(confirmation.path).toBe(TIMELINE_LEDGER_PATH)
    expect(confirmation.content).toContain('旧桥伏击')
    expect(confirmation.content).toContain('林澜（character）（主谋）')
    expect(confirmation.content).toContain('苍穹历312年')
    expect(confirmation.content).toContain('第1章（current）')
    expect(confirmation.content).toContain('列表末尾')

    // 懒分配的标识已写进要素文件
    const content = await readProjectTextFile(root, 'elements/characters/林澜.md')
    expect(content).toMatch(/^id: ELM-[0-9a-z]{10}$/m)
  })

  it('第二条：updated 变更；锚定插入定位生效', async () => {
    await seedWorld()
    const first = await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({
      event: { title: '第一件' },
    }), runtime())
    const second = await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({
      event: { title: '更早的事' },
      position: { at: 'before', anchorMarkerId: first.markerId },
    }), runtime())
    expect(second.created).toBe(false)
    expect(timelineCreatePointTool.extractFileChange(second)).toEqual({ type: 'updated', path: TIMELINE_LEDGER_PATH })

    const list = await timelineListTool.run(timelineListTool.validateInput({}), runtime())
    expect(list.events.map((event) => event.title)).toEqual(['更早的事', '第一件'])
  })

  it('校验拦截：title 缺失、位置锚缺字段、叙述方式非法', () => {
    expect(() => timelineCreatePointTool.validateInput({ event: {} })).toThrow('title 不能为空')
    expect(() => timelineCreatePointTool.validateInput({
      event: { title: 'x' },
      position: { at: 'before' },
    })).toThrow('anchorMarkerId')
    expect(() => timelineCreatePointTool.validateInput({
      event: { title: 'x', chapters: [{ chapterNumber: 1, mode: 'flashback' }] },
    })).toThrow('mode')
  })
})

describe('TimelineCreateSpan', () => {
  it('登记区间：两端跨事件、文件变更与确认预览含双位置', async () => {
    await seedWorld()
    const first = await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({
      event: { title: '起因' },
    }), runtime())

    const input = timelineCreateSpanTool.validateInput({
      event: { title: '三年修行', participants: [{ id: 'ELM-bbbbbbbbbb' }] },
      startPosition: { at: 'after', anchorMarkerId: first.markerId },
      endPosition: { at: 'last' },
    })
    const span = await timelineCreateSpanTool.run(input, runtime())
    expect(span.kind).toBe('span')
    expect(span.endMarkerId).toMatch(/^TM-[0-9a-z]{10}$/)
    expect(span.endMarkerId).not.toBe(span.markerId)

    const inner = await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({
      event: { title: '山中奇遇' },
      position: { at: 'after', anchorMarkerId: span.markerId },
    }), runtime())

    const list = await timelineListTool.run(timelineListTool.validateInput({}), runtime())
    // 区间事件在列表输出只出现一次（携带开始标记标识），中间事件可插入
    expect(list.events.map((event) => event.title)).toEqual(['起因', '三年修行', '山中奇遇'])
    expect(list.events[1]!.kind).toBe('span')

    const confirmation = timelineCreateSpanTool.buildConfirmation(input)!
    expect(confirmation.content).toContain('开始位置：标记')
    expect(confirmation.content).toContain('结束位置：列表末尾')

    // 倒置 → 领域层拒绝
    await expect(timelineCreateSpanTool.run(timelineCreateSpanTool.validateInput({
      event: { title: '倒置' },
      startPosition: { at: 'last' },
      endPosition: { at: 'after', anchorMarkerId: inner.markerId },
    }), runtime())).rejects.toThrow('结束标记必须位于开始标记之后')
  })
})

/* ---------- TimelineList / TimelineRead ---------- */

describe('TimelineList / TimelineRead', () => {
  async function seedEvents() {
    await seedWorld()
    const a = await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({
      event: {
        title: '旧桥伏击',
        storyTime: { year: 312 },
        participants: [{ type: 'character', name: '林澜' }],
        chapters: [{ chapterNumber: 1, mode: 'current' }],
      },
    }), runtime())
    const b = await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({
      event: { title: '复盘', causedBy: [a.eventId], relativeTime: { anchorEventId: a.eventId, offset: 3, unit: 'day', direction: 'after' } },
    }), runtime())
    return { a, b }
  }

  it('List 筛选：参与者 / 章号 / 年份；空账本引导语', async () => {
    const { a } = await seedEvents()

    const byParticipant = await timelineListTool.run(timelineListTool.validateInput({
      participantElementId: a.assignedElementIds[0]!.id,
    }), runtime())
    expect(byParticipant.totalCount).toBe(1)
    expect(byParticipant.events[0]!.participants[0]!.name).toBe('林澜')

    const byChapter = await timelineListTool.run(timelineListTool.validateInput({ chapterNumber: 1 }), runtime())
    expect(byChapter.totalCount).toBe(1)

    const byYear = await timelineListTool.run(timelineListTool.validateInput({ yearFrom: 313 }), runtime())
    expect(byYear.totalCount).toBe(0)
    expect(byYear.guidance).not.toContain('还没有事件')
  })

  it('Read：全量详情 + 局部上下文 + 版本令牌；notFound 分支', async () => {
    const { a, b } = await seedEvents()
    await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({ event: { title: '尾声' } }), runtime())

    const read = await timelineReadTool.run(timelineReadTool.validateInput({
      eventId: b.eventId,
      contextCount: 2,
    }), runtime())
    if ('notFound' in read) {
      throw new Error('应当命中')
    }
    expect(read.event.title).toBe('复盘')
    expect(read.event.causedBy).toEqual([a.eventId])
    expect(read.causedByTitles).toEqual(['旧桥伏击'])
    expect(read.relativeAnchorTitle).toBe('旧桥伏击')
    expect(read.neighbors.map((neighbor) => neighbor.title)).toEqual(['旧桥伏击', '复盘', '尾声'])
    expect(read.version).toBeTruthy()
    expect(read.contentHash).toBeTruthy()

    const missing = await timelineReadTool.run(timelineReadTool.validateInput({ eventId: 'EVT-0000000000' }), runtime())
    expect(missing).toMatchObject({ notFound: true })
  })
})

/* ---------- TimelineUpdate / TimelineDelete ---------- */

describe('TimelineUpdate', () => {
  it('展平字段修改：输出前后详情、确认预览列待改字段；expectedContentHash 过期 → 冲突报错', async () => {
    await seedWorld()
    const created = await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({
      event: { title: '旧桥伏击', summary: '初稿' },
    }), runtime())
    const read = await timelineReadTool.run(timelineReadTool.validateInput({ eventId: created.eventId }), runtime())
    if ('notFound' in read) {
      throw new Error('应当命中')
    }

    const input = timelineUpdateTool.validateInput({
      eventId: created.eventId,
      title: '旧桥伏击（定稿）',
      summary: '林澜设伏夺剑',
      storyTime: { year: 312 },
    })
    const output = await timelineUpdateTool.run(input, runtime())
    expect(output.event.title).toBe('旧桥伏击（定稿）')
    expect(output.previous.title).toBe('旧桥伏击')

    const confirmation = timelineUpdateTool.buildConfirmation(input)!
    expect(confirmation.kind).toBe('edit')
    expect(confirmation.newText).toContain('标题 → 旧桥伏击（定稿）')
    expect(confirmation.newText).toContain('摘要 → 林澜设伏夺剑')

    // 整本哈希过期（Read 后又发生过写入）
    await expect(timelineUpdateTool.run(timelineUpdateTool.validateInput({
      eventId: created.eventId,
      summary: '再改',
      expectedContentHash: read.contentHash!,
    }), runtime())).rejects.toThrow('版本已过期')

    // 空补丁拒绝
    expect(() => timelineUpdateTool.validateInput({ eventId: created.eventId })).toThrow('至少提供')
  })
})

describe('TimelineDelete', () => {
  it('删除区间事件：两端同删、causedBy 级联计数、相对锚失效提示与确认文案', async () => {
    await seedWorld()
    const anchor = await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({
      event: { title: '锚事件' },
    }), runtime())
    const span = await timelineCreateSpanTool.run(timelineCreateSpanTool.validateInput({
      event: { title: '长战争', causedBy: [anchor.eventId] },
      startPosition: { at: 'last' },
      endPosition: { at: 'last' },
    }), runtime())
    await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({
      event: {
        title: '战后重建',
        relativeTime: { anchorEventId: span.eventId, offset: 1, unit: 'year', direction: 'after' },
      },
    }), runtime())

    const input = timelineDeleteTool.validateInput({ eventId: span.eventId })
    const confirmation = timelineDeleteTool.buildConfirmation(input)!
    expect(confirmation.kind).toBe('delete')
    expect(confirmation.path).toBe(`${TIMELINE_LEDGER_PATH}（事件 ${span.eventId}）`)

    const output = await timelineDeleteTool.run(input, runtime())
    expect(output.title).toBe('长战争')
    expect(output.kind).toBe('span')
    expect(output.removedMarkers).toBe(2)
    expect(output.cascadedCausedBy).toBe(0) // 长战争的 causedBy 指向锚事件，删除它清的是别人对它的引用
    expect(output.anchoredEvents).toEqual([{ eventId: expect.any(String), title: '战后重建' }])

    const list = await timelineListTool.run(timelineListTool.validateInput({}), runtime())
    expect(list.events.map((event) => event.title)).toEqual(['锚事件', '战后重建'])
  })

  it('删除点事件：清空他事件指向它的因果引用', async () => {
    await seedWorld()
    const a = await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({ event: { title: 'a' } }), runtime())
    await timelineCreatePointTool.run(timelineCreatePointTool.validateInput({
      event: { title: 'b', causedBy: [a.eventId] },
    }), runtime())

    const output = await timelineDeleteTool.run(timelineDeleteTool.validateInput({ eventId: a.eventId }), runtime())
    expect(output.kind).toBe('point')
    expect(output.removedMarkers).toBe(1)
    expect(output.cascadedCausedBy).toBe(1)
    expect(output.anchoredEvents).toEqual([])
  })
})
