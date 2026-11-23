import { beforeEach, describe, expect, it } from 'vitest'

import { scanRhythmCards } from './catalog'
import { parseRhythmFile } from './parser'
import { createRhythmCard, deleteRhythmCard, readRhythmCard, updateRhythmCard } from './store'
import { hashContent } from '../util/hash'
import { RhythmConflictError, RhythmError } from '../../types/rhythm'
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

/** 标准种子卡：计划「冲突 3 / 温馨 / 无钩子 / 收获」，第 83 章喘息章。 */
type SeedOptions = Parameters<typeof createRhythmCard>[1]

function seedOptions(overrides: Partial<SeedOptions> = {}): SeedOptions {
  return {
    name: '第083章节奏',
    chapterRef: '第二卷/第083章',
    plannedConflict: 3,
    plannedMood: '温馨',
    plannedHook: '无',
    plannedPayoff: '收获',
    plannedCharacters: ['主角', '师妹'],
    plannedNote: '大高潮后的喘息章',
    intentBody: '让读者喘口气。',
    now: new Date('2026-11-01T00:00:00Z'),
    ...overrides,
  }
}

describe('createRhythmCard', () => {
  it('创建节奏卡：ID 按序号生成、初始 planned、往返无损', async () => {
    const card = await createRhythmCard(project(), seedOptions())

    expect(card.id).toBe('R-001')
    expect(card.sourcePath).toBe('rhythm/R-001-第083章节奏.md')
    expect(card.status).toBe('planned')
    expect(card.actualConflict).toBeNull()
    expect(card.actualMood).toBeNull()
    expect(card.actualHook).toBeNull()
    expect(card.actualPayoff).toBeNull()
    expect(card.actualNote).toBeNull()
    expect(card.deviationFlag).toBe(false)
    expect(card.deviationNote).toBeNull()

    const roundTrip = parseRhythmFile(card.sourcePath, collectFiles()[card.sourcePath]!)
    expect(roundTrip.card).toEqual({ ...card, sourcePath: undefined as never, ...{} })
    expect(roundTrip.intentBody).toBe('让读者喘口气。')
  })

  it('第二条序号顺延；chapterRef 原样保留（含作者自由标注的「卷/章」写法）', async () => {
    await createRhythmCard(project(), seedOptions())
    const second = await createRhythmCard(project(), seedOptions({ name: 'B', chapterRef: '第三卷/第001章' }))
    expect(second.id).toBe('R-002')
    expect(second.chapterRef).toBe('第三卷/第001章')

    const noSlash = await createRhythmCard(project(), seedOptions({ name: 'D', chapterRef: '第099章' }))
    expect(noSlash.chapterRef).toBe('第099章')
  })

  it('必填缺失或冲突强度非法时拒绝创建', async () => {
    await expect(createRhythmCard(project(), seedOptions({ name: ' ' }))).rejects.toThrow('节奏卡名不能为空')
    await expect(createRhythmCard(project(), seedOptions({ chapterRef: ' ' }))).rejects.toThrow('关联章节不能为空')
    await expect(createRhythmCard(project(), seedOptions({ plannedConflict: 11 }))).rejects.toThrow('planned_conflict 非法：11')
    await expect(createRhythmCard(project(), seedOptions({ plannedConflict: 0 }))).rejects.toThrow('planned_conflict 非法：0')
    await expect(createRhythmCard(project(), seedOptions({ plannedConflict: 3.5 }))).rejects.toThrow('planned_conflict 非法：3.5')
  })

  it('目录不存在时温和扫描（空项目获得节奏卡能力）', async () => {
    const scan = await scanRhythmCards(project())
    expect(scan.cards).toEqual([])
    expect(scan.issues).toEqual([])
  })
})

describe('readRhythmCard', () => {
  it('读回卡片与 contentHash', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    const read = await readRhythmCard(project(), card.id)

    expect(read?.card.id).toBe(card.id)
    expect(read?.card.plannedMood).toBe('温馨')
    expect(read?.contentHash).toBe(hashContent(collectFiles()[card.sourcePath]!))
  })

  it('不存在的节奏卡返回 null', async () => {
    expect(await readRhythmCard(project(), 'R-999')).toBeNull()
  })
})

