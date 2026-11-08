import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearRuntimeProjects,
  removeRuntimeProject,
  setRuntimeProject,
} from './project-runtime'
import {
  createForeshadowing,
  deleteForeshadowing,
  getForeshadowingBoard,
  listForeshadowingCards,
  readForeshadowing,
  updateForeshadowing,
} from './foreshadowing-service'
import { writeProjectTextFile } from '../core/fs/project-fs'
import { ForeshadowingConflictError } from '../types/foreshadowing'
import type { ProjectSnapshot } from '../types/project'

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

function createProjectSnapshot(id: string): ProjectSnapshot {
  const root = createDirectoryHandle({
    kind: 'directory',
    name: `${id}-root`,
    entries: new Map(),
  })

  return {
    id,
    name: id,
    rootName: root.name,
    handle: root as FileSystemDirectoryHandle,
    config: {} as ProjectSnapshot['config'],
    manifest: {} as ProjectSnapshot['manifest'],
    tree: [],
    metadata: {
      id,
      name: id,
      updatedAt: '',
      chapterCount: 0,
      elementCount: 0,
      wordCount: 0,
    },
  }
}

/* ---------- 测试 ---------- */

const PROJECT_A = 'foreshadowing-service-test-a'
const PROJECT_B = 'foreshadowing-service-test-b'

let snapshotA: ProjectSnapshot
let snapshotB: ProjectSnapshot

beforeEach(() => {
  clearRuntimeProjects()
  snapshotA = createProjectSnapshot(PROJECT_A)
  snapshotB = createProjectSnapshot(PROJECT_B)
  setRuntimeProject(snapshotA)
  setRuntimeProject(snapshotB)
})

afterEach(() => {
  clearRuntimeProjects()
})

/** 手写伏笔文件内容（frontmatter 字段序与 serializeForeshadowingCard 输出一致）。 */
function cardFile(options: {
  id: string
  name: string
  status: string
  order: number
  plantedAt?: string
  payoffWindow?: string
  relatedCharacters?: string
  isRedHerring?: string
  resolvedAt?: string
  readerView: string
  authorTruth?: string
}): string {
  const lines = [
    '---',
    `id: ${options.id}`,
    `name: ${options.name}`,
    `status: ${options.status}`,
    `planted_at: ${options.plantedAt ?? '第一卷/第001章'}`,
    `payoff_window: ${options.payoffWindow ?? 'null'}`,
    `related_characters: ${options.relatedCharacters ?? '[]'}`,
    'related_entities: []',
    'related_chapters: []',
    `is_red_herring: ${options.isRedHerring ?? 'false'}`,
    `resolved_at: ${options.resolvedAt ?? 'null'}`,
    'abandoned_reason: null',
    `order: ${options.order}`,
    'createdAt: 2026-11-01T00:00:00.000Z',
    'updatedAt: 2026-11-01T00:00:00.000Z',
    '---',
    '',
    '## 读者视角（当时可见事实）',
    '',
    options.readerView,
    '',
  ]

  if (options.authorTruth) {
    lines.push('## 作者真相', '', options.authorTruth, '')
  }

  return lines.join('\n')
}

