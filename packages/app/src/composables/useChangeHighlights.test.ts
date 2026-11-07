import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  advanceHighlightCursor,
  buildPendingReplaceSegments,
  buildTextHighlightSegments,
  clearChangeHighlights,
  dismissHighlightJob,
  dismissChangeNotice,
  _getHighlightState,
  markdownBlockIndicesInRange,
  MAX_CHANGE_NOTICES,
  pushChangeNotice,
  replayHighlightJob,
  _setReducedMotionProbe,
  startHighlightJob,
  useChangeHighlights,
} from './useChangeHighlights'

const P = 'project-hl'

beforeEach(() => {
  vi.useFakeTimers()
  clearChangeHighlights(P)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('通知队列', () => {
  it('入队按序保留、按记录 id 去重、超限丢最老的', () => {
    for (let i = 0; i < MAX_CHANGE_NOTICES + 3; i += 1) {
      pushChangeNotice(P, {
        recordId: `r${i}`,
        path: `chapters/第001章-${i}.txt`,
        fileName: `第001章-${i}.txt`,
        status: 'updated',
        count: 1,
        canLocate: true,
      })
    }

    const state = _getHighlightState(P)
    expect(state.notices).toHaveLength(MAX_CHANGE_NOTICES)
    // 最老的 3 条被挤出
    expect(state.notices[0]?.recordId).toBe('r3')
    expect(state.notices[state.notices.length - 1]?.recordId).toBe(`r${MAX_CHANGE_NOTICES + 2}`)

    // 去重：同 id 再入队不增加
    pushChangeNotice(P, { recordId: 'r3', path: 'x', fileName: 'x', status: 'updated', count: 1, canLocate: true })
    expect(state.notices).toHaveLength(MAX_CHANGE_NOTICES)
  })

  it('dismissNotice 只移除指定通知', () => {
    pushChangeNotice(P, { recordId: 'a', path: 'a', fileName: 'a', status: 'updated', count: 1, canLocate: true })
    pushChangeNotice(P, { recordId: 'b', path: 'b', fileName: 'b', status: 'created', count: 1, canLocate: true })
    dismissChangeNotice(P, 'a')
    expect(_getHighlightState(P).notices.map((n) => n.recordId)).toEqual(['b'])
  })
})

describe('高亮任务状态机', () => {
  const params = {
    recordId: 'rec1',
    path: 'chapters/第001章-初遇.txt',
    ranges: [{ oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 }],
    oldText: '旧',
    mode: 'timed' as const,
  }

  it('timed 模式：show 经 2.5s 稳定进入 fading，再 1.2s 进入 settled', () => {
    startHighlightJob(P, params)
    const state = _getHighlightState(P)
    expect(state.job?.phase).toBe('show')

    vi.advanceTimersByTime(2500)
    expect(state.job?.phase).toBe('fading')

    vi.advanceTimersByTime(1200)
    expect(state.job?.phase).toBe('settled')
  })

  it('timed 模式 + 减少动态效果：不淡出，保持稳定显示', () => {
    _setReducedMotionProbe(() => true)
    try {
      startHighlightJob(P, params)
      vi.advanceTimersByTime(5000)
      expect(_getHighlightState(P).job?.phase).toBe('show')
    } finally {
      _setReducedMotionProbe(null)
    }
  })

  it('stable 模式（重播）：不安排淡出，保持 show', () => {
    startHighlightJob(P, { ...params, mode: 'stable' })
    vi.advanceTimersByTime(10000)
    expect(_getHighlightState(P).job?.phase).toBe('show')
  })

  it('新任务替换旧任务：旧任务定时器作废，新任务计时从头开始', () => {
    startHighlightJob(P, params)
    vi.advanceTimersByTime(2000)
    startHighlightJob(P, { ...params, recordId: 'rec2' })
    // 若旧定时器未作废，此刻已到 2500ms 阈值会立即进入 fading
    vi.advanceTimersByTime(1000)
    const state = _getHighlightState(P)
    expect(state.job?.recordId).toBe('rec2')
    expect(state.job?.phase).toBe('show')
    vi.advanceTimersByTime(1500 + 1200)
    expect(state.job?.phase).toBe('settled')
  })

  it('任务开始时同名通知出队（视为已查看）', () => {
    pushChangeNotice(P, { recordId: 'rec1', path: params.path, fileName: 'x', status: 'updated', count: 1, canLocate: true })
    startHighlightJob(P, params)
    expect(_getHighlightState(P).notices).toHaveLength(0)
  })

  it('dismissJob 清任务与对应通知', () => {
    pushChangeNotice(P, { recordId: 'rec1', path: params.path, fileName: 'x', status: 'updated', count: 1, canLocate: true })
    startHighlightJob(P, params)
    dismissHighlightJob(P)
    const state = _getHighlightState(P)
    expect(state.job).toBeNull()
    expect(state.notices).toHaveLength(0)
  })

  it('replayJob 以 stable 模式重播当前任务参数', () => {
    startHighlightJob(P, params)
    vi.advanceTimersByTime(2500 + 1200)
    expect(_getHighlightState(P).job?.phase).toBe('settled')

    replayHighlightJob(P)
    const job = _getHighlightState(P).job
    expect(job?.mode).toBe('stable')
    expect(job?.phase).toBe('show')
    expect(job?.recordId).toBe('rec1')
    expect(job?.cursor).toBe(0)
  })
})

describe('逐处切换游标', () => {
  it('多范围循环切换：下一处/上一处首尾环绕', () => {
    startHighlightJob(P, {
      recordId: 'rec',
      path: 'a.txt',
      ranges: [
        { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 },
        { oldStart: 5, oldEnd: 5, newStart: 5, newEnd: 5 },
        { oldStart: 9, oldEnd: 9, newStart: 9, newEnd: 9 },
      ],
      oldText: 'x',
      mode: 'stable',
    })
    expect(_getHighlightState(P).job?.cursor).toBe(0)
    advanceHighlightCursor(P, 1)
    advanceHighlightCursor(P, 1)
    expect(_getHighlightState(P).job?.cursor).toBe(2)
    advanceHighlightCursor(P, 1)
    expect(_getHighlightState(P).job?.cursor).toBe(0)
    advanceHighlightCursor(P, -1)
    expect(_getHighlightState(P).job?.cursor).toBe(2)
  })
})

describe('buildTextHighlightSegments（纯文本切分）', () => {
  const concat = (content: string, range: { oldStart: number; oldEnd: number; newStart: number; newEnd: number }, oldText: string) =>
    buildTextHighlightSegments(content, range, oldText)
      .filter((seg) => seg.kind !== 'red')
      .map((seg) => seg.text)
      .join('')

  it('单行替换：红段在前绿段在后，非红段拼接还原原文', () => {
    const content = 'l1\nl2\nl3'
    const segments = buildTextHighlightSegments(content, { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 }, 'l2')
    expect(segments).toEqual([
      { kind: 'plain', text: 'l1\n' },
      { kind: 'red', text: 'l2\n' },
      { kind: 'green', text: 'l2\n' },
      { kind: 'plain', text: 'l3' },
    ])
    expect(concat(content, { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 }, 'l2')).toBe(content)
  })

  it('纯插入：只有绿段，无红段', () => {
    // 在 'l1\nl3' 的第 2 行前插入 'X' → 当前内容 'l1\nX\nl3'
    const content = 'l1\nX\nl3'
    const range = { oldStart: 2, oldEnd: 1, newStart: 2, newEnd: 2 }
    const segments = buildTextHighlightSegments(content, range, '')
    expect(segments).toEqual([
      { kind: 'plain', text: 'l1\n' },
      { kind: 'green', text: 'X\n' },
      { kind: 'plain', text: 'l3' },
    ])
    expect(concat(content, range, '')).toBe(content)
  })

  it('删除：只有红段，定位在删除点（尾空行段为空时不产出）', () => {
    // 删除 'l1\nl2' 的第 2 行 → 当前内容 'l1\n'
    const content = 'l1\n'
    const range = { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 1 }
    const segments = buildTextHighlightSegments(content, range, 'l2')
    expect(segments).toEqual([
      { kind: 'plain', text: 'l1\n' },
      { kind: 'red', text: 'l2\n' },
    ])
    expect(concat(content, range, 'l2')).toBe(content)
  })

  it('高亮到文件末尾：不补多余尾换行', () => {
    const content = 'l1\nl2'
    const segments = buildTextHighlightSegments(content, { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 }, 'l2')
    expect(segments[segments.length - 1]).toEqual({ kind: 'green', text: 'l2' })
    expect(concat(content, { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 }, 'l2')).toBe(content)
  })

  it('空文件填充（CreateFile 语义）：整文件绿显', () => {
    const segments = buildTextHighlightSegments('', { oldStart: 1, oldEnd: 0, newStart: 1, newEnd: 0 }, '')
    expect(segments).toEqual([])
  })

  it('带尾换行的内容：绿段后保留尾空行的换行，拼接仍还原原文', () => {
    const content = 'l1\nl2\n'
    const range = { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 }
    const segments = buildTextHighlightSegments(content, range, 'l2')
    expect(segments).toEqual([
      { kind: 'plain', text: 'l1\n' },
      { kind: 'red', text: 'l2\n' },
      { kind: 'green', text: 'l2\n' },
    ])
    expect(concat(content, range, 'l2')).toBe(content)
  })
})

describe('markdownBlockIndicesInRange（源码行→块映射）', () => {
  it('命中范围相交的块（块 0 覆盖 0-2 行，块 1 覆盖 3-5 行）', () => {
    const starts = [0, 3]
    expect(markdownBlockIndicesInRange(starts, 6, { oldStart: 4, oldEnd: 4, newStart: 4, newEnd: 4 })).toEqual([1])
    // 跨两行的修改命中同块
    expect(markdownBlockIndicesInRange(starts, 6, { oldStart: 2, oldEnd: 4, newStart: 2, newEnd: 4 })).toEqual([0, 1])
  })

  it('删除（空新范围）：定位到插入点所在块', () => {
    const starts = [0, 3]
    expect(markdownBlockIndicesInRange(starts, 6, { oldStart: 4, oldEnd: 5, newStart: 4, newEnd: 3 })).toEqual([1])
  })

  it('末块延伸到文件末行', () => {
    const starts = [0, 3]
    expect(markdownBlockIndicesInRange(starts, 10, { oldStart: 9, oldEnd: 9, newStart: 9, newEnd: 9 })).toEqual([1])
  })
})

describe('buildPendingReplaceSegments（待确认写入预览切分，§8）', () => {
  /** 预览仍是当前文件内容：去掉绿段（尚未写盘的候选）后必须还原原内容（排版不变硬约束） */
  const concatOriginal = (segments: { kind: string; text: string }[]) =>
    segments.filter((seg) => seg.kind !== 'green').map((seg) => seg.text).join('')

  it('单处替换：原文红段 + 候选绿段，其余原样', () => {
    const content = '雨停了。\n蹙眉不语。\n夜深了。'
    const segments = buildPendingReplaceSegments(content, '蹙眉不语', '低头叹息', false)
    expect(segments).toEqual([
      { kind: 'plain', text: '雨停了。\n' },
      { kind: 'red', text: '蹙眉不语' },
      { kind: 'green', text: '低头叹息' },
      { kind: 'plain', text: '。\n夜深了。' },
    ])
    expect(concatOriginal(segments!)).toBe(content)
  })

  it('删除（newText 为空）：只有红段，无绿段', () => {
    const segments = buildPendingReplaceSegments('前句。删除我。后句。', '删除我', '', false)
    expect(segments).toEqual([
      { kind: 'plain', text: '前句。' },
      { kind: 'red', text: '删除我' },
      { kind: 'plain', text: '。后句。' },
    ])
    expect(concatOriginal(segments!)).toBe('前句。删除我。后句。')
  })

  it('replaceAll：所有出现处都切换（多出现处不漏）', () => {
    const content = 'A他说B他说C'
    const segments = buildPendingReplaceSegments(content, '他说', '她讲', true)
    expect(segments).toEqual([
      { kind: 'plain', text: 'A' },
      { kind: 'red', text: '他说' },
      { kind: 'green', text: '她讲' },
      { kind: 'plain', text: 'B' },
      { kind: 'red', text: '他说' },
      { kind: 'green', text: '她讲' },
      { kind: 'plain', text: 'C' },
    ])
    expect(concatOriginal(segments!)).toBe(content)
  })

  it('非 replaceAll 只切第一处，其余出现处保持原样', () => {
    const segments = buildPendingReplaceSegments('他说A他说', '他说', '她讲', false)
    expect(segments).toEqual([
      { kind: 'red', text: '他说' },
      { kind: 'green', text: '她讲' },
      { kind: 'plain', text: 'A他说' },
    ])
    expect(concatOriginal(segments!)).toBe('他说A他说')
  })

  it('候选原文缺失：返回 null（版本失配，调用方降级）', () => {
    expect(buildPendingReplaceSegments('完全不同的内容', '蹙眉不语', '低头叹息', false)).toBeNull()
  })

  it('空原文（空文件填充语义）：非空内容原样 plain，空内容整篇绿', () => {
    expect(buildPendingReplaceSegments('已有内容', '', '新文', false)).toEqual([{ kind: 'plain', text: '已有内容' }])
    expect(buildPendingReplaceSegments('', '', '新文', false)).toEqual([{ kind: 'green', text: '新文' }])
    expect(buildPendingReplaceSegments('', '', '', false)).toEqual([])
  })

  it('拼接不变式：多种替换形态下 plain+red 拼接还原原内容', () => {
    const content = 'xx替换点yy替换点zz'
    const cases = [
      { oldText: '替换点', newText: '新的话', replaceAll: false },
      { oldText: '替换点', newText: '新的话', replaceAll: true },
      { oldText: '替换点', newText: '', replaceAll: true },
    ]
    for (const { oldText, newText, replaceAll } of cases) {
      const segments = buildPendingReplaceSegments(content, oldText, newText, replaceAll)
      expect(segments).not.toBeNull()
      expect(concatOriginal(segments!)).toBe(content)
    }
  })
})

describe('组件侧入口', () => {
  it('useChangeHighlights 返回同一份响应式状态', () => {
    const a = useChangeHighlights(P)
    const b = useChangeHighlights(P)
    a.startJob({ recordId: 'x', path: 'p', ranges: [], oldText: '', mode: 'stable' })
    expect(b.state.job?.recordId).toBe('x')
  })
})
