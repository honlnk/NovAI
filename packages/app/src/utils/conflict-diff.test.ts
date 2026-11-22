import { describe, expect, it } from 'vitest'

import { buildConflictDiff, type ConflictDiffChangePair } from './conflict-diff'

/**
 * 正文冲突差异（修复批 2026-11-20 验收）：核心断言不是「两侧文本可还原」，
 * 而是「局部修改不被错误扩大成整段/整篇替换」——未改动段落必须留在上下文里，
 * 段内润色只突出实际变化的字。
 */

const PARA_HEAD = '第一段：夜色渐深，城门外的官道上已经没有行人。'
const PARA_TAIL = '第三段：他收剑入鞘，转身走进了那条无人的长街。'
const LONG_OLD = '夜色像一张巨大的幕布缓缓压下来，远处的山脊只剩下一道模糊的剪影，风从谷口灌进来，吹得火把明明灭灭。'
const LONG_NEW = '夜色像一张沉重的幕布缓缓压下来，远处的山脊只剩下一道朦胧的剪影，风从谷口灌进来，吹得火把明明灭灭。'

function changePairs(result: ReturnType<typeof buildConflictDiff>): ConflictDiffChangePair[] {
  return result.blocks.flatMap((block) => (block.kind === 'change' ? block.pairs : []))
}

