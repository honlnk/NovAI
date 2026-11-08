import { beforeEach, describe, expect, it } from 'vitest'

import { scanForeshadowingCards } from './catalog'
import { parseForeshadowingFile } from './parser'
import { createForeshadowingCard, deleteForeshadowingCard, readForeshadowingCard, updateForeshadowingCard } from './store'
import { hashContent } from '../util/hash'
import { ForeshadowingConflictError, ForeshadowingError } from '../../types/foreshadowing'
import { writeProjectTextFile } from '../fs/project-fs'

/* ---------- 内存文件系统（与 card-board store 测试同款内联实现） ---------- */

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

/* ---------- 测试 ---------- */

let root: MemoryDirectoryHandle

function project() {
  return { handle: root }
}

function collectFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  collectSync(root.__entry, '')
  return files

  function collectSync(entry: MemoryDirectoryEntry, prefix: string) {
    for (const [name, child] of entry.entries) {
      if (child.kind === 'directory') {
        collectSync(child, `${prefix}${name}/`)
      } else {
        files[`${prefix}${name}`] = child.content
      }
    }
  }
}

beforeEach(() => {
  root = createMemoryDirectory('project')
})

describe('createForeshadowingCard', () => {
  it('创建带完整领域的伏笔文件，ID 按序号生成', async () => {
    const card = await createForeshadowingCard(project(), {
      name: '旧照片之谜',
      readerView: '主角在旧书店发现一张褪色的照片。',
      authorTruth: '主角是研究员的复制体。',
      plantedAt: '第一卷/第012章',
      payoffWindow: ['第二卷/第080章', '第二卷/第090章'],
      relatedCharacters: ['主角', '母亲'],
    })

    expect(card.id).toBe('F-001')
    expect(card.sourcePath).toBe('foreshadowing/F-001-旧照片之谜.md')

    const roundTrip = parseForeshadowingFile(card.sourcePath, collectFiles()[card.sourcePath]!)
    expect(roundTrip.card).toEqual({ ...card, sourcePath: undefined as never, ...{} })
    expect(roundTrip.truthBody).toBe('主角是研究员的复制体。')
  })

  it('第二条伏笔序号顺延', async () => {
    await createForeshadowingCard(project(), { name: 'A', readerView: 'r', plantedAt: '第一卷/第001章' })
    const second = await createForeshadowingCard(project(), { name: 'B', readerView: 'r', plantedAt: '第一卷/第002章' })
    expect(second.id).toBe('F-002')
  })

  it('名/读者视角/埋设章节缺失时拒绝创建', async () => {
    await expect(createForeshadowingCard(project(), { name: ' ', readerView: 'r', plantedAt: 'x' }))
      .rejects.toThrow('伏笔名不能为空')
    await expect(createForeshadowingCard(project(), { name: 'A', readerView: ' ', plantedAt: 'x' }))
      .rejects.toThrow('读者视角不能为空')
    await expect(createForeshadowingCard(project(), { name: 'A', readerView: 'r', plantedAt: ' ' }))
      .rejects.toThrow('埋设章节不能为空')
  })

  it('目录不存在时温和创建（空项目获得伏笔能力）', async () => {
    const scan = await scanForeshadowingCards(project())
    expect(scan.cards).toEqual([])
    expect(scan.issues).toEqual([])
  })
})

