/**
 * 章节侧栏「本章相关事件」反查（时间线JSON化改造计划 §十一）：
 * 按事件的章节关联（chapterNumbers）实时反查本章事件，不写入章节文件——
 * 与「本章相关伏笔 / 本章节奏卡」同一模式。
 */

/** 侧栏反查用的事件摘要（时间线 store 从账本视图派生的纯数据）。 */
export type ChapterTimelineEventSummary = {
  eventId: string
  title: string
  kind: 'point' | 'span'
  /** 事件关联的章号列表（叙述方式不参与反查：任何叙述方式都算本章相关） */
  chapterNumbers: number[]
}

/** 从章节文件路径解析章号（文件名形如 第NNN章-标题.txt；解析失败返回 null）。 */
export function chapterNumberOfPath(path: string): number | null {
  const match = /第(\d+)章/.exec(path)
  return match ? Number(match[1]) : null
}

/** 本章相关事件：事件关联章号包含本章章号（实时计算，不改任何文件）。 */
export function chapterTimelineEvents(
  events: readonly ChapterTimelineEventSummary[],
  chapterPath: string | null | undefined,
): ChapterTimelineEventSummary[] {
  if (!chapterPath) {
    return []
  }
  const chapter = chapterNumberOfPath(chapterPath)
  if (chapter === null) {
    return []
  }
  return events.filter((event) => event.chapterNumbers.includes(chapter))
}