describe('buildConflictDiff 中文正文差异', () => {
  it('长段落少量润色：只突出变化的字，未改动段落留在上下文（不扩大成整段替换）', () => {
    const draft = [PARA_HEAD, LONG_OLD, PARA_TAIL].join('\n')
    const disk = [PARA_HEAD, LONG_NEW, PARA_TAIL].join('\n')

    const result = buildConflictDiff(draft, disk)

    // 概览：只算 1 段修改，没有整篇 25+25 行的虚假对立
    expect(result.degraded).toBe(false)
    expect(result.stats).toEqual({ changed: 1, added: 0, removed: 0 })

    // 未改动段落是上下文（灰显），不进任何变更块
    const contextLines = result.blocks.flatMap((block) => (block.kind === 'context' ? block.lines : []))
    expect(contextLines).toEqual([PARA_HEAD, PARA_TAIL])

    // 变更块：一对相邻原/新段落，段内字级变换只标记「巨大→沉重」「模糊→朦胧」
    const pairs = changePairs(result)
    expect(pairs).toHaveLength(1)
    const pair = pairs[0]!
    expect(pair.old).toBe(LONG_OLD)
    expect(pair.new).toBe(LONG_NEW)
    expect(pair.inline).not.toBeNull()
    const segments = pair.inline!
    expect(segments.filter((s) => s.kind === 'del').map((s) => s.text).join('')).toBe('巨大模糊')
    expect(segments.filter((s) => s.kind === 'add').map((s) => s.text).join('')).toBe('沉重朦胧')
    // 未变化的前后缀仍是 same 段（局部修改不被扩大）
    expect(segments[0]!.kind).toBe('same')
    expect(segments[0]!.text).toBe('夜色像一张')
    expect(segments[segments.length - 1]!.kind).toBe('same')
    // 还原不变式：旧段 = same+del，新段 = same+add
    expect(segments.filter((s) => s.kind !== 'add').map((s) => s.text).join('')).toBe(LONG_OLD)
    expect(segments.filter((s) => s.kind !== 'del').map((s) => s.text).join('')).toBe(LONG_NEW)
  })

  it('段内多处修改：还原不变式成立，每个变化点各自成 del/add 段', () => {
    const old = '他推开门，屋里很暗，桌上放着一盏没点的灯。'
    const new_ = '他推开房门，屋内很暗，桌上摆着一盏未点的灯。'
    const result = buildConflictDiff(`前段\n${old}\n后段`, `前段\n${new_}\n后段`)
    const segments = changePairs(result)[0]!.inline!
    // 等价对齐路径可能不唯一（jsdiff 择优），断言不变式而非具体切分：
    // 多处修改各自成段（del 段数 ≥ 2），拼接可完整还原两侧
    expect(segments.filter((s) => s.kind === 'del').length).toBeGreaterThanOrEqual(2)
    expect(segments.filter((s) => s.kind !== 'add').map((s) => s.text).join('')).toBe(old)
    expect(segments.filter((s) => s.kind !== 'del').map((s) => s.text).join('')).toBe(new_)
    // 实际变化信号：被替换的「没」与新增的「未」各自命中
    expect(segments.filter((s) => s.kind === 'del').map((s) => s.text).join('')).toContain('没')
    expect(segments.filter((s) => s.kind === 'add').map((s) => s.text).join('')).toContain('未')
    expect(result.stats.changed).toBe(1)
  })

  it('纯增段与纯删段：单侧段落对', () => {
    const draft = [PARA_HEAD, PARA_TAIL].join('\n')
    const disk = [PARA_HEAD, '插入的新段落。', PARA_TAIL].join('\n')
    const added = buildConflictDiff(draft, disk)
    expect(added.stats).toEqual({ changed: 0, added: 1, removed: 0 })
    const addPair = changePairs(added)[0]!
    expect(addPair.old).toBeUndefined()
    expect(addPair.new).toBe('插入的新段落。')
    expect(addPair.inline).toBeNull()

    const draft2 = [PARA_HEAD, '将被删掉的段落。', PARA_TAIL].join('\n')
    const removed = buildConflictDiff(draft2, [PARA_HEAD, PARA_TAIL].join('\n'))
    expect(removed.stats).toEqual({ changed: 0, added: 0, removed: 1 })
    const removePair = changePairs(removed)[0]!
    expect(removePair.old).toBe('将被删掉的段落。')
    expect(removePair.new).toBeUndefined()
  })

  it('空文本与空行：空→内容全绿，内容→空全红，段间空行正常进上下文', () => {
    const toContent = buildConflictDiff('', '全新的一章。')
    expect(toContent.stats).toEqual({ changed: 0, added: 1, removed: 0 })
    expect(changePairs(toContent)[0]!.new).toBe('全新的一章。')

    const toEmpty = buildConflictDiff('被整章替换的旧内容', '')
    expect(toEmpty.stats).toEqual({ changed: 0, added: 0, removed: 1 })
    expect(changePairs(toEmpty)[0]!.old).toBe('被整章替换的旧内容')

    // 段间空行属于未改动内容，进上下文而不是被当成差异
    const withBlank = buildConflictDiff(
      `${PARA_HEAD}\n\n${LONG_OLD}\n\n${PARA_TAIL}`,
      `${PARA_HEAD}\n\n${LONG_NEW}\n\n${PARA_TAIL}`,
    )
    const contextLines = withBlank.blocks.flatMap((b) => (b.kind === 'context' ? b.lines : []))
    expect(contextLines).toEqual([PARA_HEAD, '', '', PARA_TAIL])
    expect(withBlank.stats.changed).toBe(1)
  })

  it('长未改动区折叠：首尾折叠、保留上下文、携带可展开的隐藏行', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `第${i + 1}段：保持原样。`)
    const draft = lines.join('\n')
    const disk = lines.map((line, i) => (i === 9 ? '第十段：AI 润色过。' : line)).join('\n')

    const result = buildConflictDiff(draft, disk)
    expect(result.stats.changed).toBe(1)

    // 结构：fold(文首 6 行) + context(3) + change(第十段) + context(3) + fold(文尾 7 行)
    expect(result.blocks.map((b) => b.kind)).toEqual(['fold', 'context', 'change', 'context', 'fold'])
    const headFold = result.blocks[0] as Extract<typeof result.blocks[number], { kind: 'fold' }>
    const headContext = result.blocks[1] as Extract<typeof result.blocks[number], { kind: 'context' }>
    const tailContext = result.blocks[3] as Extract<typeof result.blocks[number], { kind: 'context' }>
    const tailFold = result.blocks[4] as Extract<typeof result.blocks[number], { kind: 'fold' }>
    expect(headFold.count).toBe(6)
    expect(headFold.lines).toEqual(['第1段：保持原样。', '第2段：保持原样。', '第3段：保持原样。', '第4段：保持原样。', '第5段：保持原样。', '第6段：保持原样。'])
    expect(headContext.lines).toEqual(['第7段：保持原样。', '第8段：保持原样。', '第9段：保持原样。'])
    expect(tailContext.lines).toEqual(['第11段：保持原样。', '第12段：保持原样。', '第13段：保持原样。'])
    expect(tailFold.count).toBe(7)
    expect(tailFold.lines).toEqual(Array.from({ length: 7 }, (_, i) => `第${i + 14}段：保持原样。`))
  })

  it('两处修改之间的长间隔折叠为中段（上下文 3+3）', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `第${i + 1}段：保持原样。`)
    const draft = lines.join('\n')
    const disk = lines
      .map((line, i) => (i === 2 || i === 17 ? `${line}（润色）` : line))
      .join('\n')
    const result = buildConflictDiff(draft, disk)
    expect(result.stats.changed).toBe(2)
    // 结构：context(2) + change + context(3) + fold(中段 8 行) + context(3) + change + context(2)
    expect(result.blocks.map((b) => b.kind)).toEqual([
      'context', 'change', 'context', 'fold', 'context', 'change', 'context',
    ])
    const middleFold = result.blocks[3] as Extract<typeof result.blocks[number], { kind: 'fold' }>
    expect(middleFold.count).toBe(8)
    expect(middleFold.lines[0]).toBe('第7段：保持原样。')
    expect(middleFold.lines[middleFold.lines.length - 1]).toBe('第14段：保持原样。')
  })

  it('间隔不超过阈值的未改动区不折叠（变更之间直接展示）', () => {
    const draft = `${PARA_HEAD}\n${LONG_OLD}\n${PARA_TAIL}`
    const disk = `${PARA_HEAD}\n${LONG_NEW}\n${PARA_TAIL}`
    const result = buildConflictDiff(draft, disk)
    expect(result.blocks.some((b) => b.kind === 'fold')).toBe(false)
  })

  it('两侧完全一致：零差异', () => {
    const result = buildConflictDiff(PARA_HEAD, PARA_HEAD)
    expect(result.stats).toEqual({ changed: 0, added: 0, removed: 0 })
    expect(changePairs(result)).toHaveLength(0)
  })

  it('段内变换超预算：inline 为 null（整段红绿，不伪装字级精确）', () => {
    const old = '甲'.repeat(400)
    const next = '乙'.repeat(400)
    const result = buildConflictDiff(`前段\n${old}\n后段`, `前段\n${next}\n后段`)
    const pair = changePairs(result)[0]!
    expect(pair.inline).toBeNull()
    expect(pair.old).toBe(old)
    expect(pair.new).toBe(next)
  })

  it('整本量级完全不同文本：行级 diff 超预算明确降级，不伪装逐段对齐', () => {
    const left = Array.from({ length: 6_000 }, (_, i) => `旧稿第${i}段，内容完全不同。`).join('\n')
    const right = Array.from({ length: 6_000 }, (_, i) => `新稿第${i}行，风马牛不相及。`).join('\n')
    const result = buildConflictDiff(left, right)

    expect(result.degraded).toBe(true)
    expect(result.stats).toEqual({ changed: 0, added: 6_000, removed: 6_000 })
    // 截断保护：两侧各展示前 400 行，其余明确报告未显示
    expect(result.truncated).toEqual({ left: 5_600, right: 5_600 })
    const pairs = changePairs(result)
    expect(pairs).toHaveLength(800)
    expect(pairs.filter((p) => p.old !== undefined)).toHaveLength(400)
    expect(pairs.filter((p) => p.new !== undefined)).toHaveLength(400)
  })
})
