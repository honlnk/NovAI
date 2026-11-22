import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createPlanTool,
  deletePlanTool,
  listPlansTool,
  readPlanTool,
  updatePlanTool,
} from './plan-tools'
import { executeCoreTool, getCoreTools } from './index'
import { writeProjectTextFile, readProjectTextFile, removeProjectFile } from '../fs/project-fs'
import { readFileTool } from './file-tools/read-file'
import { decideWriteToolPermission } from '../agent/permission'
import { createElementManagerTools } from '../agent/element-manager'
import { isAgentToolName } from '../agent/tools'
import type { ProjectSnapshot } from '../../types/project'
import type { PermissionPreset } from '../../types/project'
import type { ToolRuntime } from './types'

/* ---------- 内存文件系统 ---------- */

type MemoryFileEntry = { kind: 'file'; name: string; content: string; lastModified: number }
type MemoryDirectoryEntry = { kind: 'directory'; name: string; entries: Map<string, MemoryEntry> }
type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry

function createDirectoryHandle(entry: MemoryDirectoryEntry): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: entry.name,
    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'directory') return createDirectoryHandle(current)
      if (current) throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const next: MemoryDirectoryEntry = { kind: 'directory', name, entries: new Map() }
      entry.entries.set(name, next)
      return createDirectoryHandle(next)
    },
    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'file') return createFileHandle(current)
      if (current) throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const next: MemoryFileEntry = { kind: 'file', name, content: '', lastModified: Date.now() }
      entry.entries.set(name, next)
      return createFileHandle(next)
    },
    async removeEntry(name: string) {
      if (!entry.entries.delete(name)) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
    },
    async *values() {
      for (const child of entry.entries.values()) {
        yield child.kind === 'directory' ? createDirectoryHandle(child) : createFileHandle(child)
      }
    },
  } as unknown as FileSystemDirectoryHandle
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
          nextContent = typeof data === 'string' ? data : data instanceof Blob ? await data.text() : String(data)
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as unknown as FileSystemFileHandle
}

let rootHandle: FileSystemDirectoryHandle

const runtime = (): ToolRuntime => ({ project: fakeProject() })

function fakeProject(): ProjectSnapshot {
  return {
    id: 'proj-plans',
    name: '计划工具测试项目',
    rootName: 'test',
    handle: rootHandle,
    config: {} as ProjectSnapshot['config'],
    manifest: {} as ProjectSnapshot['manifest'],
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  }
}

beforeEach(() => {
  rootHandle = createDirectoryHandle({ kind: 'directory', name: 'test-novel', entries: new Map() })
})

/* ---------- 工具行为 ---------- */

describe('ListPlans / ReadPlan', () => {
  it('ListPlans 返回摘要不返回全文；可按状态筛选', async () => {
    const created1 = await createPlanTool.run({ body: '# 伏笔A\n\n详细正文' }, runtime())
    const created2 = await createPlanTool.run({ body: '# 伏笔B', status: 'planned' }, runtime())

    const all = await listPlansTool.run({}, runtime())
    const planned = await listPlansTool.run({ status: 'planned' }, runtime())

    expect(all.totalCount).toBe(2)
    expect(all.plans.find((p) => p.id === created1.id)).toMatchObject({ title: '伏笔A', status: 'inbox' })
    expect(all.plans.every((p) => !('body' in p))).toBe(true)
    expect(planned.plans.map((p) => p.id)).toEqual([created2.id])

    // 摘要来自正文首行，不含全文
    expect(all.plans.find((p) => p.id === created1.id)?.summary).toBe('# 伏笔A')
  })

  it('ReadPlan 按标识读全文与 contentHash；不存在返回 notFound 不抛错', async () => {
    const created = await createPlanTool.run({ body: '正文内容' }, runtime())

    const read = await readPlanTool.run({ id: created.id }, runtime())
    expect(read).toMatchObject({ id: created.id, body: '正文内容', sourcePath: created.sourcePath })
    expect('contentHash' in read && read.contentHash).toBeTruthy()

    const missing = await readPlanTool.run({ id: 'plan-none' }, runtime())
    expect(missing).toEqual({ id: 'plan-none', notFound: true })
  })

  it('ListPlans 非法状态被校验拒绝', () => {
    expect(() => listPlansTool.validateInput({ status: 'someday' })).toThrow(/ListPlans\.status/)
  })
})

