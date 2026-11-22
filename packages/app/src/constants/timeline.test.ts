import { describe, expect, it } from 'vitest'

import {
  chapterNumberOfPath,
  chapterTimelineEvents,
  type ChapterTimelineEventSummary,
} from './timeline'

const EVENTS: ChapterTimelineEventSummary[] = [
  { eventId: 'EVT-aaaaaaaaaa', title: '北境之战', kind: 'point', chapterNumbers: [1, 3] },
  { eventId: 'EVT-bbbbbbbbbb', title: '铁剑门兴起', kind: 'span', chapterNumbers: [2] },
  { eventId: 'EVT-cccccccccc', title: '无章节关联', kind: 'point', chapterNumbers: [] },
]

describe('chapterTimelineEvents（章节侧栏「本章相关事件」反查）', () => {
  it('按事件的章节关联实时反查；同一事件可关联多章', () => {
    expect(chapterTimelineEvents(EVENTS, 'chapters/第001章-风起.txt').map((event) => event.eventId))
      .toEqual(['EVT-aaaaaaaaaa'])
    expect(chapterTimelineEvents(EVENTS, 'chapters/第003章-转折.txt').map((event) => event.eventId))
      .toEqual(['EVT-aaaaaaaaaa'])
    expect(chapterTimelineEvents(EVENTS, 'chapters/第002章-门派.txt').map((event) => event.eventId))
      .toEqual(['EVT-bbbbbbbbbb'])
    expect(chapterTimelineEvents(EVENTS, 'chapters/第009章-未关联.txt')).toEqual([])
  })

  it('无选中章节或路径解析不出章号时返回空', () => {
    expect(chapterTimelineEvents(EVENTS, null)).toEqual([])
    expect(chapterTimelineEvents(EVENTS, undefined)).toEqual([])
    expect(chapterTimelineEvents(EVENTS, 'prompts/outline.md')).toEqual([])
  })

  it('章号解析：文件名形如 第NNN章-标题.txt；失败返回 null', () => {
    expect(chapterNumberOfPath('chapters/第012章-夜袭.txt')).toBe(12)
    expect(chapterNumberOfPath('chapters/番外-无章号.txt')).toBeNull()
  })
})