describe('updateRhythmCard：计划值与元数据', () => {
  it('更新计划值（无实际值的卡）不改判定结果', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    const updated = await updateRhythmCard(project(), {
      id: card.id,
      plannedConflict: 8,
      plannedMood: '紧张',
      plannedNote: '改成高压章',
      plannedCharacters: ['主角'],
    })

    expect(updated.status).toBe('planned')
    expect(updated.plannedConflict).toBe(8)
    expect(updated.plannedMood).toBe('紧张')
    expect(updated.plannedNote).toBe('改成高压章')
    expect(updated.plannedCharacters).toEqual(['主角'])
    expect(updated.deviationFlag).toBe(false)
  })

  it('改名同步文件名（保留 ID 与序号）', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    const updated = await updateRhythmCard(project(), { id: card.id, name: '第083章节奏修订' })

    expect(updated.id).toBe('R-001')
    expect(updated.sourcePath).toBe('rhythm/R-001-第083章节奏修订.md')
    expect(collectFiles()[card.sourcePath]).toBeUndefined()
  })

  it('改名目标被占用时报错且原文件无损', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    await writeProjectTextFile(root, 'rhythm/R-001-占用名.md', '---\nid: 手建\n---\n\n外部文件')

    await expect(updateRhythmCard(project(), { id: card.id, name: '占用名' })).rejects.toThrow('目标文件已存在')
    expect(collectFiles()[card.sourcePath]).toBeTruthy()
  })

  it('无任何字段时拒绝执行', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    await expect(updateRhythmCard(project(), { id: card.id })).rejects.toThrow(RhythmError)
  })

  it('正文三节单独替换：未提供的节保持原样（需带 hash）', async () => {
    const card = await createRhythmCard(project(), seedOptions({
      linkBody: '- 上一章：冲突 9、悲壮',
      authorNoteBody: '旧备注',
    }))
    const read = await readRhythmCard(project(), card.id)

    const updated = await updateRhythmCard(project(), {
      id: card.id,
      intentBody: '新意图：继续喘。',
      expectedContentHash: read!.contentHash,
    })

    const roundTrip = parseRhythmFile(updated.sourcePath, collectFiles()[updated.sourcePath]!)
    expect(roundTrip.intentBody).toBe('新意图：继续喘。')
    expect(roundTrip.linkBody).toBe('- 上一章：冲突 9、悲壮')
    expect(roundTrip.authorNoteBody).toBe('旧备注')
  })

  it('更新正文不带 expectedContentHash 时拒绝', async () => {
    const card = await createRhythmCard(project(), seedOptions())

    await expect(updateRhythmCard(project(), { id: card.id, intentBody: '新意图' }))
      .rejects.toThrow('expectedContentHash')
    await expect(updateRhythmCard(project(), { id: card.id, linkBody: '新衔接' }))
      .rejects.toThrow('expectedContentHash')
  })

  it('外部修改后带旧 hash 保存抛冲突（携带当前卡片）', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    const read = await readRhythmCard(project(), card.id)

    const raw = collectFiles()[card.sourcePath]!
    await writeProjectTextFile(root, card.sourcePath, `${raw}\n<!-- 外部改动 -->`)

    try {
      await updateRhythmCard(project(), {
        id: card.id,
        plannedNote: '新备注',
        expectedContentHash: read!.contentHash,
      })
      expect.unreachable('应抛 RhythmConflictError')
    } catch (error) {
      expect(error).toBeInstanceOf(RhythmConflictError)
      expect((error as RhythmConflictError).currentCard.id).toBe(card.id)
    }
  })

  it('afterId 在列内重排', async () => {
    const a = await createRhythmCard(project(), seedOptions({ name: 'A', chapterRef: '第二卷/第081章' }))
    await createRhythmCard(project(), seedOptions({ name: 'B', chapterRef: '第二卷/第082章' }))
    const c = await createRhythmCard(project(), seedOptions({ name: 'C', chapterRef: '第二卷/第083章' }))

    // 把 A（order 0）挪到 B 之后：B=100、C=200 → 中点 150
    const moved = await updateRhythmCard(project(), { id: a.id, afterId: 'R-002' })
    expect(moved.order).toBe(150)

    const scan = await scanRhythmCards(project())
    expect(scan.cards.map((card) => card.name)).toEqual(['B', 'A', 'C'])
    expect(scan.cards[2]!.id).toBe(c.id)
  })

  it('beforeId 在列内插到目标卡片之前（列首 - 步长）', async () => {
    const a = await createRhythmCard(project(), seedOptions({ name: 'A', chapterRef: '第二卷/第081章' }))
    await createRhythmCard(project(), seedOptions({ name: 'B', chapterRef: '第二卷/第082章' }))
    const c = await createRhythmCard(project(), seedOptions({ name: 'C', chapterRef: '第二卷/第083章' }))

    const moved = await updateRhythmCard(project(), { id: c.id, beforeId: a.id })
    expect(moved.order).toBe(-100)

    const scan = await scanRhythmCards(project())
    expect(scan.cards.map((card) => card.name)).toEqual(['C', 'A', 'B'])
  })
})