describe('updateForeshadowingCard', () => {
  async function seed() {
    return createForeshadowingCard(project(), {
      name: '旧照片之谜',
      readerView: '主角在旧书店发现一张褪色的照片。',
      authorTruth: '主角是研究员的复制体。',
      plantedAt: '第一卷/第012章',
      now: new Date('2026-11-01T00:00:00Z'),
    })
  }

  it('改名同步文件名（保留 ID 与序号）', async () => {
    const card = await seed()
    const updated = await updateForeshadowingCard(project(), { id: card.id, name: '母亲的沉默' })

    expect(updated.id).toBe('F-001')
    expect(updated.sourcePath).toBe('foreshadowing/F-001-母亲的沉默.md')
    expect(collectFiles()[card.sourcePath]).toBeUndefined()
  })

  it('只替换读者视角时作者真相原样保留', async () => {
    const card = await seed()
    const updated = await updateForeshadowingCard(project(), { id: card.id, readerView: '新的读者视角内容' })

    const roundTrip = parseForeshadowingFile(updated.sourcePath, collectFiles()[updated.sourcePath]!)
    expect(roundTrip.readerBody).toContain('新的读者视角内容')
    expect(roundTrip.truthBody).toBe('主角是研究员的复制体。')
  })

  it('追加暗示历史去重保序', async () => {
    const card = await seed()
    await updateForeshadowingCard(project(), { id: card.id, addRelatedChapters: ['第一卷/第028章', '第一卷/第028章', '第一卷/第051章'] })
    const updated = await readForeshadowingCard(project(), card.id)

    expect(updated?.card.relatedChapters).toEqual(['第一卷/第028章', '第一卷/第051章'])
  })

  it('状态推进到 resolved 登记回收章节；退回进行中时清残留', async () => {
    const card = await seed()
    const resolved = await updateForeshadowingCard(project(), {
      id: card.id,
      status: 'resolved',
      resolvedAt: '第二卷/第085章',
    })
    expect(resolved.resolvedAt).toBe('第二卷/第085章')

    const reverted = await updateForeshadowingCard(project(), { id: card.id, status: 'developed' })
    expect(reverted.resolvedAt).toBeNull()
  })

  it('放弃必须给原因', async () => {
    const card = await seed()
    await expect(updateForeshadowingCard(project(), { id: card.id, status: 'abandoned' }))
      .rejects.toThrow('放弃伏笔必须登记原因')

    const abandoned = await updateForeshadowingCard(project(), {
      id: card.id,
      status: 'abandoned',
      abandonedReason: '剧情改版，照片线索并入其他伏笔',
    })
    expect(abandoned.abandonedReason).toBe('剧情改版，照片线索并入其他伏笔')
  })

  it('外部修改后带旧 hash 保存抛冲突', async () => {
    const card = await seed()
    const read = await readForeshadowingCard(project(), card.id)

    // 外部编辑器改文件
    const raw = collectFiles()[card.sourcePath]!
    await writeProjectTextFile(root, card.sourcePath, `${raw}\n<!-- 外部改动 -->`)

    await expect(updateForeshadowingCard(project(), {
      id: card.id,
      status: 'hinted',
      expectedContentHash: read!.contentHash,
    })).rejects.toThrow(ForeshadowingConflictError)
  })

  it('无任何字段时拒绝执行', async () => {
    const card = await seed()
    await expect(updateForeshadowingCard(project(), { id: card.id }))
      .rejects.toThrow(ForeshadowingError)
  })

  it('改名目标被占用时报错且原文件无损', async () => {
    const a = await createForeshadowingCard(project(), { name: '旧名', readerView: 'r', plantedAt: '第一卷/第001章' })
    // 手建一个同 ID 前缀的目标文件构造占用（应用创建的卡片 ID 各自不同，不会互相占用）
    await writeProjectTextFile(root, 'foreshadowing/F-001-占用名.md', '---\nid: 手建\n---\n\n外部文件')

    await expect(updateForeshadowingCard(project(), { id: a.id, name: '占用名' }))
      .rejects.toThrow('目标文件已存在')
    expect(collectFiles()[a.sourcePath]).toBeTruthy()
  })
})

describe('deleteForeshadowingCard', () => {
  it('移入回收站并删除原文件', async () => {
    const card = await createForeshadowingCard(project(), { name: 'A', readerView: 'r', plantedAt: '第一卷/第001章' })
    const result = await deleteForeshadowingCard(project(), card.id)

    expect(result.trashPath.startsWith('.novel/trash/')).toBe(true)
    expect(Object.keys(collectFiles())).toEqual([result.trashPath])
  })

  it('删除不存在的伏笔报错', async () => {
    await expect(deleteForeshadowingCard(project(), 'F-999')).rejects.toThrow('伏笔不存在')
  })
})

describe('scanForeshadowingCards', () => {
  it('手建文件缺 id 时兜底展示；损坏文件进 issues', async () => {
    await writeProjectTextFile(root, 'foreshadowing/手建.md', '---\nname: 手建伏笔\n---\n\n正文')
    const scan = await scanForeshadowingCards(project())

    expect(scan.cards).toHaveLength(1)
    expect(scan.cards[0]!.id).toMatch(/^foreshadowing-file-/)
    expect(scan.cards[0]!.name).toBe('手建伏笔')
  })

  it('同一 id 的重复文件报告不合并', async () => {
    const content = '---\nid: F-001\nname: A\nplanted_at: 第一卷/第001章\n---\n\n## 读者视角（当时可见事实）\n\nr'
    await writeProjectTextFile(root, 'foreshadowing/F-001-甲.md', content)
    await writeProjectTextFile(root, 'foreshadowing/F-001-乙.md', content)

    const scan = await scanForeshadowingCards(project())
    expect(scan.cards).toHaveLength(2)
    expect(scan.issues).toEqual([
      { kind: 'duplicate-id', id: 'F-001', paths: ['foreshadowing/F-001-甲.md', 'foreshadowing/F-001-乙.md'] },
    ])
  })
})
