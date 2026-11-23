import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pickProjectDirectory } from '../core/fs/project-fs'
import { writeAgentLog } from '../core/logging/agent-log'
import {
  forgetRecentProject,
  hasProjectPermission,
  readLastProject,
  readRecentProject,
  requestProjectPermission,
  saveLastProject,
} from '../core/project/recent-projects'
import type { LastProjectRecord } from '../core/project/recent-projects'
import { ProjectPermissionRequiredError } from '../types/project'
import type { ProjectLoadProgress, ProjectLoadReporter } from '../types/project'

import {
  createProject,
  deleteRecentProject,
  openProject,
  restoreLastProject,
  restoreRecentProject,
} from './project-service'

vi.mock('../core/fs/project-fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/fs/project-fs')>()
  return { ...actual, pickProjectDirectory: vi.fn() }
})

vi.mock('../core/project/recent-projects', () => ({
  forgetLastProject: vi.fn(async () => undefined),
  forgetRecentProject: vi.fn(async () => undefined),
  hasProjectPermission: vi.fn(async () => true),
  readLastProject: vi.fn(async () => null),
  readRecentProject: vi.fn(async () => null),
  readRecentProjects: vi.fn(async () => []),
  requestProjectPermission: vi.fn(async () => true),
  saveLastProject: vi.fn(async () => undefined),
  toLastProjectSummary: vi.fn(),
  updateRecentProjectCounts: vi.fn(async () => undefined),
}))

vi.mock('../core/logging/agent-log', () => ({
  writeAgentLog: vi.fn(async () => undefined),
}))

vi.mock('../core/agent/spill', () => ({
  sweepExpiredSpillFiles: vi.fn(async () => undefined),
}))

vi.mock('./agent-service', () => ({
  evictProjectSessions: vi.fn(),
}))

vi.mock('./environment-service', () => ({
  inspectBrowserEnvironment: vi.fn(() => ({
    usable: true,
    blocker: null,
    blockerMessage: '',
    userAgent: 'test',
  })),
}))

/* ---------- 内存文件系统（与其他服务测试同款内联实现，补 remove） ---------- */

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

/** 手机版 Chrome 模式：一次性递归删除非空目录直接报类型不匹配错误。 */
let phoneStyle = false

/** 目录句柄 `remove()` 的每次调用参数（断言桌面只删一次）。 */
let removeCalls: unknown[][] = []