describe('CreatePlan', () => {
  it('创建：默认收集箱、返回完整内容供账本 diff；extractFileChange 为 created', async () => {
    const input = createPlanTool.validateInput({ body: '  # 新想法\n\n正文  ' })
    const output = await createPlanTool.run(input, runtime())

    expect(input.body).toBe('# 新想法\n\n正文')
    expect(output.status).toBe('inbox')
    expect(output.created).toBe(true)
    expect(output.content).toContain('---\nid: ')
    expect(createPlanTool.extractFileChange?.(output)).toEqual({ type: 'created', path: output.sourcePath })
    expect(createPlanTool.extractChangeDiff?.(output)?.oldText).toBe('')

    // 文件真实落盘（普通文件工具读到同一份内容）
    const raw = await readProjectTextFile(rootHandle, output.sourcePath)
    expect(raw).toBe(output.content)
  })

  it('空正文被校验拒绝', () => {
    expect(() => createPlanTool.validateInput({ body: '   ' })).toThrow('计划正文不能为空')
    expect(() => createPlanTool.validateInput({})).toThrow(/CreatePlan\.body/)
  })

  it('确认预览：kind create + 正文', () => {
    const confirmation = createPlanTool.buildConfirmation({ body: '正文' })
    expect(confirmation).toEqual({ kind: 'create', path: 'plans/（新卡片，执行时生成文件名）', content: '正文' })
  })
})

describe('UpdatePlan', () => {
  it('改正文必须先读（强制 expectedContentHash），校验层拒绝无版本替换', async () => {
    const created = await createPlanTool.run({ body: '原始' }, runtime())

    expect(() => updatePlanTool.validateInput({ id: created.id, body: '新正文' }))
      .toThrow('必须先用 ReadPlan')

    const read = await readPlanTool.run({ id: created.id }, runtime())
    const validated = updatePlanTool.validateInput({
      id: created.id,
      body: '新正文',
      expectedContentHash: 'contentHash' in read ? read.contentHash : '',
    })
    const output = await updatePlanTool.run(validated, runtime())

    expect(output.title).toBe('新正文')
    expect(updatePlanTool.extractFileChange?.(output)).toEqual({ type: 'updated', path: output.sourcePath })
  })

  it('只改状态不传正文：原正文保持；hash 过期时拒绝覆盖', async () => {
    const created = await createPlanTool.run({ body: '原正文' }, runtime())
    const read = await readPlanTool.run({ id: created.id }, runtime())
    const hash = 'contentHash' in read ? read.contentHash : ''

    // 外部修改后用旧 hash 替换正文 → 冲突
    const raw = await readProjectTextFile(rootHandle, created.sourcePath)
    await writeProjectTextFile(rootHandle, created.sourcePath, raw.replace('原正文', '外部正文'))

    await expect(
      updatePlanTool.run({ id: created.id, body: '我的正文', expectedContentHash: hash }, runtime()),
    ).rejects.toThrow(/已被外部修改/)

    // 只改状态（不带 hash）不受影响，且保留外部正文
    const updated = await updatePlanTool.run({ id: created.id, status: 'done' }, runtime())
    expect(updated.status).toBe('done')
    expect(updated.content).toContain('外部正文')
  })

  it('什么都不传被拒绝；afterId 位置参数通过校验', () => {
    expect(() => updatePlanTool.validateInput({ id: 'p1' })).toThrow('至少提供')
    const validated = updatePlanTool.validateInput({ id: 'p1', status: 'planned', afterId: 'p0' })
    expect(validated).toEqual({ id: 'p1', body: undefined, status: 'planned', afterId: 'p0', expectedContentHash: undefined })
  })
})

