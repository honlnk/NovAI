import { beforeEach, describe, expect, it } from 'vitest'

import { scanPlanCards } from './catalog'
import { derivePlanTitle, parsePlanFile } from './parser'
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

/* ---------- 改名与文件重命名 ---------- */

describe('updatePlanCard 改名与文件重命名', () => {
  const META = { id: 'plan-a', status: 'inbox', order: 0, createdAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-01T08:00:00.000Z' }

  it('改名：正文首个非空行替换、保留 # 层级，文件名同步为新格式，旧文件消失', async () => {
    await seedPlanFile('plans/计划-1-ab12cd34.md', META, '# 旧标题\n\n正文第一段。\n\n第二段。')

    const updated = await updatePlanCard(project(), { id: 'plan-a', title: '龙脉觉醒' })

    // 正文：标题层级保留，只换文本；其余正文不动
    expect(updated.body).toBe('# 龙脉觉醒\n\n正文第一段。\n\n第二段。')
    expect(derivePlanTitle(updated.body)).toBe('龙脉觉醒')
    // 元数据保持
    expect(updated.id).toBe('plan-a')
    expect(updated.status).toBe('inbox')
    expect(updated.order).toBe(0)
    expect(updated.createdAt).toBe('2026-11-01T08:00:00.000Z')
    // 文件名：新格式 计划-<原序号>-<清理后名称>-<原短标识>.md
    expect(updated.sourcePath).toBe('plans/计划-1-龙脉觉醒-ab12cd34.md')

    // 旧文件不存在，新文件可按原 ID 读取
    const { isNotFoundError } = await import('../tools/path')
    await expect(readRaw('plans/计划-1-ab12cd34.md')).rejects.toSatisfy(isNotFoundError)
    const reread = await readPlanCard(project(), 'plan-a')
    expect(reread?.card.sourcePath).toBe('plans/计划-1-龙脉觉醒-ab12cd34.md')
    expect(reread?.card.body).toBe('# 龙脉觉醒\n\n正文第一段。\n\n第二段。')
  })

  it('普通首行（非 Markdown 标题）改名：只替换该行文本', async () => {
    await seedPlanFile('plans/计划-2-ef56ab78.md', { ...META, id: 'plan-b' }, '普通标题行\n\n正文')

    const updated = await updatePlanCard(project(), { id: 'plan-b', title: '新名字' })

    expect(updated.body).toBe('新名字\n\n正文')
    expect(updated.sourcePath).toBe('plans/计划-2-新名字-ef56ab78.md')
  })

  it('名称与当前文件名不一致时：旧格式文件首次改名会补全可读名称（预期迁移）', async () => {
    await seedPlanFile('plans/计划-3-cd34ef56.md', { ...META, id: 'plan-c' }, '# 固定名称\n\n正文')

    const updated = await updatePlanCard(project(), { id: 'plan-c', title: '固定名称', now: new Date('2026-11-06T00:00:00.000Z') })

    // 旧格式文件名没有名称段：即使标题没变，路径也会补全为带名称的新格式（设计：首次改名迁移）
    expect(updated.sourcePath).toBe('plans/计划-3-固定名称-cd34ef56.md')
    expect(updated.updatedAt).toBe('2026-11-06T00:00:00.000Z')
    // 新路径可读，旧路径消失
    await expect(readRaw('plans/计划-3-固定名称-cd34ef56.md')).resolves.toContain('固定名称')
    const { isNotFoundError } = await import('../tools/path')
    await expect(readRaw('plans/计划-3-cd34ef56.md')).rejects.toSatisfy(isNotFoundError)
  })

  it('已带计划名的新格式文件再改名：序号与短标识保持，名称更新', async () => {
    await seedPlanFile('plans/计划-3-旧名字-cd34ef56.md', { ...META, id: 'plan-d' }, '# 旧名字\n\n正文')

    const updated = await updatePlanCard(project(), { id: 'plan-d', title: '新名字' })

    expect(updated.sourcePath).toBe('plans/计划-3-新名字-cd34ef56.md')
  })

  it('外部手建文件（无序号无短标识）改名：文件名主体取自清理后名称与新正文哈希', async () => {
    await seedPlanFile('plans/随便写的.md', { ...META, id: 'plan-e' }, '# 随便写的\n\n正文')

    const updated = await updatePlanCard(project(), { id: 'plan-e', title: '规范名称' })

    // 无序号不编造；短标识按当前正文计算（外部文件原本没有）
    expect(updated.sourcePath).toMatch(/^plans\/计划-规范名称-[0-9a-z]+\.md$/)
    const reread = await readPlanCard(project(), 'plan-e')
    expect(reread?.card.sourcePath).toBe(updated.sourcePath)
  })

  it('改名后原 ID 仍能定位：排序与状态不受影响', async () => {
    await seedPlanFile('plans/计划-4-aa11bb22.md', { id: 'plan-f', status: 'planned', order: 100, createdAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-01T08:00:00.000Z' }, '# 计划F\n\n正文')
    await seedPlanFile('plans/计划-5-cc33dd44.md', { id: 'plan-g', status: 'planned', order: 200, createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z' }, '# 计划G\n\n正文')

    await updatePlanCard(project(), { id: 'plan-f', title: '改名后的F' })

    const scan = await scanPlanCards(project())
    const planned = scan.cards.filter((card) => card.status === 'planned')
    expect(planned.map((card) => card.id)).toEqual(['plan-f', 'plan-g'])
    expect(planned[0]!.sourcePath).toBe('plans/计划-4-改名后的F-aa11bb22.md')
  })

  it('同名计划允许共存：不同序号/短标识文件名不同，互不覆盖', async () => {
    await seedPlanFile('plans/计划-1-ab12cd34.md', META, '# 重名计划\n\nA 的正文')
    await seedPlanFile('plans/计划-2-ef56ab78.md', { ...META, id: 'plan-b' }, '重名计划\n\nB 的正文')

    const updated = await updatePlanCard(project(), { id: 'plan-a', title: '重名计划' })

    // plan-a 的目标路径与 plan-b 的目标路径（计划-2-...）不同：序号与短标识保唯一
    expect(updated.sourcePath).toBe('plans/计划-1-重名计划-ab12cd34.md')
    const other = await readPlanCard(project(), 'plan-b')
    expect(other?.card.body).toBe('重名计划\n\nB 的正文')
    expect(other?.card.sourcePath).toBe('plans/计划-2-ef56ab78.md')
  })

  it('目标文件已被外部占用：拒绝改名，原文件与目标都不变', async () => {
    await seedPlanFile('plans/计划-1-ab12cd34.md', META, '# 计划A\n\n正文')
    // 外部已有一个占用目标路径的文件（无 frontmatter id，扫描不在卡片内但文件存在）
    await seedPlanFile('plans/计划-1-目标名-ab12cd34.md', {}, '外部文件')

    await expect(updatePlanCard(project(), { id: 'plan-a', title: '目标名' })).rejects.toThrow('目标文件已存在')

    // 原文件未被改动，目标外部文件未被覆盖
    const unchanged = await readPlanCard(project(), 'plan-a')
    expect(unchanged?.card.body).toBe('# 计划A\n\n正文')
    expect(unchanged?.card.sourcePath).toBe('plans/计划-1-ab12cd34.md')
    expect(await readRaw('plans/计划-1-目标名-ab12cd34.md')).toBe('外部文件\n')
  })

  it('改名也走内容哈希冲突检测：外部改过则拒绝', async () => {
    await seedPlanFile('plans/计划-1-ab12cd34.md', META, '# 旧标题\n\n正文')

    const content = await readRaw('plans/计划-1-ab12cd34.md')
    const staleHash = hashContent(content)
    // 外部修改（改名后 hash 已过时）
    await seedPlanFile('plans/计划-1-ab12cd34.md', META, '# 旧标题\n\n被外部改过的正文')

    await expect(updatePlanCard(project(), { id: 'plan-a', title: '新标题', expectedContentHash: staleHash }))
      .rejects.toThrow(PlanConflictError)

    const current = await readPlanCard(project(), 'plan-a')
    expect(current?.card.body).toBe('# 旧标题\n\n被外部改过的正文')
    expect(current?.card.sourcePath).toBe('plans/计划-1-ab12cd34.md')
  })

  it('title 与 body 同传：以 body 为准（调用方已组合好正文）', async () => {
    await seedPlanFile('plans/计划-1-ab12cd34.md', META, '# 旧标题\n\n正文')

    const updated = await updatePlanCard(project(), {
      id: 'plan-a',
      title: '被忽略的名称',
      body: '# 组合好的标题\n\n组合好的正文',
    })

    expect(updated.body).toBe('# 组合好的标题\n\n组合好的正文')
    expect(derivePlanTitle(updated.body)).toBe('组合好的标题')
  })

  it('空名称拒绝', async () => {
    await seedPlanFile('plans/计划-1-ab12cd34.md', META, '# 旧标题\n\n正文')

    await expect(updatePlanCard(project(), { id: 'plan-a', title: '   ' })).rejects.toThrow('计划名不能为空')
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