describe('updateRhythmCard：实际值回写与偏差判定', () => {
  it('回写与计划一致的实际值 → written、无偏差', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    const updated = await updateRhythmCard(project(), {
      id: card.id,
      actualConflict: 3,
      actualMood: '温馨',
      actualHook: '无',
      actualPayoff: '收获',
      actualNote: '按计划落地',
    })

    expect(updated.status).toBe('written')
    expect(updated.deviationFlag).toBe(false)
    expect(updated.deviationNote).toBeNull()
    expect(updated.actualNote).toBe('按计划落地')
  })

  it('冲突强度差 3 命中阈值；差 2 不命中', async () => {
    const seeded = await createRhythmCard(project(), seedOptions())

    const hit = await updateRhythmCard(project(), { id: seeded.id, actualConflict: 6 })
    expect(hit.status).toBe('deviated')
    expect(hit.deviationFlag).toBe(true)
    expect(hit.deviationNote).toBe('冲突强度偏差：计划 3 实际 6')

    const miss = await updateRhythmCard(project(), { id: seeded.id, actualConflict: 5 })
    expect(miss.status).toBe('written')
    expect(miss.deviationFlag).toBe(false)
    expect(miss.deviationNote).toBeNull()
  })

  it('情绪基调不一致命中；一致不命中', async () => {
    const card = await createRhythmCard(project(), seedOptions())

    const hit = await updateRhythmCard(project(), { id: card.id, actualMood: '悲壮' })
    expect(hit.deviationFlag).toBe(true)
    expect(hit.deviationNote).toBe('情绪基调偏差：计划 温馨 实际 悲壮')

    const miss = await updateRhythmCard(project(), { id: card.id, actualMood: '温馨' })
    expect(miss.deviationFlag).toBe(false)
  })

  it('章末钩子有无翻转命中（两个方向）；都有但类型不同不命中', async () => {
    const card = await createRhythmCard(project(), seedOptions())

    const gain = await updateRhythmCard(project(), { id: card.id, actualHook: '悬念' })
    expect(gain.deviationFlag).toBe(true)
    expect(gain.deviationNote).toBe('章末钩子翻转：计划 无 实际 悬念')

    const withHook = await createRhythmCard(project(), seedOptions({ name: 'B', chapterRef: '第二卷/第084章', plannedHook: '悬念' }))

    const lose = await updateRhythmCard(project(), { id: withHook.id, actualHook: '无' })
    expect(lose.deviationFlag).toBe(true)
    expect(lose.deviationNote).toBe('章末钩子翻转：计划 悬念 实际 无')

    const swap = await updateRhythmCard(project(), { id: withHook.id, actualHook: '危机' })
    expect(swap.deviationFlag).toBe(false)
    expect(swap.status).toBe('written')
  })

  it('爽点类型不一致命中', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    const hit = await updateRhythmCard(project(), { id: card.id, actualPayoff: '无' })

    expect(hit.deviationFlag).toBe(true)
    expect(hit.deviationNote).toBe('爽点类型偏差：计划 收获 实际 无')
  })

  it('多维度命中时分号拼接；null 维度不参与比较', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    const hit = await updateRhythmCard(project(), {
      id: card.id,
      actualConflict: 7,
      actualHook: '悬念',
    })

    expect(hit.deviationNote).toBe('冲突强度偏差：计划 3 实际 7；章末钩子翻转：计划 无 实际 悬念')

    // 只回写情绪（conflict 保持 null）→ 只判情绪维度
    const moodOnly = await createRhythmCard(project(), seedOptions({ name: 'B', chapterRef: '第二卷/第084章' }))
    const hit2 = await updateRhythmCard(project(), { id: moodOnly.id, actualMood: '悲伤' })
    expect(hit2.deviationNote).toBe('情绪基调偏差：计划 温馨 实际 悲伤')
  })

  it('仅回写自评（非比较值）→ 不触发判定、保持 planned（阶段 4：自评不计入实际比较值）', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    const updated = await updateRhythmCard(project(), { id: card.id, actualNote: '节奏符合预期' })

    expect(updated.status).toBe('planned')
    expect(updated.deviationFlag).toBe(false)
    expect(updated.actualNote).toBe('节奏符合预期')
  })

  it('conflictThreshold 可覆盖默认阈值 3', async () => {
    const card = await createRhythmCard(project(), seedOptions())

    const miss = await updateRhythmCard(project(), { id: card.id, actualConflict: 6, conflictThreshold: 5 })
    expect(miss.deviationFlag).toBe(false)

    const hit = await updateRhythmCard(project(), { id: card.id, actualConflict: 8, conflictThreshold: 5 })
    expect(hit.deviationFlag).toBe(true)
    expect(hit.deviationNote).toBe('冲突强度偏差：计划 3 实际 8')
  })

  it('回写非法冲突强度拒绝；actualNote 空串按 null 清除', async () => {
    const card = await createRhythmCard(project(), seedOptions())

    await expect(updateRhythmCard(project(), { id: card.id, actualConflict: 12 }))
      .rejects.toThrow('actual_conflict 非法：12')

    const updated = await updateRhythmCard(project(), { id: card.id, actualNote: ' ' })
    expect(updated.actualNote).toBeNull()
  })

  it('状态自动流转：planned → written → deviated；清空 actual 回 planned', async () => {
    const card = await createRhythmCard(project(), seedOptions())

    const written = await updateRhythmCard(project(), { id: card.id, actualConflict: 4 })
    expect(written.status).toBe('written')

    const deviated = await updateRhythmCard(project(), { id: card.id, actualConflict: 9 })
    expect(deviated.status).toBe('deviated')
    expect(deviated.deviationFlag).toBe(true)

    // 只改计划值的更新不碰状态与偏差标记
    const untouched = await updateRhythmCard(project(), { id: card.id, plannedNote: '改计划' })
    expect(untouched.status).toBe('deviated')
    expect(untouched.deviationFlag).toBe(true)

    // 全部清除实际值 → 撤销回写，回到纯规划形态
    const reverted = await updateRhythmCard(project(), {
      id: card.id,
      actualConflict: null,
      actualMood: null,
      actualHook: null,
      actualPayoff: null,
      actualNote: null,
    })
    expect(reverted.status).toBe('planned')
    expect(reverted.deviationFlag).toBe(false)
    expect(reverted.deviationNote).toBeNull()
    expect(reverted.actualConflict).toBeNull()
  })

  it('部分清除实际值（仍有非 null）保持回写形态并重算偏差', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    await updateRhythmCard(project(), { id: card.id, actualConflict: 9, actualMood: '悲壮' })

    const partial = await updateRhythmCard(project(), { id: card.id, actualMood: null })
    expect(partial.status).toBe('deviated')
    expect(partial.actualMood).toBeNull()
    expect(partial.deviationNote).toBe('冲突强度偏差：计划 3 实际 9')
  })
})