describe('getForeshadowingBoard', () => {
  it('旧项目无 foreshadowing 目录：六列全空、无异常，不抛错', async () => {
    const board = await getForeshadowingBoard(PROJECT_A)

    expect(Object.keys(board.columns)).toEqual([
      'planted',
      'hinted',
      'developed',
      'revealed',
      'resolved',
      'abandoned',
    ])
    for (const cards of Object.values(board.columns)) {
      expect(cards).toEqual([])
    }
    expect(board.issues).toEqual([])
  })

  it('看板视图按状态归列且列内有序；摘要携带回收窗口与红鲱鱼标记，不含正文分节', async () => {
    await writeProjectTextFile(
      snapshotA.handle,
      'foreshadowing/F-001-锈钥匙.md',
      cardFile({
        id: 'F-001',
        name: '锈钥匙',
        status: 'planted',
        order: 100,
        plantedAt: '第一卷/第003章',
        payoffWindow: '[第一卷/第020章, 第一卷/第030章]',
        relatedCharacters: '[林凡]',
        readerView: '门后挂着一把锈钥匙。',
        authorTruth: '钥匙能打开地下密室。',
      }),
    )
    await writeProjectTextFile(
      snapshotA.handle,
      'foreshadowing/F-002-北方灯塔.md',
      cardFile({
        id: 'F-002',
        name: '北方灯塔',
        status: 'planted',
        order: 50,
        readerView: '酒馆老板又提起了北方的灯塔。',
      }),
    )
    await writeProjectTextFile(
      snapshotA.handle,
      'foreshadowing/F-003-火漆印.md',
      cardFile({
        id: 'F-003',
        name: '信中的火漆印',
        status: 'hinted',
        order: 0,
        readerView: '信封上有一枚陌生的火漆印。',
      }),
    )
    await writeProjectTextFile(
      snapshotA.handle,
      'foreshadowing/F-004-假线索.md',
      cardFile({
        id: 'F-004',
        name: '管家偷听',
        status: 'resolved',
        order: 0,
        resolvedAt: '第一卷/第018章',
        isRedHerring: 'true',
        readerView: '管家深夜在书房外偷听。',
      }),
    )

    const board = await getForeshadowingBoard(PROJECT_A)

    // 列内 order 升序；未出现的状态列常驻为空
    expect(board.columns.planted.map((card) => card.id)).toEqual(['F-002', 'F-001'])
    expect(board.columns.hinted.map((card) => card.id)).toEqual(['F-003'])
    expect(board.columns.resolved.map((card) => card.id)).toEqual(['F-004'])
    expect(board.columns.developed).toEqual([])
    expect(board.columns.revealed).toEqual([])
    expect(board.columns.abandoned).toEqual([])

    // 摘要字段：看板卡片与「该收了」高亮所需
    expect(board.columns.planted[1]).toMatchObject({
      id: 'F-001',
      name: '锈钥匙',
      status: 'planted',
      plantedAt: '第一卷/第003章',
      payoffWindow: ['第一卷/第020章', '第一卷/第030章'],
      isRedHerring: false,
      summary: '门后挂着一把锈钥匙。',
      sourcePath: 'foreshadowing/F-001-锈钥匙.md',
    })
    expect(board.columns.resolved[0]).toMatchObject({
      name: '管家偷听',
      isRedHerring: true,
      plantedAt: '第一卷/第001章',
    })
    // 摘要不携带回收章节与放弃原因（详情视图才有）
    expect((board.columns.resolved[0] as Record<string, unknown>).resolvedAt).toBeUndefined()

    // 摘要不携带正文分节与真相
    expect((board.columns.planted[0] as Record<string, unknown>).readerBody).toBeUndefined()
    expect((board.columns.planted[0] as Record<string, unknown>).authorTruth).toBeUndefined()
  })

  it('重复标识进入 issues 报告', async () => {
    await writeProjectTextFile(
      snapshotA.handle,
      'foreshadowing/F-009-甲.md',
      cardFile({ id: 'F-009', name: '甲', status: 'planted', order: 0, readerView: 'r' }),
    )
    await writeProjectTextFile(
      snapshotA.handle,
      'foreshadowing/F-009-乙.md',
      cardFile({ id: 'F-009', name: '乙', status: 'planted', order: 1, readerView: 'r' }),
    )

    const board = await getForeshadowingBoard(PROJECT_A)

    expect(board.issues).toHaveLength(1)
    expect(board.issues[0]).toMatchObject({ kind: 'duplicate-id', id: 'F-009' })
  })
})

describe('listForeshadowingCards', () => {
  it('可按状态筛选；返回摘要字段不返回正文分节；项目隔离', async () => {
    await createForeshadowing(PROJECT_A, {
      name: '伏笔一',
      readerView: '读者可见事实一。',
      plantedAt: '第一卷/第001章',
    })
    const hinted = await createForeshadowing(PROJECT_A, {
      name: '伏笔二',
      readerView: '读者可见事实二。',
      plantedAt: '第一卷/第002章',
      status: 'hinted',
    })

    const all = await listForeshadowingCards(PROJECT_A)
    const hintedOnly = await listForeshadowingCards(PROJECT_A, 'hinted')

    expect(all.map((card) => card.id).sort()).toEqual([hinted.id, 'F-001'].sort())
    expect(hintedOnly.map((card) => card.id)).toEqual([hinted.id])
    expect(hintedOnly[0]).toMatchObject({
      name: '伏笔二',
      status: 'hinted',
      summary: '读者可见事实二。',
      plantedAt: '第一卷/第002章',
    })
    expect((hintedOnly[0] as Record<string, unknown>).readerBody).toBeUndefined()

    // 项目隔离：A 项目的伏笔不出现在 B 项目
    expect(await listForeshadowingCards(PROJECT_B)).toEqual([])
    expect((await getForeshadowingBoard(PROJECT_B)).columns.planted).toEqual([])
  })
})

