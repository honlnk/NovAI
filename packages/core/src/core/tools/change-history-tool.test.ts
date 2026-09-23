import { describe, expect, it } from 'vitest'

import { getFileChangeHistoryTool } from './change-history-tool'
import type { FileChangeRecord } from '../../types/chat'
import type { ProjectSnapshot } from '../../types/project'

/**
 * GetFileChangeHistory（文档 3 S7）测试：返回格式、过滤、limit 钳制、空账本文案。
 */

function record(input: {
  id: string
  runId?: string
  at?: string
  change: FileChangeRecord['change']
  diff?: FileChangeRecord['diff']
}): FileChangeRecord {
  return {
    id: input.id,
    runId: input.runId ?? 'run-1',
    at: input.at ?? '2026-09-19T08:00:00.000Z',
    change: input.change,
    ...(input.diff ? { diff: input.diff } : {}),
  }
}

function runtimeWith(ledger: FileChangeRecord[]) {
  return {
    project: {} as ProjectSnapshot,
    getChangeLedger: () => ledger,
  }
}

const fixtures: FileChangeRecord[] = [
  record({
    id: 'c1',
    runId: 'run-1',
    at: '2026-09-19T08:00:03.000Z',
    change: { type: 'created', path: 'chapters/第001章.txt' },
    diff: { oldText: '', newText: '第一行\n第二行', linesAdded: 2, linesRemoved: 0 },
  }),
  record({
    id: 'c2',
    runId: 'run-1',
    at: '2026-09-19T08:01:00.000Z',
    change: { type: 'updated', path: 'chapters/第001章.txt' },
    diff: { oldText: '旧', newText: '新', linesAdded: 1, linesRemoved: 1 },
  }),
  record({
    id: 'c3',
    runId: 'run-2',
    at: '2026-09-19T09:00:00.000Z',
    change: { type: 'renamed', fromPath: '草稿/旧名.md', toPath: '正文/新名.md' },
  }),
  record({
    id: 'c4',
    runId: 'run-2',
    at: '2026-09-19T09:05:00.000Z',
    change: { type: 'deleted', path: '草稿/废弃.txt', trashPath: '.novel/trash/废弃.txt' },
  }),
]

describe('GetFileChangeHistory 工具', () => {
  it('默认：新→旧逐条列出，末尾共 N 条记录', async () => {
    const input = getFileChangeHistoryTool.validateInput({})
    const output = await getFileChangeHistoryTool.run(input, runtimeWith(fixtures))

    expect(output.totalCount).toBe(4)
    expect(output.returnedCount).toBe(4)
    const lines = output.content.split('\n')
    expect(lines).toHaveLength(5)
    // 新→旧：c4 最前，c1 最后
    expect(lines[0]).toContain('删除 草稿/废弃.txt')
    expect(lines[1]).toContain('改名 草稿/旧名.md → 正文/新名.md')
    expect(lines[2]).toContain('修改 chapters/第001章.txt (+1 −1)')
    expect(lines[3]).toContain('新建 chapters/第001章.txt (+2 −0)')
    expect(lines[4]).toBe('共 4 条记录')
    // 时间前缀格式 [MM-DD HH:mm]
    expect(lines[0]).toMatch(/^\[\d{2}-\d{2} \d{2}:\d{2}\] /)
  })

  it('path 过滤：改名匹配前后路径；runId 过滤只看某轮', async () => {
    const byNewPath = getFileChangeHistoryTool.validateInput({ path: '正文/新名.md' })
    const out1 = await getFileChangeHistoryTool.run(byNewPath, runtimeWith(fixtures))
    expect(out1.totalCount).toBe(1)
    expect(out1.content).toContain('改名')

    const byOldPath = getFileChangeHistoryTool.validateInput({ path: '草稿/旧名.md' })
    const out2 = await getFileChangeHistoryTool.run(byOldPath, runtimeWith(fixtures))
    expect(out2.totalCount).toBe(1)

    const byRun = getFileChangeHistoryTool.validateInput({ runId: 'run-2' })
    const out3 = await getFileChangeHistoryTool.run(byRun, runtimeWith(fixtures))
    expect(out3.totalCount).toBe(2)
    expect(out3.content).toContain('共 2 条记录')

    const noMatch = getFileChangeHistoryTool.validateInput({ path: '不存在.md' })
    const out4 = await getFileChangeHistoryTool.run(noMatch, runtimeWith(fixtures))
    expect(out4.returnedCount).toBe(0)
    expect(out4.content).toBe('没有匹配条件的文件修改记录。')
  })

  it('limit：默认 20，钳制到 1-100；超限时提示可过滤', async () => {
    expect(getFileChangeHistoryTool.validateInput({}).limit).toBe(20)
    expect(getFileChangeHistoryTool.validateInput({ limit: 0 }).limit).toBe(1)
    expect(getFileChangeHistoryTool.validateInput({ limit: 999 }).limit).toBe(100)

    const input = getFileChangeHistoryTool.validateInput({ limit: 2 })
    const output = await getFileChangeHistoryTool.run(input, runtimeWith(fixtures))
    expect(output.returnedCount).toBe(2)
    expect(output.totalCount).toBe(4)
    expect(output.content).toContain('仅显示最近 2 条')
  })

  it('历史账本里的旧净差口径数字：输出按片段实时重算（存的 +0−0 显示为 +1−1）', async () => {
    const stale = [
      record({
        id: 'old1',
        change: { type: 'updated', path: 'elements/characters/鸿影.md' },
        // 旧口径账本：一行换一行存的是净差 +0 −0
        diff: { oldText: '旧句', newText: '新句', linesAdded: 0, linesRemoved: 0 },
      }),
    ]
    const input = getFileChangeHistoryTool.validateInput({})
    const output = await getFileChangeHistoryTool.run(input, runtimeWith(stale))

    expect(output.content).toContain('修改 elements/characters/鸿影.md (+1 −1)')
  })

  it('空账本：明说暂无记录', async () => {
    const input = getFileChangeHistoryTool.validateInput({})
    const output = await getFileChangeHistoryTool.run(input, runtimeWith([]))
    expect(output.content).toBe('本会话暂无文件修改记录。')
    expect(getFileChangeHistoryTool.summarizeOutput(output)).toBe('本会话暂无文件修改记录')
  })

  it('账本 getter 读时取最新（不可变重建后的新数组可见）', async () => {
    let ledger: FileChangeRecord[] = []
    const runtime = {
      project: {} as ProjectSnapshot,
      getChangeLedger: () => ledger,
    }
    const input = getFileChangeHistoryTool.validateInput({})

    const before = await getFileChangeHistoryTool.run(input, runtime)
    expect(before.totalCount).toBe(0)

    ledger = [...ledger, fixtures[0]]
    const after = await getFileChangeHistoryTool.run(input, runtime)
    expect(after.totalCount).toBe(1)
  })
})
