import { beforeEach, describe, expect, it } from 'vitest'

import { scanPlanCards } from './catalog'
import { parsePlanFile } from './parser'
import { createPlanCard, deletePlanCard, readPlanCard, updatePlanCard } from './store'
import { hashContent } from '../util/hash'
import { PlanConflictError, PlanError } from '../../types/plans'
import type { PlanStatus } from '../../types/plans'

import { writeProjectTextFile } from '../fs/project-fs'

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

function createMemoryDirectory(name: string): MemoryDirectoryHandle {
  return createDirectoryHandle({
    kind: 'directory',
    name,
    entries: new Map(),
  })
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

/* ---------- 测试脚手架 ---------- */

let root: MemoryDirectoryHandle

const project = () => ({ handle: root as FileSystemDirectoryHandle })

beforeEach(() => {
  root = createMemoryDirectory('test-novel')
})

/** 直接往内存 FS 种一个计划文件（模拟外部编辑器或旧数据）。字段全缺时写纯正文（无 frontmatter）。 */
async function seedPlanFile(path: string, card: { id?: string; status?: string; order?: number; createdAt?: string; updatedAt?: string }, body: string) {
  const lines = ['---']
  if (card.id !== undefined) lines.push(`id: ${card.id}`)
  if (card.status !== undefined) lines.push(`status: ${card.status}`)
  if (card.order !== undefined) lines.push(`order: ${card.order}`)
  if (card.createdAt !== undefined) lines.push(`createdAt: ${card.createdAt}`)
  if (card.updatedAt !== undefined) lines.push(`updatedAt: ${card.updatedAt}`)
  lines.push('---', '', body, '')

  const content = card.id === undefined && card.status === undefined && card.order === undefined && card.createdAt === undefined && card.updatedAt === undefined
    ? `${body}\n`
    : lines.join('\n')

  await writeProjectTextFile(root as FileSystemDirectoryHandle, path, content)
}

async function readRaw(path: string): Promise<string> {
  const { readProjectTextFile } = await import('../fs/project-fs')
  return readProjectTextFile(root as FileSystemDirectoryHandle, path)
}

/* ---------- 扫描 ---------- */

describe('scanPlanCards', () => {
  it('旧项目无 plans 目录：返回空结果，不报错', async () => {
    const scan = await scanPlanCards(project())
    expect(scan.cards).toEqual([])
    expect(scan.issues).toEqual([])
  })

  it('目录为空：空结果', async () => {
    await writeProjectTextFile(root as FileSystemDirectoryHandle, 'plans/.keep', '')
    const scan = await scanPlanCards(project())
    expect(scan.cards).toEqual([])
  })

  it('缺元数据的文件仍展示：默认收集箱', async () => {
    await seedPlanFile('plans/随手记.md', {}, '外部编辑器建的想法')
    const scan = await scanPlanCards(project())

    expect(scan.cards).toHaveLength(1)
    expect(scan.cards[0]?.status).toBe('inbox')
    expect(scan.cards[0]?.body).toBe('外部编辑器建的想法')
    // 兜底标识稳定（同内容重复扫描一致）
    const again = await scanPlanCards(project())
    expect(again.cards[0]?.id).toBe(scan.cards[0]?.id)
  })

  it('外部新增文件重新扫描即可见；只读扫描不改写文件', async () => {
    await seedPlanFile('plans/计划-1-aaaa1111.md', { id: 'plan-1-a', status: 'planned', order: 0 }, '# A')
    const before = await readRaw('plans/计划-1-aaaa1111.md')

    await seedPlanFile('plans/计划-2-bbbb2222.md', { id: 'plan-2-b', status: 'done', order: 0 }, '# B')
    const scan = await scanPlanCards(project())

    expect(scan.cards.map((c) => c.id)).toEqual(['plan-1-a', 'plan-2-b'])
    // 只读扫描未改写旧文件
    expect(await readRaw('plans/计划-1-aaaa1111.md')).toBe(before)
  })

  it('重复稳定标识：两卡都保留展示并报告，不静默合并', async () => {
    await seedPlanFile('plans/计划-1-aaaa1111.md', { id: 'plan-dup', status: 'inbox', order: 0 }, '# 第一张')
    await seedPlanFile('plans/计划-2-bbbb2222.md', { id: 'plan-dup', status: 'planned', order: 0 }, '# 第二张')

    const scan = await scanPlanCards(project())

    expect(scan.cards).toHaveLength(2)
    expect(scan.issues).toEqual([
      {
        kind: 'duplicate-id',
        id: 'plan-dup',
        paths: ['plans/计划-1-aaaa1111.md', 'plans/计划-2-bbbb2222.md'],
      },
    ])
  })

  it('子目录与其他后缀不收集', async () => {
    await seedPlanFile('plans/sub/nested.md', { id: 'plan-n' }, '嵌套')
    await writeProjectTextFile(root as FileSystemDirectoryHandle, 'plans/notes.txt', '文本')
    const scan = await scanPlanCards(project())
    expect(scan.cards).toEqual([])
  })

  it('非法状态在展示时回退为收集箱；非法时间不影响正文读取', async () => {
    await seedPlanFile('plans/计划-1-aaaa1111.md', { id: 'plan-bad', status: 'someday', createdAt: '不是时间', updatedAt: '也不是时间' }, '# 正文还在')
    const scan = await scanPlanCards(project())

    expect(scan.cards[0]?.status).toBe('inbox')
    expect(scan.cards[0]?.body).toBe('# 正文还在')
    expect(scan.cards[0]?.title).toBe('正文还在')
  })
})

/* ---------- 新建 ---------- */

describe('createPlanCard', () => {
  it('默认收集箱、排在列尾、文件名带序号与短标识、frontmatter 完整', async () => {
    const card = await createPlanCard(project(), { body: '# 新灵感\n\n正文' })

    expect(card.status).toBe('inbox')
    expect(card.order).toBe(0)
    expect(card.sourcePath).toMatch(/^plans\/计划-1-[0-9a-z]+\.md$/)
    expect(card.id).toMatch(/^plan-\d+-[0-9a-z]+$/)

    const raw = await readRaw(card.sourcePath)
    const parsed = parsePlanFile(card.sourcePath, raw)
    expect(parsed.card.id).toBe(card.id)
    expect(parsed.card.body).toBe('# 新灵感\n\n正文')
  })

  it('可指定状态；同列新建 order 递增；序号按已有最大值递进（删除后允许不连续）', async () => {
    await seedPlanFile('plans/计划-7-aaaa1111.md', { id: 'plan-7', status: 'planned', order: 250 }, '# 旧卡')

    const a = await createPlanCard(project(), { body: 'A', status: 'planned' })
    const b = await createPlanCard(project(), { body: 'B', status: 'planned' })

    expect(a.order).toBe(350)
    expect(b.order).toBe(450)
    expect(a.sourcePath).toMatch(/^plans\/计划-8-/)
    expect(b.sourcePath).toMatch(/^plans\/计划-9-/)
  })

  it('空正文拒绝（含纯空白）', async () => {
    await expect(createPlanCard(project(), { body: '' })).rejects.toThrow(PlanError)
    await expect(createPlanCard(project(), { body: '  \n\n  ' })).rejects.toThrow('计划正文不能为空')
  })
})

/* ---------- 读取 ---------- */

describe('readPlanCard', () => {
  it('按稳定标识读取完整正文与元数据；正文首行派生标题', async () => {
    const created = await createPlanCard(project(), { body: '# 伏笔标题\n\n正文细节' })
    const read = await readPlanCard(project(), created.id)

    expect(read?.card.id).toBe(created.id)
    expect(read?.card.body).toBe('# 伏笔标题\n\n正文细节')
    expect(read?.contentHash).toBe(hashContent(await readRaw(created.sourcePath)))
  })

  it('文件改名后仍按 id 定位（文件名不是标识）', async () => {
    const created = await createPlanCard(project(), { body: '正文' })
    const content = await readRaw(created.sourcePath)
    await writeProjectTextFile(root as FileSystemDirectoryHandle, 'plans/外部改名.md', content)

    const { removeProjectFile } = await import('../fs/project-fs')
    await removeProjectFile(root as FileSystemDirectoryHandle, created.sourcePath)

    const read = await readPlanCard(project(), created.id)
    expect(read?.card.id).toBe(created.id)
    expect(read?.card.body).toBe('正文')
  })

  it('不存在的标识返回 null', async () => {
    expect(await readPlanCard(project(), 'plan-none')).toBeNull()
  })
})

/* ---------- 更新 ---------- */

describe('updatePlanCard', () => {
  it('只改状态不动正文：正文原样保留，order 重算到目标列末尾', async () => {
    const a = await createPlanCard(project(), { body: '# A\n\n正文A' })
    const b = await createPlanCard(project(), { body: '# B', status: 'planned' })

    const updated = await updatePlanCard(project(), { id: a.id, status: 'planned' })

    expect(updated.status).toBe('planned')
    expect(updated.body).toBe('# A\n\n正文A')
    expect(updated.order).toBeGreaterThan(b.order)

    const raw = await readRaw(a.sourcePath)
    expect(parsePlanFile(a.sourcePath, raw).card.body).toBe('# A\n\n正文A')
  })

  it('只改正文不动状态；正文更新与状态更新互不误覆盖', async () => {
    const a = await createPlanCard(project(), { body: '旧正文', status: 'in-progress' })

    const updated = await updatePlanCard(project(), { id: a.id, body: '新正文' })

    expect(updated.body).toBe('新正文')
    expect(updated.status).toBe('in-progress')
    expect(updated.order).toBe(a.order)
  })

  it('外部修改后带旧 hash 更新正文：抛冲突，不覆盖', async () => {
    const a = await createPlanCard(project(), { body: '原始正文' })
    const read = await readPlanCard(project(), a.id)

    // 外部编辑器改了文件
    const external = await readRaw(a.sourcePath)
    await writeProjectTextFile(root as FileSystemDirectoryHandle, a.sourcePath, external.replace('原始正文', '外部改过的正文'))

    await expect(
      updatePlanCard(project(), { id: a.id, body: '我的新正文', expectedContentHash: read?.contentHash }),
    ).rejects.toThrow(PlanConflictError)

    // 文件保持外部版本
    const raw = await readRaw(a.sourcePath)
    expect(raw).toContain('外部改过的正文')
    expect(raw).not.toContain('我的新正文')
  })

  it('hash 未变时正常保存；不传 hash 不做冲突检测（手动面板直接保存）', async () => {
    const a = await createPlanCard(project(), { body: '原始正文' })
    const read = await readPlanCard(project(), a.id)

    await updatePlanCard(project(), { id: a.id, body: '正常更新', expectedContentHash: read?.contentHash })
    expect((await readPlanCard(project(), a.id))?.card.body).toBe('正常更新')

    await updatePlanCard(project(), { id: a.id, body: '无 hash 更新' })
    expect((await readPlanCard(project(), a.id))?.card.body).toBe('无 hash 更新')
  })

  it('五种状态都能切换，任意状态间可来回移动', async () => {
    const a = await createPlanCard(project(), { body: 'X' })
    const transitions: PlanStatus[] = ['planned', 'in-progress', 'on-hold', 'done', 'inbox']

    let current = a.status
    for (const next of transitions) {
      const updated = await updatePlanCard(project(), { id: a.id, status: next })
      expect(updated.status).toBe(next)
      current = next
    }
    expect(current).toBe('inbox')
  })

  it('带 afterId 移动：插到目标卡片之后（中点 order），仅重写目标卡片文件', async () => {
    const a = await createPlanCard(project(), { body: 'A', status: 'planned' })
    const b = await createPlanCard(project(), { body: 'B', status: 'planned' })
    const c = await createPlanCard(project(), { body: 'C', status: 'inbox' })

    const rawB = await readRaw(b.sourcePath)

    const updated = await updatePlanCard(project(), { id: c.id, status: 'planned', afterId: a.id })

    expect(updated.status).toBe('planned')
    expect(updated.order).toBe((a.order + b.order) / 2)
    // 未受影响卡片文件未重写（内容级断言：内容含 updatedAt 不变）
    expect(await readRaw(b.sourcePath)).toBe(rawB)
    expect(updated.updatedAt >= c.updatedAt).toBe(true)
  })

  it('更新不存在的计划：报错', async () => {
    await expect(updatePlanCard(project(), { id: 'plan-none', body: 'x' })).rejects.toThrow('计划不存在')
  })

  it('更新为空正文：拒绝且文件不变', async () => {
    const a = await createPlanCard(project(), { body: '原正文' })
    const rawBefore = await readRaw(a.sourcePath)

    await expect(updatePlanCard(project(), { id: a.id, body: '  ' })).rejects.toThrow('计划正文不能为空')
    expect(await readRaw(a.sourcePath)).toBe(rawBefore)
  })
})

/* ---------- 删除 ---------- */

describe('deletePlanCard', () => {
  it('删除进入回收站：原文移入 .novel/trash/，原位置消失', async () => {
    const a = await createPlanCard(project(), { body: '# 待删计划\n\n伏笔正文' })
    const raw = await readRaw(a.sourcePath)

    const result = await deletePlanCard(project(), a.id)

    expect(result.trashPath).toMatch(/^\.novel\/trash\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[0-9a-z]+\/plans\//)
    expect(await readRaw(result.trashPath)).toBe(raw)

    const { isNotFoundError } = await import('../tools/path')
    await expect(readRaw(a.sourcePath)).rejects.toSatisfy(isNotFoundError)
  })

  it('删除后再扫描看不见；同列剩余卡片不受影响', async () => {
    const a = await createPlanCard(project(), { body: 'A' })
    const b = await createPlanCard(project(), { body: 'B' })

    await deletePlanCard(project(), a.id)

    const scan = await scanPlanCards(project())
    expect(scan.cards.map((c) => c.id)).toEqual([b.id])
  })

  it('删除不存在的计划：报错', async () => {
    await expect(deletePlanCard(project(), 'plan-none')).rejects.toThrow('计划不存在')
  })
})