function createDirectoryHandle(
  entry: MemoryDirectoryEntry,
  parent: MemoryDirectoryEntry | null = null,
): MemoryDirectoryHandle {
  return {
    kind: 'directory',
    name: entry.name,
    __entry: entry,
    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'directory') {
        return createDirectoryHandle(current, entry)
      }
      if (current) {
        throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      }
      if (!options?.create) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
      const next: MemoryDirectoryEntry = { kind: 'directory', name, entries: new Map() }
      entry.entries.set(name, next)
      return createDirectoryHandle(next, entry)
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
    async removeEntry(name: string, options?: FileSystemRemoveOptions) {
      const current = entry.entries.get(name)
      if (!current) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
      if (current.kind === 'directory' && current.entries.size > 0) {
        if (!options?.recursive) {
          throw new DOMException('Directory not empty', 'InvalidModificationError')
        }
        if (phoneStyle) {
          throw new DOMException('Type mismatch', 'TypeMismatchError')
        }
      }
      entry.entries.delete(name)
    },
    async remove(options?: FileSystemRemoveOptions) {
      removeCalls.push([options])
      if (!parent || parent.entries.get(entry.name) !== entry) {
        throw new DOMException(`Not found: ${entry.name}`, 'NotFoundError')
      }
      if (entry.entries.size > 0) {
        if (!options?.recursive) {
          throw new DOMException('Directory not empty', 'InvalidModificationError')
        }
        if (phoneStyle) {
          throw new DOMException('Type mismatch', 'TypeMismatchError')
        }
      }
      parent.entries.delete(entry.name)
    },
    async *values() {
      for (const child of entry.entries.values()) {
        yield child.kind === 'directory' ? createDirectoryHandle(child, entry) : createFileHandle(child)
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
        async write(data: FileSystemWriteChunkType) {
          nextContent = typeof data === 'string' ? data : String(data)
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as FileSystemFileHandle
}

/* ---------- 测试基建 ---------- */

let home: MemoryDirectoryHandle
let root: MemoryDirectoryHandle
let record: LastProjectRecord

/** 进度事件与关键副作用的先后顺序日志。 */
let order: string[]

function seedFile(path: string, content: string) {
  const segments = path.split('/')
  const fileName = segments.pop() as string
  let current = root.__entry
  for (const segment of segments) {
    const existing = current.entries.get(segment)
    if (existing?.kind === 'file') {
      throw new Error(`路径中段不是目录：${path}`)
    }
    if (existing) {
      current = existing
      continue
    }
    const created: MemoryDirectoryEntry = { kind: 'directory', name: segment, entries: new Map() }
    current.entries.set(segment, created)
    current = created
  }
  current.entries.set(fileName, { kind: 'file', name: fileName, content, lastModified: Date.now() })
}

/** 可直接打开的最小项目：配置、清单、系统提示词，外加一章正文。 */
function seedProject() {
  seedFile('novel.config.json', JSON.stringify({
    project: { name: '第一本小说', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  }))
  seedFile('.novel/manifest.json', JSON.stringify({
    projectId: 'test-project',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
  }))
  seedFile('prompts/system.md', '# System Prompt')
  seedFile('chapters/chapter-001.md', '# 第一章')
}

function label(event: ProjectLoadProgress) {
  const detail = event.current === undefined ? '' : `:${event.current}`
  return `${event.phase}${detail}`
}

/** 执行动作并收集进度事件，同时把关键副作用记进顺序日志。 */
async function collect<T>(run: (onProgress: ProjectLoadReporter) => Promise<T>) {
  const events: ProjectLoadProgress[] = []
  const result = await run((event) => {
    events.push(event)
    order.push(label(event))
  })
  return { events, result }
}

/** `[from, from + 1, …, to]`。 */
function countUp(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index)
}

type FileNode = { kind: 'file' | 'directory'; children?: FileNode[] }

function countNodes(nodes: FileNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.children ? countNodes(node.children) : 0), 0)
}

/** 各段结构步骤上报的路径（与 `project-fs.test.ts` 的断言同源）。 */
const DIRECTORY_PATHS = [
  'chapters',
  'elements',
  'elements/characters',
  'elements/locations',
  'elements/entities',
  'elements/plots',
  'elements/worldbuilding',
  'prompts',
  'prompts/outlines',
  'plans',
  '.novel',
  '.novel/logs',
]
const INSPECT_PATHS = [
  'novel.config.json',
  'novel.config.json',
  '.novel/manifest.json',
  '.novel/manifest.json',
  'prompts/system.md',
  'prompts/outlines',
  'chapters',
  'elements',
  '.novel',
]
const REPAIR_PATHS = [
  ...DIRECTORY_PATHS,
  'novel.config.json',
  '.novel/manifest.json',
  'prompts/system.md',
  'prompts/NovAI.md',
  'prompts/ELEMENT.md',
]
const CREATE_PATHS = [
  ...DIRECTORY_PATHS,
  'novel.config.json',
  '.novel/manifest.json',
  'prompts/system.md',
  'prompts/outlines/outline-001.md',
  'prompts/NovAI.md',
  'prompts/ELEMENT.md',
]
const LOAD_PATHS = ['prompts/scenes', 'novel.config.json', '.novel/manifest.json']

const ACTIVATE_EVENTS: ProjectLoadProgress[] = [
  { phase: 'activate', current: 1, total: 2 },
  { phase: 'activate', current: 2, total: 2, projectName: '第一本小说' },
]

beforeEach(async () => {
  home = createDirectoryHandle({ kind: 'directory', name: 'home', entries: new Map() })
  root = await home.getDirectoryHandle('novel', { create: true }) as MemoryDirectoryHandle
  record = {
    key: 'last-opened',
    projectId: 'test-project',
    name: '第一本小说',
    rootName: 'novel',
    lastOpenedAt: '2026-11-23T00:00:00.000Z',
    handle: root,
    chapterCount: 0,
    elementCount: 0,
  }
  order = []
  phoneStyle = false
  removeCalls = []
  vi.clearAllMocks()
  vi.mocked(hasProjectPermission).mockResolvedValue(true)
  vi.mocked(requestProjectPermission).mockResolvedValue(true)
  vi.mocked(readLastProject).mockResolvedValue(record)
  vi.mocked(readRecentProject).mockResolvedValue({ ...record, key: 'project-test-project' })
  vi.mocked(saveLastProject).mockImplementation(async () => {
    order.push('saveLastProject')
    return record
  })
  vi.mocked(writeAgentLog).mockImplementation(async () => {
    order.push('writeAgentLog')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openProject', () => {
  it('打开项目：等待授权 → 结构 0..29（体检 9 + 修复 17 + 读取 3）→ 扫描 → 即将完成两步', async () => {
    seedProject()
    vi.mocked(pickProjectDirectory).mockResolvedValue(root)

    const { events, result } = await collect((onProgress) => openProject({ onProgress }))

    expect(events[0]).toEqual({ phase: 'permission' })
    const structure = events.filter((event) => event.phase === 'structure')
    expect(structure.map((event) => event.current)).toEqual(countUp(0, 29))
    expect(structure.every((event) => event.total === 29)).toBe(true)
    expect(structure.slice(1).map((event) => event.currentPath)).toEqual([
      ...INSPECT_PATHS,
      ...REPAIR_PATHS,
      ...LOAD_PATHS,
    ])

    // 结构阶段之后才是扫描（中间只隔一条开头的「等待授权」），扫描计数最终与文件树的节点数一致
    expect(events.findIndex((event) => event.phase === 'scan')).toBe(structure.length + 1)
    const lastScan = events.filter((event) => event.phase === 'scan').at(-1)
    expect((lastScan?.files ?? 0) + (lastScan?.directories ?? 0)).toBe(countNodes(result.files))

    expect(events.filter((event) => event.phase === 'activate')).toEqual(ACTIVATE_EVENTS)
    // 先后关系：保存记录 → 即将完成 1/2 → 写日志 → 即将完成 2/2
    expect(order.slice(-4)).toEqual(['saveLastProject', 'activate:1', 'writeAgentLog', 'activate:2'])
    expect(result.name).toBe('第一本小说')
  })

  it('不传回调时照常打开', async () => {
    seedProject()
    vi.mocked(pickProjectDirectory).mockResolvedValue(root)

    await expect(openProject()).resolves.toMatchObject({ name: '第一本小说' })
  })
})

describe('restoreLastProject', () => {
  it('恢复上次项目：等待授权 → 结构 0..20（修复 17 + 读取 3）→ 扫描 → 即将完成两步', async () => {
    seedProject()

    const { events, result } = await collect((onProgress) => restoreLastProject({ onProgress }))

    expect(events[0]).toEqual({ phase: 'permission' })
    const structure = events.filter((event) => event.phase === 'structure')
    expect(structure.map((event) => event.current)).toEqual(countUp(0, 20))
    expect(structure.every((event) => event.total === 20)).toBe(true)
    expect(structure.slice(1).map((event) => event.currentPath)).toEqual([...REPAIR_PATHS, ...LOAD_PATHS])
    expect(events.findIndex((event) => event.phase === 'scan')).toBe(structure.length + 1)
    expect(events.filter((event) => event.phase === 'activate')).toEqual(ACTIVATE_EVENTS)
    expect(result?.name).toBe('第一本小说')
  })

  it('没有记录：返回 null，不报进度、不请求权限', async () => {
    vi.mocked(readLastProject).mockResolvedValue(null)

    const { events, result } = await collect((onProgress) => restoreLastProject({ onProgress }))

    expect(result).toBeNull()
    expect(events).toEqual([])
    expect(hasProjectPermission).not.toHaveBeenCalled()
    expect(requestProjectPermission).not.toHaveBeenCalled()
  })

  it('未获授权（浏览器冷启动后的自动恢复）：抛类型化错误，不修复结构、不写记录', async () => {
    seedFile('chapters/chapter-001.md', '# 第一章')
    vi.mocked(hasProjectPermission).mockResolvedValue(false)
    vi.mocked(requestProjectPermission).mockResolvedValue(false)

    const events: ProjectLoadProgress[] = []
    const attempt = restoreLastProject({ onProgress: (event) => events.push(event) })

    await expect(attempt).rejects.toBeInstanceOf(ProjectPermissionRequiredError)
    await expect(attempt).rejects.toMatchObject({ projectName: '第一本小说' })
    expect(events).toEqual([{ phase: 'permission' }])
    // 目录原样：缺失的必需目录没有被补建
    expect([...root.__entry.entries.keys()]).toEqual(['chapters'])
    expect(saveLastProject).not.toHaveBeenCalled()
    expect(writeAgentLog).not.toHaveBeenCalled()
  })
})

describe('restoreRecentProject', () => {
  it('打开最近项目：等待授权 → 结构 0..20 → 扫描 → 即将完成两步', async () => {
    seedProject()

    const { events, result } = await collect((onProgress) =>
      restoreRecentProject('test-project', { onProgress }))

    expect(events[0]).toEqual({ phase: 'permission' })
    const structure = events.filter((event) => event.phase === 'structure')
    expect(structure.map((event) => event.current)).toEqual(countUp(0, 20))
    expect(structure.slice(1).map((event) => event.currentPath)).toEqual([...REPAIR_PATHS, ...LOAD_PATHS])
    expect(events.filter((event) => event.phase === 'activate')).toEqual(ACTIVATE_EVENTS)
    expect(result?.name).toBe('第一本小说')
  })

  it('没有记录：返回 null，不报进度', async () => {
    vi.mocked(readRecentProject).mockResolvedValue(null)

    const { events, result } = await collect((onProgress) =>
      restoreRecentProject('test-project', { onProgress }))

    expect(result).toBeNull()
    expect(events).toEqual([])
  })

  it('未获授权：抛带项目名的类型化错误，只报过等待授权', async () => {
    seedFile('chapters/chapter-001.md', '# 第一章')
    vi.mocked(hasProjectPermission).mockResolvedValue(false)
    vi.mocked(requestProjectPermission).mockResolvedValue(false)

    const events: ProjectLoadProgress[] = []
    const attempt = restoreRecentProject('test-project', { onProgress: (event) => events.push(event) })

    await expect(attempt).rejects.toMatchObject({
      name: 'ProjectPermissionRequiredError',
      projectName: '第一本小说',
    })
    expect(events).toEqual([{ phase: 'permission' }])
    expect([...root.__entry.entries.keys()]).toEqual(['chapters'])
  })
})

describe('createProject', () => {
  it('新建项目：等待授权 → 结构 0..21（创建 18 + 读取 3）→ 扫描 → 即将完成两步', async () => {
    const books = createDirectoryHandle({ kind: 'directory', name: 'books', entries: new Map() })
    vi.stubGlobal('window', { showDirectoryPicker: vi.fn(async () => books) })

    const { events, result } = await collect((onProgress) => createProject('我的小说', { onProgress }))

    expect(events[0]).toEqual({ phase: 'permission' })
    const structure = events.filter((event) => event.phase === 'structure')
    expect(structure.map((event) => event.current)).toEqual(countUp(0, 21))
    expect(structure.every((event) => event.total === 21)).toBe(true)
    expect(structure.slice(1, 19).map((event) => event.currentPath)).toEqual(CREATE_PATHS)
    expect(structure.slice(19).map((event) => event.currentPath)).toEqual(LOAD_PATHS)
    expect(events.findIndex((event) => event.phase === 'scan')).toBe(structure.length + 1)
    expect(events.filter((event) => event.phase === 'activate').at(-1)).toMatchObject({
      projectName: '我的小说',
    })
    expect(result.name).toBe('我的小说')
    expect([...books.__entry.entries.keys()]).toEqual(['我的小说'])
  })
})

describe('deleteRecentProject（同步删除本地目录）', () => {
  it('未获授权：取消删除，目录与记录都原样保留', async () => {
    seedProject()
    vi.mocked(hasProjectPermission).mockResolvedValue(false)
    vi.mocked(requestProjectPermission).mockResolvedValue(false)

    await expect(deleteRecentProject('test-project', { deleteDirectory: true }))
      .rejects.toThrow('没有获得项目目录读写权限')

    expect(root.__entry.entries.has('chapters')).toBe(true)
    expect(forgetRecentProject).not.toHaveBeenCalled()
  })

  it('桌面：一次性递归删除，再忘记记录', async () => {
    seedProject()

    await deleteRecentProject('test-project', { deleteDirectory: true })

    expect(removeCalls).toEqual([[{ recursive: true }]])
    expect(home.__entry.entries.has('novel')).toBe(false)
    expect(forgetRecentProject).toHaveBeenCalledWith('test-project')
  })

  it('手机版 Chrome（递归删除报类型不匹配）：逐项清空后删除，再忘记记录', async () => {
    seedProject()
    phoneStyle = true

    await deleteRecentProject('test-project', { deleteDirectory: true })

    // 递归失败一次 → 清空 → 不带参数再删一次
    expect(removeCalls).toEqual([[{ recursive: true }], [undefined]])
    expect(home.__entry.entries.has('novel')).toBe(false)
    expect(forgetRecentProject).toHaveBeenCalledWith('test-project')
  })

  it('浏览器没有删除能力：报既有提示，不动任何文件', async () => {
    seedProject()
    const withoutRemove = createDirectoryHandle(root.__entry)
    delete (withoutRemove as { remove?: unknown }).remove
    vi.mocked(readRecentProject).mockResolvedValue({
      ...record,
      key: 'project-test-project',
      handle: withoutRemove,
    })

    await expect(deleteRecentProject('test-project', { deleteDirectory: true }))
      .rejects.toThrow('当前浏览器不支持直接删除已记住的项目目录')

    expect(root.__entry.entries.has('chapters')).toBe(true)
    expect(forgetRecentProject).not.toHaveBeenCalled()
  })

  it('只忘记记录（不删目录）：不碰目录、不请求权限', async () => {
    seedProject()

    await deleteRecentProject('test-project')

    expect(hasProjectPermission).not.toHaveBeenCalled()
    expect(root.__entry.entries.has('chapters')).toBe(true)
    expect(forgetRecentProject).toHaveBeenCalledWith('test-project')
  })
})