describe('readForeshadowing / createForeshadowing', () => {
  it('createForeshadowing：F-001 起步、文件落在 foreshadowing/、view 带正文分节与 contentHash', async () => {
    const created = await createForeshadowing(PROJECT_A, {
      name: '旧照片之谜',
      readerView: '主角在旧书店发现一张褪色的照片。',
      authorTruth: '主角是研究员的复制体。',
      plantedAt: '第一卷/第012章',
      payoffWindow: ['第二卷/第080章', '第二卷/第090章'],
      relatedCharacters: ['主角', '母亲'],
    })

    expect(created.id).toBe('F-001')
    expect(created.sourcePath).toBe('foreshadowing/F-001-旧照片之谜.md')
    expect(created.payoffWindow).toEqual(['第二卷/第080章', '第二卷/第090章'])
    expect(created.relatedCharacters).toEqual(['主角', '母亲'])
    expect(created.contentHash).toBeTruthy()

    // 正文分节：读者侧与真相分开；真相直接可见（UI 是作者本人的界面）
    expect(created.readerBody).toBe('## 读者视角（当时可见事实）\n\n主角在旧书店发现一张褪色的照片。')
    expect(created.authorTruth).toBe('主角是研究员的复制体。')
    expect(created.readerBody).not.toContain('复制体')
    expect(created.summary).toBe('主角在旧书店发现一张褪色的照片。')

    // hash 与落盘内容一致：重读可回传做冲突检测
    const reread = await readForeshadowing(PROJECT_A, created.id)
    expect(reread?.contentHash).toBe(created.contentHash)
    expect(reread?.authorTruth).toBe(created.authorTruth)
    expect(reread?.readerBody).toBe(created.readerBody)

    // 第二条序号顺延
    const second = await createForeshadowing(PROJECT_A, {
      name: '第二条',
      readerView: 'r',
      plantedAt: '第一卷/第013章',
    })
    expect(second.id).toBe('F-002')
  })

  it('readForeshadowing 读不到返回 null', async () => {
    expect(await readForeshadowing(PROJECT_A, 'F-999')).toBeNull()
  })

  it('名/读者视角/埋设章节缺失时拒绝创建', async () => {
    await expect(createForeshadowing(PROJECT_A, { name: ' ', readerView: 'r', plantedAt: 'x' }))
      .rejects.toThrow('伏笔名不能为空')
    await expect(createForeshadowing(PROJECT_A, { name: 'A', readerView: ' ', plantedAt: 'x' }))
      .rejects.toThrow('读者视角不能为空')
    await expect(createForeshadowing(PROJECT_A, { name: 'A', readerView: 'r', plantedAt: ' ' }))
      .rejects.toThrow('埋设章节不能为空')
  })
})