describe('deleteRhythmCard', () => {
  it('移入回收站并删除原文件', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    const result = await deleteRhythmCard(project(), card.id)

    expect(result.trashPath.startsWith('.novel/trash/')).toBe(true)
    expect(Object.keys(collectFiles())).toEqual([result.trashPath])
  })

  it('删除不存在的节奏卡报错', async () => {
    await expect(deleteRhythmCard(project(), 'R-999')).rejects.toThrow('节奏卡不存在')
  })
})

describe('scanRhythmCards', () => {
  it('非法枚举/超界冲突强度进 issues，reason 指明字段，不中断扫描', async () => {
    const badMood = [
      '---',
      'id: R-001',
      'name: 坏卡',
      'planned_conflict: 3',
      'planned_mood: 豪横',
      'planned_hook: 无',
      'planned_payoff: 收获',
      '---',
      '',
      '## 节奏意图',
      '',
      '正文',
    ].join('\n')
    await writeProjectTextFile(root, 'rhythm/R-001-坏卡.md', badMood)

    const badConflict = badMood
      .replace('R-001', 'R-002')
      .replace('planned_mood: 豪横', 'planned_mood: 温馨')
      .replace('planned_conflict: 3', 'planned_conflict: 12')
    await writeProjectTextFile(root, 'rhythm/R-002-坏卡.md', badConflict)

    // 再放一张好卡，验证坏卡不阻塞扫描
    await createRhythmCard(project(), seedOptions({ name: '好卡', chapterRef: '第二卷/第084章', plannedConflict: 5 }))

    const scan = await scanRhythmCards(project())
    expect(scan.cards.map((card) => card.name)).toEqual(['好卡'])
    expect(scan.issues).toEqual([
      { kind: 'unreadable-file', path: 'rhythm/R-001-坏卡.md', reason: 'planned_mood 非法：豪横' },
      { kind: 'unreadable-file', path: 'rhythm/R-002-坏卡.md', reason: 'planned_conflict 非法：12（须为 1~10 的整数）' },
    ])
  })

  it('计划值齐全但缺 id 的手建文件兜底展示', async () => {
    const content = [
      '---',
      'name: 手建节奏卡',
      'planned_conflict: 3',
      'planned_mood: 温馨',
      'planned_hook: 无',
      'planned_payoff: 收获',
      '---',
      '',
      '## 节奏意图',
      '',
      '手写内容',
    ].join('\n')
    await writeProjectTextFile(root, 'rhythm/手建.md', content)

    const scan = await scanRhythmCards(project())
    expect(scan.cards).toHaveLength(1)
    expect(scan.cards[0]!.id).toMatch(/^rhythm-file-/)
    expect(scan.cards[0]!.name).toBe('手建节奏卡')
    expect(scan.cards[0]!.summary).toBe('手写内容')
  })

  it('同一 id 的重复文件报告不合并', async () => {
    const content = [
      '---',
      'id: R-001',
      'name: A',
      'planned_conflict: 3',
      'planned_mood: 温馨',
      'planned_hook: 无',
      'planned_payoff: 收获',
      '---',
      '',
      '## 节奏意图',
      '',
      'r',
    ].join('\n')
    await writeProjectTextFile(root, 'rhythm/R-001-甲.md', content)
    await writeProjectTextFile(root, 'rhythm/R-001-乙.md', content)

    const scan = await scanRhythmCards(project())
    expect(scan.cards).toHaveLength(2)
    expect(scan.issues).toEqual([
      { kind: 'duplicate-id', id: 'R-001', paths: ['rhythm/R-001-甲.md', 'rhythm/R-001-乙.md'] },
    ])
  })
})

