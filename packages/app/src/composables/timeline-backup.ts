/**
 * 时间线事件草稿的浏览器持久化备份（时间线 JSON 化施工计划 §9.4：详情编辑接入
 * save-session）：与关系草稿备份（relation-backup）同一套机制——内存会话表是运行期
 * 权威状态，本模块把未落盘的事件详情草稿镜像到 localStorage，浏览器刷新后重新进入
 * 项目时按事件核对磁盘再决定回填/冲突/清理。
 *
 * 固定规则（与 relation-backup 一致）：
 * - 写入去抖；恢复不等于保存——只回填保存会话，绝不直接改写时间线账本；
 * - 保存成功或明确放弃时删除对应记录；记录携带草稿依据的事件版本令牌（按条冲突口径）。
 */

const STORAGE_PREFIX = 'novai-timeline-draft:'

/** 去抖窗口：事件字段编辑的高频改动合并成一次写入 */
const TIMELINE_BACKUP_DEBOUNCE_MS = 800

import type {
  RelativeTime,
  StoryTime,
  TimelineChapterRef,
  TimelineParticipant,
} from '@novai/core/types/timeline'

/** 事件详情草稿（编辑中的字段集；引用以稳定标识承载，与账本结构同构） */
export type TimelineEventDraft = {
  title: string
  summary: string
  storyTime: StoryTime | null
  relativeTime: RelativeTime | null
  participants: TimelineParticipant[]
  plotIds: string[]
  chapters: TimelineChapterRef[]
  causedBy: string[]
}

export type PersistedTimelineDraftRecord = {
  projectId: string
  eventId: string
  draft: TimelineEventDraft
  /** 草稿依据的事件版本令牌（恢复核对的基线；事件从未落盘时为空串） */
  baseVersion: string
  updatedAt: string
}

export function buildTimelineDraftKey(projectId: string, eventId: string): string {
  return `${STORAGE_PREFIX}${JSON.stringify([projectId, eventId])}`
}

/** 存储后端抽象：生产为 localStorage；测试可注入内存实现 */
export interface TimelineBackupStore {
  put(key: string, record: PersistedTimelineDraftRecord): void
  delete(key: string): void
  listByProject(projectId: string): PersistedTimelineDraftRecord[]
}

function createLocalStorageStore(): TimelineBackupStore {
  return {
    put(key, record) {
      try {
        localStorage.setItem(key, JSON.stringify(record))
      } catch (error) {
        console.warn('[novai] 时间线草稿备份写入失败', error)
      }
    },
    delete(key) {
      try {
        localStorage.removeItem(key)
      } catch (error) {
        console.warn('[novai] 时间线草稿备份删除失败', error)
      }
    },
    listByProject(projectId) {
      const records: PersistedTimelineDraftRecord[] = []
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index)
          if (!key || !key.startsWith(STORAGE_PREFIX)) {
            continue
          }
          const raw = localStorage.getItem(key)
          if (!raw) {
            continue
          }
          try {
            const record = JSON.parse(raw) as PersistedTimelineDraftRecord
            if (record.projectId === projectId) {
              records.push(record)
            }
          } catch {
            // 单条损坏记录跳过，不阻塞其余恢复
          }
        }
      } catch (error) {
        console.warn('[novai] 时间线草稿备份读取失败', error)
      }
      return records
    },
  }
}

/** 测试注入口：替换存储后端；传 null 恢复默认 */
let store: TimelineBackupStore = createStoreForEnvironment()

function createStoreForEnvironment(): TimelineBackupStore {
  if (typeof localStorage === 'undefined') {
    return {
      put() {},
      delete() {},
      listByProject() {
        return []
      },
    }
  }
  return createLocalStorageStore()
}

export function _setTimelineBackupStoreForTest(replacement: TimelineBackupStore | null): void {
  store = replacement ?? createStoreForEnvironment()
}

// ---------- 去抖写入 ----------

const pendingWrites = new Map<string, PersistedTimelineDraftRecord>()
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function scheduleTimelineBackup(
  projectId: string,
  eventId: string,
  entry: { draft: TimelineEventDraft; baseVersion: string },
): void {
  const key = buildTimelineDraftKey(projectId, eventId)
  pendingWrites.set(key, {
    projectId,
    eventId,
    draft: { ...entry.draft },
    baseVersion: entry.baseVersion,
    updatedAt: new Date().toISOString(),
  })
  const existing = debounceTimers.get(key)
  if (existing) {
    clearTimeout(existing)
  }
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key)
      const record = pendingWrites.get(key)
      if (record) {
        pendingWrites.delete(key)
        store.put(key, record)
      }
    }, TIMELINE_BACKUP_DEBOUNCE_MS),
  )
}

export function removeTimelineBackup(projectId: string, eventId: string): void {
  const key = buildTimelineDraftKey(projectId, eventId)
  const timer = debounceTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(key)
  }
  pendingWrites.delete(key)
  store.delete(key)
}

/** 读取某项目的全部持久化事件草稿（先落盘待写记录） */
export function loadProjectTimelineBackups(projectId: string): PersistedTimelineDraftRecord[] {
  for (const [key, record] of [...pendingWrites.entries()]) {
    if (record.projectId === projectId) {
      pendingWrites.delete(key)
      store.put(key, record)
    }
  }
  return store.listByProject(projectId)
}

/** 测试注入口：清空全部待写记录 */
export function _resetTimelineBackupForTest(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer)
  }
  debounceTimers.clear()
  pendingWrites.clear()
}
