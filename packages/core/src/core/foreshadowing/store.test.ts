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

  it('状态推进到 resolved 登记回收章节；退回进行中时保留（不隐式清空，由界面提示不一致）', async () => {
    const card = await seed()
    const resolved = await updateForeshadowingCard(project(), {
      id: card.id,
      status: 'resolved',
      resolvedAt: '第二卷/第085章',
    })
    expect(resolved.resolvedAt).toBe('第二卷/第085章')

    // 作者字段控制权计划 §三.3：状态变更不得顺带删除实际回收章节（作者的事实记录）
    const reverted = await updateForeshadowingCard(project(), { id: card.id, status: 'developed' })
    expect(reverted.resolvedAt).toBe('第二卷/第085章')

    // 显式传入 null 才清除
    const cleared = await updateForeshadowingCard(project(), { id: card.id, resolvedAt: null })
    expect(cleared.resolvedAt).toBeNull()
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

  it('beforeId 在列内插到目标卡片之前（列首 - 步长）', async () => {
    const a = await createForeshadowingCard(project(), { name: 'A', readerView: 'r', plantedAt: '第一卷/第001章' })
    await createForeshadowingCard(project(), { name: 'B', readerView: 'r', plantedAt: '第一卷/第002章' })
    const c = await createForeshadowingCard(project(), { name: 'C', readerView: 'r', plantedAt: '第一卷/第003章' })

    const moved = await updateForeshadowingCard(project(), { id: c.id, beforeId: a.id })

    expect(moved.order).toBe(-100)
    const scan = await scanForeshadowingCards(project())
    expect(scan.cards.map((item) => item.name)).toEqual(['C', 'A', 'B'])
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

describe('updateForeshadowingCard（作者字段控制权计划阶段 2）', () => {
  async function seedAdvanced() {
    return createForeshadowingCard(project(), {
      name: '锈钥匙',
      readerView: '门后挂着一把锈钥匙。',
      authorTruth: '钥匙通向地下档案室。',
      plantedAt: '第一卷/第003章',
      payoffWindow: ['第一卷/第020章', '第一卷/第030章'],
      relatedCharacters: ['林凡'],
      relatedEntities: ['锈钥匙'],
    })
  }

  it('作者完整替换关联章节：去空白、去重保首次位置、保留作者排列；AI 追加不恢复已删除项', async () => {
    const card = await seedAdvanced()
    await updateForeshadowingCard(project(), { id: card.id, addRelatedChapters: ['第一卷/第021章', '第一卷/第022章'] })

    // 作者整理：删掉 021、重排，加入重复项验证去重保首
    const replaced = await updateForeshadowingCard(project(), {
      id: card.id,
      relatedChapters: ['第一卷/第022章', ' 第一卷/第021章 ', '第一卷/第022章', '第一卷/第040章'],
    })
    expect(replaced.relatedChapters).toEqual(['第一卷/第022章', '第一卷/第021章', '第一卷/第040章'])

    // 后续普通追加只追加新项，不恢复被作者删除的旧项
    const appended = await updateForeshadowingCard(project(), { id: card.id, addRelatedChapters: ['第一卷/第050章'] })
    expect(appended.relatedChapters).toEqual(['第一卷/第022章', '第一卷/第021章', '第一卷/第040章', '第一卷/第050章'])

    // 清空
    const cleared = await updateForeshadowingCard(project(), { id: card.id, relatedChapters: [] })
    expect(cleared.relatedChapters).toEqual([])

    // 两条链路互斥
    await expect(updateForeshadowingCard(project(), {
      id: card.id,
      relatedChapters: ['a'],
      addRelatedChapters: ['b'],
    })).rejects.toThrow('不能同时提供')
  })

  it('关联角色/实体替换时去空白去重', async () => {
    const card = await seedAdvanced()
    const updated = await updateForeshadowingCard(project(), {
      id: card.id,
      relatedCharacters: [' 林凡 ', '苏离', '林凡', ''],
      relatedEntities: [],
    })
    expect(updated.relatedCharacters).toEqual(['林凡', '苏离'])
    expect(updated.relatedEntities).toEqual([])
  })

  it('结构化窗口更新：校验通过并同步重写可读旧字段（开放终点占位）', async () => {
    const card = await seedAdvanced()
    const updated = await updateForeshadowingCard(project(), {
      id: card.id,
      payoffStart: { kind: 'relative', target: 35, base: 30, offset: 5 },
      payoffEnd: { kind: 'open' },
    })

    expect(updated.payoffStart).toEqual({ kind: 'relative', target: 35, base: 30, offset: 5 })
    expect(updated.payoffEnd).toEqual({ kind: 'open' })
    expect(updated.payoffWindow).toEqual(['第35章', '开放终点'])

    // 只更新一端：另一端沿用当前有效值
    const endOnly = await updateForeshadowingCard(project(), {
      id: card.id,
      payoffEnd: { kind: 'future', target: 60 },
    })
    expect(endOnly.payoffStart).toEqual({ kind: 'relative', target: 35, base: 30, offset: 5 })
    expect(endOnly.payoffWindow).toEqual(['第35章', '第60章'])

    // 全部清空
    const cleared = await updateForeshadowingCard(project(), {
      id: card.id,
      payoffStart: { kind: 'none' },
      payoffEnd: { kind: 'none' },
    })
    expect(cleared.payoffWindow).toBeNull()
  })

  it('窗口校验：缺起点有终点、倒置区间、非法相对位置均拒绝且不落盘', async () => {
    const card = await seedAdvanced()

    await expect(updateForeshadowingCard(project(), {
      id: card.id,
      payoffStart: { kind: 'none' },
      payoffEnd: { kind: 'future', target: 20 },
    })).rejects.toThrow(/起点/)

    await expect(updateForeshadowingCard(project(), {
      id: card.id,
      payoffStart: { kind: 'future', target: 40 },
      payoffEnd: { kind: 'future', target: 20 },
    })).rejects.toThrow(/晚于终点/)

    await expect(updateForeshadowingCard(project(), {
      id: card.id,
      payoffStart: { kind: 'relative', target: 40, base: 30, offset: 20 },
      payoffEnd: { kind: 'open' },
    })).rejects.toThrow(/相对位置/)

    // 旧字段保持原值（拒绝不落盘）
    const after = await readForeshadowingCard(project(), card.id)
    expect(after?.card.payoffWindow).toEqual(['第一卷/第020章', '第一卷/第030章'])
  })

  it('AI 旧窗口链路：反向推导结构化数据，两套保持一致（原相对位置不保留）', async () => {
    const card = await seedAdvanced()
    await updateForeshadowingCard(project(), {
      id: card.id,
      payoffStart: { kind: 'relative', target: 35, base: 30, offset: 5 },
      payoffEnd: { kind: 'open' },
    })

    const viaLegacy = await updateForeshadowingCard(project(), {
      id: card.id,
      payoffWindow: ['第一卷/第025章', '开放终点'],
    })
    expect(viaLegacy.payoffStart).toEqual({ kind: 'chapter', ref: '第一卷/第025章' })
    expect(viaLegacy.payoffEnd).toEqual({ kind: 'open' })
    expect(viaLegacy.payoffWindow).toEqual(['第一卷/第025章', '开放终点'])

    // 两套链路互斥
    await expect(updateForeshadowingCard(project(), {
      id: card.id,
      payoffWindow: ['第010章', '第020章'],
      payoffStart: { kind: 'none' },
    })).rejects.toThrow('不能同时提供')
  })

  it('旧卡（无结构化数据）首次保存不迁移：保存无关字段不写 payoff_start', async () => {
    const seed = await seedAdvanced()
    // 手工构造旧卡文件：不带 payoff_start/payoff_end
    const files = collectFiles()
    const legacy = files[seed.sourcePath]!
      .replace(/^payoff_start: .*\n/m, '')
      .replace(/^payoff_end: .*\n/m, '')
    await writeProjectTextFile(project().handle, seed.sourcePath, legacy)

    // 保存一个与窗口无关的字段（isRedHerring，不改名避免文件移动）
    await updateForeshadowingCard(project(), { id: seed.id, isRedHerring: true })

    const after = collectFiles()[seed.sourcePath]!
    expect(after).not.toContain('payoff_start:')
    expect(after).not.toContain('payoff_end:')
    expect(after).toContain('payoff_window: [第一卷/第020章, 第一卷/第030章]')

    // 作者保存窗口相关字段时才转换为新表达
    await updateForeshadowingCard(project(), { id: seed.id, payoffEnd: { kind: 'open' } })
    const converted = collectFiles()[seed.sourcePath]!
    expect(converted).toContain('payoff_start: chapter:第一卷/第020章')
    expect(converted).toContain('payoff_end: open')
    expect(converted).toContain('payoff_window: [第一卷/第020章, 开放终点]')
  })

  it('创建带结构化计划窗口与暗示历史：直接落新表达并派生可读旧字段', async () => {
    const card = await createForeshadowingCard(project(), {
      name: '茶馆暗号',
      readerView: '茶馆伙计敲了三下桌角。',
      authorTruth: '三响是联络暗号。',
      plantedAt: '第一卷/第005章',
      payoffStart: { kind: 'relative', target: 15, base: 12, offset: 3 },
      payoffEnd: { kind: 'future', target: 20 },
      relatedCharacters: [' 林掌柜 ', '阿四', '林掌柜'],
      relatedChapters: ['第一卷/第006章', '', '第一卷/第006章'],
    })

    expect(card.payoffStart).toEqual({ kind: 'relative', target: 15, base: 12, offset: 3 })
    expect(card.payoffEnd).toEqual({ kind: 'future', target: 20 })
    // 相对位置在可读旧字段里落确定目标章号，不落「3 章之后」这种无法还原的文本
    expect(card.payoffWindow).toEqual(['第15章', '第20章'])
    expect(card.relatedChapters).toEqual(['第一卷/第006章'])
    expect(card.relatedCharacters).toEqual(['林掌柜', '阿四'])

    const roundTrip = parseForeshadowingFile(card.sourcePath, collectFiles()[card.sourcePath]!)
    expect(roundTrip.card.payoffStart).toEqual({ kind: 'relative', target: 15, base: 12, offset: 3 })
    expect(roundTrip.card.payoffEnd).toEqual({ kind: 'future', target: 20 })

    // 双链路互斥
    await expect(createForeshadowingCard(project(), {
      name: '互斥',
      readerView: 'x',
      plantedAt: '第001章',
      payoffWindow: ['第010章', '第020章'],
      payoffStart: { kind: 'chapter', ref: '第010章' },
    })).rejects.toThrow('不能同时提供')

    // 结构化链路同样执行窗口校验（缺起点）
    await expect(createForeshadowingCard(project(), {
      name: '倒置',
      readerView: 'x',
      plantedAt: '第001章',
      payoffStart: { kind: 'none' },
      payoffEnd: { kind: 'future', target: 20 },
    })).rejects.toThrow(/起点/)
  })

  it('已放弃卡的历史原因修订：空值拒绝、非空立即生效；普通状态下可为空', async () => {
    const card = await seedAdvanced()
    await updateForeshadowingCard(project(), { id: card.id, status: 'abandoned', abandonedReason: '主线改动，不再回收' })

    await expect(updateForeshadowingCard(project(), { id: card.id, abandonedReason: '  ' }))
      .rejects.toThrow(/原因/)

    const revised = await updateForeshadowingCard(project(), { id: card.id, abandonedReason: '修订后的原因' })
    expect(revised.abandonedReason).toBe('修订后的原因')
    expect(revised.status).toBe('abandoned')

    // 恢复普通状态后原因可为空或保留
    const restored = await updateForeshadowingCard(project(), { id: card.id, status: 'planted', abandonedReason: null })
    expect(restored.abandonedReason).toBeNull()
  })
})