describe('updateForeshadowing', () => {
  async function seed() {
    return createForeshadowing(PROJECT_A, {
      name: '旧照片之谜',
      readerView: '主角在旧书店发现一张褪色的照片。',
      authorTruth: '主角是研究员的复制体。',
      plantedAt: '第一卷/第012章',
    })
  }

  it('读不到的伏笔报错', async () => {
    await expect(updateForeshadowing(PROJECT_A, { id: 'F-999', status: 'hinted' }))
      .rejects.toThrow('伏笔不存在')
  })

  it('改 readerView 带最新 hash 成功；作者真相原样保留', async () => {
    const created = await seed()
    const read = await readForeshadowing(PROJECT_A, created.id)

    const updated = await updateForeshadowing(PROJECT_A, {
      id: created.id,
      readerView: '新的读者可见事实。',
      expectedContentHash: read!.contentHash,
    })

    expect(updated.readerBody).toBe('## 读者视角（当时可见事实）\n\n新的读者可见事实。')
    expect(updated.authorTruth).toBe('主角是研究员的复制体。')
    expect(updated.contentHash).not.toBe(read!.contentHash)

    // 新 hash 可继续保存（后续保存不回归）
    const again = await updateForeshadowing(PROJECT_A, {
      id: created.id,
      readerView: '第二版读者可见事实。',
      expectedContentHash: updated.contentHash,
    })
    expect(again.readerBody).toBe('## 读者视角（当时可见事实）\n\n第二版读者可见事实。')
  })

  it('外部修改后带旧 hash 保存抛冲突；手动直接保存（无 hash）成功', async () => {
    const created = await seed()
    const read = await readForeshadowing(PROJECT_A, created.id)

    // 外部编辑器改文件：重写为另一版内容（hash 随之变化）
    await writeProjectTextFile(
      snapshotA.handle,
      created.sourcePath,
      cardFile({
        id: created.id,
        name: '旧照片之谜',
        status: 'planted',
        order: 0,
        readerView: '外部改动后的读者视角。',
        authorTruth: '外部改动后的真相。',
      }),
    )

    await expect(
      updateForeshadowing(PROJECT_A, {
        id: created.id,
        readerView: '面板保存的读者视角。',
        expectedContentHash: read!.contentHash,
      }),
    ).rejects.toThrow(ForeshadowingConflictError)

    // 手动面板不传 hash：直接保存（面板保存前有自己的冲突提示流程，与计划服务层一致）
    const saved = await updateForeshadowing(PROJECT_A, {
      id: created.id,
      readerView: '面板保存的读者视角。',
    })
    expect(saved.readerBody).toBe('## 读者视角（当时可见事实）\n\n面板保存的读者视角。')
    expect(saved.authorTruth).toBe('外部改动后的真相。')
  })

  it('只改状态不需要 hash；两节正文原样保留', async () => {
    const created = await seed()

    const updated = await updateForeshadowing(PROJECT_A, { id: created.id, status: 'hinted' })

    expect(updated.status).toBe('hinted')
    expect(updated.readerBody).toBe(created.readerBody)
    expect(updated.authorTruth).toBe(created.authorTruth)
  })

  it('改名后 sourcePath 重命名（F-XXX 前缀不变）；按 id 重读不丢', async () => {
    const created = await seed()
    const oldPath = created.sourcePath

    const updated = await updateForeshadowing(PROJECT_A, {
      id: created.id,
      name: '母亲的沉默',
      expectedContentHash: created.contentHash,
    })

    expect(updated.id).toBe(created.id)
    expect(updated.sourcePath).toBe('foreshadowing/F-001-母亲的沉默.md')
    expect(updated.sourcePath).not.toBe(oldPath)

    // 旧路径文件已移除；按 ID 重读定位到新路径
    const paths = (await listForeshadowingCards(PROJECT_A)).map((card) => card.sourcePath)
    expect(paths).toEqual([updated.sourcePath])
    const reread = await readForeshadowing(PROJECT_A, created.id)
    expect(reread?.sourcePath).toBe(updated.sourcePath)
    expect(reread?.contentHash).toBe(updated.contentHash)
  })

  it('放弃必须给原因（core 层校验透传）', async () => {
    const created = await seed()

    await expect(updateForeshadowing(PROJECT_A, { id: created.id, status: 'abandoned' }))
      .rejects.toThrow('放弃伏笔必须登记原因')

    const abandoned = await updateForeshadowing(PROJECT_A, {
      id: created.id,
      status: 'abandoned',
      abandonedReason: '剧情改版，照片线索并入其他伏笔',
    })
    expect(abandoned.status).toBe('abandoned')
    expect(abandoned.abandonedReason).toBe('剧情改版，照片线索并入其他伏笔')
  })
})

describe('deleteForeshadowing', () => {
  it('移入回收站并从看板消失', async () => {
    const created = await createForeshadowing(PROJECT_A, {
      name: '将被删除',
      readerView: 'r',
      plantedAt: '第一卷/第001章',
    })

    const result = await deleteForeshadowing(PROJECT_A, created.id)

    expect(result.trashPath).toMatch(/^\.novel\/trash\//)
    expect(result.card.id).toBe(created.id)
    expect(await readForeshadowing(PROJECT_A, created.id)).toBeNull()
    expect(await listForeshadowingCards(PROJECT_A)).toEqual([])
    expect((await getForeshadowingBoard(PROJECT_A)).columns.planted).toEqual([])
  })

  it('删除不存在的伏笔报错', async () => {
    await expect(deleteForeshadowing(PROJECT_A, 'F-999')).rejects.toThrow('伏笔不存在')
  })
})

describe('项目运行时隔离', () => {
  it('未打开的项目：报「项目未打开」', async () => {
    removeRuntimeProject(PROJECT_B)

    await expect(getForeshadowingBoard(PROJECT_B)).rejects.toThrow('项目未打开或运行时已释放')
  })
})
