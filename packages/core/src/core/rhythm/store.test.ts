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
  it('更新计划值不改状态（作者手动改计划不动 written/deviated）', async () => {
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

  it('仅回写自评（非偏差维度）→ written 且不判偏差', async () => {
    const card = await createRhythmCard(project(), seedOptions())
    const updated = await updateRhythmCard(project(), { id: card.id, actualNote: '节奏符合预期' })

    expect(updated.status).toBe('written')
    expect(updated.deviationFlag).toBe(false)
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