describe('DeletePlan', () => {
  it('删除进回收站；extractFileChange 带 trashPath 与行数', async () => {
    const created = await createPlanTool.run({ body: '# 待删\n\n三行\n正文' }, runtime())

    const output = await deletePlanTool.run({ id: created.id }, runtime())

    expect(output.trashPath).toMatch(/^\.novel\/trash\//)
    const change = deletePlanTool.extractFileChange?.(output)
    expect(change).toMatchObject({ type: 'deleted', path: created.sourcePath, trashPath: output.trashPath })
    expect(change && 'linesRemoved' in change && change.linesRemoved).toBeGreaterThan(0)

    // 原位置已删除
    await expect(readProjectTextFile(rootHandle, created.sourcePath)).rejects.toThrow()
  })

  it('删除不存在的计划报错', async () => {
    await expect(deletePlanTool.run({ id: 'plan-none' }, runtime())).rejects.toThrow('计划不存在')
  })
})

/* ---------- 权限档位 ---------- */

function makeProject(preset: PermissionPreset): ProjectSnapshot {
  return {
    handle: {},
    config: { settings: { permissionPreset: preset } },
  } as unknown as ProjectSnapshot
}

describe('计划工具权限档位', () => {
  const updateInput = { id: 'plan-1', body: '新正文' }

  it('UpdatePlan：素材/章节与素材/完全访问 免确认；仅审阅/章节内容 需确认', () => {
    expect(decideWriteToolPermission('UpdatePlan', updateInput, makeProject('material'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('UpdatePlan', updateInput, makeProject('chapter-material'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('UpdatePlan', updateInput, makeProject('full'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('UpdatePlan', updateInput, makeProject('review')).kind).toBe('ask')
    expect(decideWriteToolPermission('UpdatePlan', updateInput, makeProject('chapter')).kind).toBe('ask')
  })

  it('CreatePlan/DeletePlan：结构操作，除完全访问外都需确认', () => {
    for (const tool of ['CreatePlan', 'DeletePlan'] as const) {
      expect(decideWriteToolPermission(tool, { body: '正文' }, makeProject('full'))).toEqual({ kind: 'allow' })
      for (const preset of ['review', 'chapter', 'material', 'chapter-material'] as const) {
        expect(decideWriteToolPermission(tool, { body: '正文' }, makeProject(preset)).kind).toBe('ask')
      }
    }
  })

  it('通用 EditFile 改 plans/ 文件：素材档放行（归入素材类内容）', () => {
    const input = { path: 'plans/计划-1-ab12cd34.md', oldText: 'a', newText: 'b' }
    expect(decideWriteToolPermission('EditFile', input, makeProject('material'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('EditFile', input, makeProject('chapter-material'))).toEqual({ kind: 'allow' })
    expect(decideWriteToolPermission('EditFile', input, makeProject('chapter')).kind).toBe('ask')
    expect(decideWriteToolPermission('EditFile', input, makeProject('review')).kind).toBe('ask')
  })

  it('通用 CreateFile 在 plans/ 下：结构操作，除完全访问外都确认', () => {
    const input = { path: 'plans/手写.md', content: 'x' }
    expect(decideWriteToolPermission('CreateFile', input, makeProject('material')).kind).toBe('ask')
    expect(decideWriteToolPermission('CreateFile', input, makeProject('full'))).toEqual({ kind: 'allow' })
  })
})

/* ---------- 注册面与要素管理员白名单 ---------- */

describe('工具注册面', () => {
  it('五个计划工具进 core 注册表与 Agent 工具名联合', () => {
    const tools = getCoreTools()
    expect(tools.ListPlans).toBe(listPlansTool)
    expect(tools.ReadPlan).toBe(readPlanTool)
    expect(tools.CreatePlan).toBe(createPlanTool)
    expect(tools.UpdatePlan).toBe(updatePlanTool)
    expect(tools.DeletePlan).toBe(deletePlanTool)

    for (const name of ['ListPlans', 'ReadPlan', 'CreatePlan', 'UpdatePlan', 'DeletePlan']) {
      expect(isAgentToolName(name)).toBe(true)
    }
  })

  it('要素管理员工具白名单不含计划工具（偏离要素维护职责）', () => {
    const tools = createElementManagerTools()
    expect(tools.ListPlans).toBeUndefined()
    expect(tools.ReadPlan).toBeUndefined()
    expect(tools.CreatePlan).toBeUndefined()
    expect(tools.UpdatePlan).toBeUndefined()
    expect(tools.DeletePlan).toBeUndefined()
  })
})

/* ---------- 专用工具与通用文件工具操作同一份文件 ---------- */

describe('普通文件工具与计划工具的一致性', () => {
  it('EditFile 改计划文件后 ReadPlan 能读到修改；CreatePlan 的文件 ReadFile 能读', async () => {
    // 专用工具创建
    const created = await createPlanTool.run({ body: '# 一致性\n\n原始正文' }, runtime())

    // 通用工具读取（普通文件工具视角）
    const readViaFileTool = await readFileTool.run({
      path: created.sourcePath,
    }, runtime())
    expect(readViaFileTool.content).toContain('原始正文')

    // 通用工具直接编辑计划文件（普通文件工具仍可读写计划文件）
    await writeProjectTextFile(rootHandle, created.sourcePath, readViaFileTool.content.replace('原始正文', '通用工具改的正文'))

    // 专用工具读到同一份最新内容
    const read = await readPlanTool.run({ id: created.id }, runtime())
    expect('body' in read && read.body).toContain('通用工具改的正文')
  })

  it('外部删除计划文件后 ReadPlan 返回 notFound（不残留幽灵卡片）', async () => {
    const created = await createPlanTool.run({ body: 'x' }, runtime())
    await removeProjectFile(rootHandle, created.sourcePath)

    const read = await readPlanTool.run({ id: created.id }, runtime())
    expect(read).toEqual({ id: created.id, notFound: true })
  })
})

/* ---------- executeCoreTool 集成（validate → run → result 链） ---------- */

describe('executeCoreTool 集成', () => {
  it('CreatePlan 全链路成功（ok: true + 摘要）', async () => {
    const execution = await executeCoreTool('CreatePlan', { body: '# 集成\n\n链路' }, runtime())
    expect(execution.result.ok).toBe(true)
    expect(execution.result.summary).toContain('已新建计划')
  })

  it('CreatePlan 空正文全链路失败（ok: false + 错误信息）', async () => {
    const execution = await executeCoreTool('CreatePlan', { body: '' }, runtime())
    expect(execution.result.ok).toBe(false)
    expect(execution.result.error).toContain('正文不能为空')
  })
})