describe('一章一卡守卫与完整视角副本（作者字段控制权计划阶段 3）', () => {
  it('创建撞已有章号被拒并指明已有卡片；全本章号语义（第083章 ≡ 第二卷/第083章-夜行）', async () => {
    await createRhythmCard(project(), seedOptions({ chapterRef: '第二卷/第083章-夜行' }))

    await expect(createRhythmCard(project(), seedOptions({ name: '撞章', chapterRef: '第083章' })))
      .rejects.toThrow('第83章 已有节奏卡「第083章节奏」（R-001）')
    await expect(createRhythmCard(project(), seedOptions({ name: '撞章', chapterRef: '第一卷/第83章-别的卷' })))
      .rejects.toThrow(RhythmError)

    // 不同章号照常创建
    const other = await createRhythmCard(project(), seedOptions({ name: '下一章', chapterRef: '第二卷/第084章' }))
    expect(other.id).toBe('R-002')
  })

  it('换章撞占用被拒且原文件无损；换到空闲章正常；保持原章改其他字段不触发', async () => {
    const a = await createRhythmCard(project(), seedOptions({ name: 'A', chapterRef: '第二卷/第081章' }))
    await createRhythmCard(project(), seedOptions({ name: 'B', chapterRef: '第二卷/第082章' }))

    await expect(updateRhythmCard(project(), { id: a.id, chapterRef: '第082章' }))
      .rejects.toThrow('第82章 已有节奏卡「B」（R-002）')
    expect(collectFiles()[a.sourcePath]).toBeTruthy()

    const moved = await updateRhythmCard(project(), { id: a.id, chapterRef: '第二卷/第090章' })
    expect(moved.chapterRef).toBe('第二卷/第090章')

    // 同章等价写法（带标题）视为保持原章，不判占用
    const renamed = await updateRhythmCard(project(), {
      id: a.id,
      chapterRef: '第二卷/第090章-新标题',
      plannedNote: '顺带改计划补充',
    })
    expect(renamed.chapterRef).toBe('第二卷/第090章-新标题')
    expect(renamed.plannedNote).toBe('顺带改计划补充')
  })

  it('历史同章重复数据（守卫之前的项目）不阻塞其他字段编辑，只在换章时拦', async () => {
    const content = (id: string, name: string) => [
      '---',
      `id: ${id}`,
      `name: ${name}`,
      'planned_conflict: 3',
      'planned_mood: 温馨',
      'planned_hook: 无',
      'planned_payoff: 收获',
      'chapter_ref: 第010章',
      '---',
      '',
      '## 节奏意图',
      '',
      '内容',
    ].join('\n')
    await writeProjectTextFile(root, 'rhythm/R-101-甲.md', content('R-101', '甲'))
    await writeProjectTextFile(root, 'rhythm/R-102-乙.md', content('R-102', '乙'))

    const updated = await updateRhythmCard(project(), { id: 'R-101', plannedConflict: 7 })
    expect(updated.plannedConflict).toBe(7)

    await expect(updateRhythmCard(project(), { id: 'R-101', chapterRef: '第010章-改名' }))
      .rejects.toThrow('第10章 已有节奏卡「乙」（R-102）')
  })

  it('完整视角副本：创建时携带实际值即判出 written/deviated；缺省为纯规划', async () => {
    const planned = await createRhythmCard(project(), seedOptions({ actualConflict: null }))
    expect(planned.status).toBe('planned')

    const written = await createRhythmCard(project(), seedOptions({
      name: '回写副本',
      chapterRef: '第二卷/第084章',
      actualConflict: 4,
      actualMood: '温馨',
      actualHook: '无',
      actualPayoff: '收获',
      actualNote: '按计划落地，读者反馈平稳',
    }))
    expect(written.status).toBe('written')
    expect(written.deviationFlag).toBe(false)
    expect(written.actualNote).toBe('按计划落地，读者反馈平稳')

    const deviated = await createRhythmCard(project(), seedOptions({
      name: '偏差副本',
      chapterRef: '第二卷/第085章',
      actualConflict: 9,
    }))
    expect(deviated.status).toBe('deviated')
    expect(deviated.deviationNote).toContain('冲突强度偏差')
  })
})

describe('判定来源与作者校正（阶段 4）', () => {
  /** 已回写并判偏差的卡：计划冲突 3、实际 7（阈值 3 → deviated） */
  async function createDeviated() {
    const card = await createRhythmCard(project(), seedOptions())
    return updateRhythmCard(project(), {
      id: card.id,
      actualConflict: 7,
      actualMood: '温馨',
      actualHook: '无',
      actualPayoff: '收获',
    })
  }

  it('旧文件无判定元数据：按 auto/null/null 解释，非判定保存不重算', async () => {
    const legacy = [
      '---',
      'id: R-201',
      'name: 旧卡',
      'status: written',
      'chapter_ref: 第020章',
      'planned_conflict: 3',
      'planned_mood: 温馨',
      'planned_hook: 无',
      'planned_payoff: 收获',
      'actual_conflict: 4',
      'actual_mood: null',
      'actual_hook: null',
      'actual_payoff: null',
      'actual_note: null',
      'deviation_flag: false',
      'deviation_note: null',
      '---',
      '',
      '## 节奏意图',
      '',
      '旧卡意图',
    ].join('\n')
    await writeProjectTextFile(root, 'rhythm/R-201-旧卡.md', legacy)

    const updated = await updateRhythmCard(project(), { id: 'R-201', name: '旧卡改名' })
    expect(updated.status).toBe('written')
    expect(updated.judgmentSource).toBe('auto')
    expect(updated.authorDeviationNote).toBeNull()
    expect(updated.lastJudgmentThreshold).toBeNull()

    // 保存后的文件补写判定来源元数据（按当前事实，auto/null），判定结果未被重算
    const onDisk = collectFiles()['rhythm/R-201-旧卡改名.md']!
    expect(onDisk).toContain('judgment_source: auto')
    expect(parseRhythmFile('rhythm/R-201-旧卡改名.md', onDisk).card.status).toBe('written')
  })

  it('作者校正应用：结论生效（来源 author、阈值记录），系统说明独立保留', async () => {
    const deviated = await createDeviated()
    const corrected = await updateRhythmCard(project(), {
      id: deviated.id,
      authorJudgment: { status: 'written', deviationFlag: false },
    })

    expect(corrected.status).toBe('written')
    expect(corrected.deviationFlag).toBe(false)
    expect(corrected.judgmentSource).toBe('author')
    expect(corrected.authorDeviationNote).toBeNull()
    expect(corrected.lastJudgmentThreshold).toBe(3)
    expect(corrected.deviationNote).toContain('冲突强度偏差')
  })

  it('有偏差必填说明并保存；无偏差清除旧作者说明', async () => {
    const card = await createDeviated()
    await expect(updateRhythmCard(project(), {
      id: card.id,
      authorJudgment: { status: 'deviated', deviationFlag: true },
    })).rejects.toThrow('必须填写偏差说明')

    const noted = await updateRhythmCard(project(), {
      id: card.id,
      authorJudgment: { status: 'deviated', deviationFlag: true, deviationNote: '  刻意升温，别动  ' },
    })
    expect(noted.authorDeviationNote).toBe('刻意升温，别动')

    const cleared = await updateRhythmCard(project(), {
      id: card.id,
      authorJudgment: { status: 'written', deviationFlag: false },
    })
    expect(cleared.authorDeviationNote).toBeNull()
  })

  it('校验表：规划中禁有偏差、偏差须有偏差结论；已写/偏差须至少一项实际比较值（自评不算）', async () => {
    const card = await createDeviated()
    await expect(updateRhythmCard(project(), {
      id: card.id,
      authorJudgment: { status: 'planned', deviationFlag: true, deviationNote: 'x' },
    })).rejects.toThrow('「规划中」只能搭配无偏差')
    await expect(updateRhythmCard(project(), {
      id: card.id,
      authorJudgment: { status: 'deviated', deviationFlag: false },
    })).rejects.toThrow('「偏差」必须搭配有偏差')

    // 清空全部实际值（仅留自评）后校正已写 → 被拦：自评不计入比较值
    await expect(updateRhythmCard(project(), {
      id: card.id,
      actualConflict: null,
      actualMood: null,
      actualHook: null,
      actualPayoff: null,
      actualNote: '只有自评',
      authorJudgment: { status: 'written', deviationFlag: false },
    })).rejects.toThrow('至少一项已填写')

    // 规划中允许保留已有实际值（校正分类不清空它们）
    const planned = await updateRhythmCard(project(), {
      id: card.id,
      authorJudgment: { status: 'planned', deviationFlag: false },
    })
    expect(planned.status).toBe('planned')
    expect(planned.actualConflict).toBe(7)
  })

  it('作者模式改非比较字段（名称/自评/正文）：人工结论原样保留', async () => {
    const card = await createDeviated()
    const corrected = await updateRhythmCard(project(), {
      id: card.id,
      authorJudgment: { status: 'deviated', deviationFlag: true, deviationNote: '刻意升温' },
    })

    const untouched = await updateRhythmCard(project(), {
      id: corrected.id,
      name: '改名后',
      actualNote: '作者补自评',
      intentBody: '新意图',
      expectedContentHash: hashContent(collectFiles()[corrected.sourcePath]!),
    })
    expect(untouched.status).toBe('deviated')
    expect(untouched.deviationFlag).toBe(true)
    expect(untouched.judgmentSource).toBe('author')
    expect(untouched.authorDeviationNote).toBe('刻意升温')
  })

  it('作者模式改比较值（实际或计划）：按新值重算并回到自动', async () => {
    const card = await createDeviated()
    const corrected = await updateRhythmCard(project(), {
      id: card.id,
      authorJudgment: { status: 'written', deviationFlag: false },
    })

    // 改实际比较值 → 重算回自动
    const backAuto = await updateRhythmCard(project(), { id: corrected.id, actualConflict: 4 })
    expect(backAuto.status).toBe('written')
    expect(backAuto.deviationFlag).toBe(false)
    expect(backAuto.judgmentSource).toBe('auto')
    expect(backAuto.lastJudgmentThreshold).toBe(3)

    // 再校正后改计划比较值 → 同样重算回自动（修复「已有实际值改计划不重算」）
    const corrected2 = await updateRhythmCard(project(), {
      id: backAuto.id,
      authorJudgment: { status: 'deviated', deviationFlag: true, deviationNote: '按作者口径' },
    })
    const plannedChanged = await updateRhythmCard(project(), { id: corrected2.id, plannedConflict: 5 })
    expect(plannedChanged.judgmentSource).toBe('auto')
    expect(plannedChanged.status).toBe('written')
    expect(plannedChanged.deviationNote).toBeNull()
  })

  it('自动卡已有实际值时改计划比较值：按最新比较值重算', async () => {
    const card = await createDeviated()
    const updated = await updateRhythmCard(project(), { id: card.id, plannedConflict: 7 })
    expect(updated.deviationFlag).toBe(false)
    expect(updated.status).toBe('written')
    expect(updated.lastJudgmentThreshold).toBe(3)
  })

  it('恢复自动判定：立即按最新值重算回 auto；作者说明保留为历史；与作者校正互斥', async () => {
    const card = await createDeviated()
    const corrected = await updateRhythmCard(project(), {
      id: card.id,
      authorJudgment: { status: 'deviated', deviationFlag: true, deviationNote: '作者口径' },
    })

    const restored = await updateRhythmCard(project(), { id: corrected.id, restoreAutoJudgment: true })
    expect(restored.judgmentSource).toBe('auto')
    expect(restored.status).toBe('deviated')
    expect(restored.authorDeviationNote).toBe('作者口径')
    expect(restored.lastJudgmentThreshold).toBe(3)

    // 全部实际值清空后恢复 → 规划中、无偏差、无系统说明
    const cleared = await updateRhythmCard(project(), {
      id: restored.id,
      actualConflict: null,
      actualMood: null,
      actualHook: null,
      actualPayoff: null,
      actualNote: null,
    })
    expect(cleared.status).toBe('planned')
    expect(cleared.deviationFlag).toBe(false)
    expect(cleared.deviationNote).toBeNull()

    await expect(updateRhythmCard(project(), {
      id: restored.id,
      authorJudgment: { status: 'written', deviationFlag: false },
      restoreAutoJudgment: true,
    })).rejects.toThrow('互斥')
  })

  it('阈值记录：判定保存记录当时阈值；阈值变化不批量重写其他卡', async () => {
    const card = await createDeviated()
    expect(card.lastJudgmentThreshold).toBe(3)

    const strict = await updateRhythmCard(project(), { id: card.id, plannedConflict: 5, conflictThreshold: 1 })
    expect(strict.lastJudgmentThreshold).toBe(1)

    // 另一张纯规划卡的非判定保存：不触发重算、不补记阈值（阈值变化不后台重写）
    const other = await createRhythmCard(project(), seedOptions({ name: '另一张', chapterRef: '第二卷/第090章' }))
    const otherTouched = await updateRhythmCard(project(), { id: other.id, name: '另一张改名', conflictThreshold: 1 })
    expect(otherTouched.status).toBe('planned')
    expect(otherTouched.judgmentSource).toBe('auto')
    expect(otherTouched.lastJudgmentThreshold).toBeNull()
  })

  it('副本携带人工判定：创建时 authorJudgment 覆盖自动结论', async () => {
    const copied = await createRhythmCard(project(), seedOptions({
      name: '作者判定副本',
      chapterRef: '第二卷/第084章',
      actualConflict: 7,
      authorJudgment: { status: 'written', deviationFlag: true, deviationNote: '作者认为可控' },
    }))
    expect(copied.status).toBe('written')
    expect(copied.deviationFlag).toBe(true)
    expect(copied.judgmentSource).toBe('author')
    expect(copied.authorDeviationNote).toBe('作者认为可控')
    expect(copied.deviationNote).toContain('冲突强度偏差')
    expect(copied.lastJudgmentThreshold).toBe(3)
  })
})

describe('跨列校正与落点（阶段 5）', () => {
  /** 已回写并判偏差的卡：计划冲突 3、实际 7（阈值 3 → deviated） */
  async function createDeviated() {
    const card = await createRhythmCard(project(), seedOptions())
    return updateRhythmCard(project(), {
      id: card.id,
      actualConflict: 7,
      actualMood: '温馨',
      actualHook: '无',
      actualPayoff: '收获',
    })
  }

  it('跨列校正 + 落点一次保存：状态、结论与目标列位置同轮落盘', async () => {
    // 已写列两张锚卡（创建 order 按 planned 列起点算，先同列重排拉开为 0 与 100）
    const anchorA = await createRhythmCard(project(), seedOptions({
      name: '锚A', chapterRef: '第二卷/第090章', actualConflict: 3, now: new Date('2026-11-01T00:00:00Z'),
    }))
    const anchorB = await createRhythmCard(project(), seedOptions({
      name: '锚B', chapterRef: '第二卷/第091章', actualConflict: 3, now: new Date('2026-11-02T00:00:00Z'),
    }))
    const anchored = await updateRhythmCard(project(), { id: anchorB.id, afterId: anchorA.id })
    expect(anchorA.status).toBe('written')
    expect(anchored.status).toBe('written')
    expect(anchorA.order).toBe(0)
    expect(anchored.order).toBe(100)

    const deviated = await createDeviated()
    const corrected = await updateRhythmCard(project(), {
      id: deviated.id,
      authorJudgment: { status: 'written', deviationFlag: false },
      afterId: anchorA.id,
    })

    expect(corrected.status).toBe('written')
    expect(corrected.judgmentSource).toBe('author')
    // 落点在锚A（order 0）与锚B（order 100）之间
    expect(corrected.order).toBe(50)
  })

  it('拖到规划中列首：只校正分类，实际值保留，order 落列首', async () => {
    const plannedAnchor = await createRhythmCard(project(), seedOptions({
      name: '规划锚', chapterRef: '第二卷/第090章', now: new Date('2026-11-01T00:00:00Z'),
    }))
    expect(plannedAnchor.order).toBe(0)

    const deviated = await createDeviated()
    const corrected = await updateRhythmCard(project(), {
      id: deviated.id,
      authorJudgment: { status: 'planned', deviationFlag: false },
      beforeId: null,
    })

    expect(corrected.status).toBe('planned')
    expect(corrected.actualConflict).toBe(7)
    expect(corrected.order).toBeLessThan(plannedAnchor.order)
  })

  it('无实际比较值时跨列校正已写/偏差被拦（自评不计入），规划中放行', async () => {
    const card = await createRhythmCard(project(), seedOptions({ actualNote: '只有自评' }))
    await expect(updateRhythmCard(project(), {
      id: card.id,
      authorJudgment: { status: 'written', deviationFlag: false },
      afterId: null,
    })).rejects.toThrow('至少一项已填写')

    const planned = await updateRhythmCard(project(), {
      id: card.id,
      authorJudgment: { status: 'planned', deviationFlag: false },
      afterId: null,
    })
    expect(planned.status).toBe('planned')
    expect(planned.order).toBe(0)
  })
})
