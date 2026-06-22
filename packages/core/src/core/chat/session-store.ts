import {
  readProjectTextFile,
  writeProjectTextFile,
  removeProjectFile,
  listFilesInDirectory,
} from '../fs/project-fs'
import type { ProjectSnapshot } from '../../types/project'
import type { ChatSessionState } from '../../types/chat'

/**
 * 会话持久化存储目录，落在 `.novel/sessions/` 下，与 `.novel/logs/`、`.novel/trash/`
 * 同级，遵循「NovAI 内部数据按功能分子目录」的现有约定。
 * writeProjectTextFile 会自动创建中间目录，无需预建。
 */
export const SESSIONS_DIR = '.novel/sessions'

/** 会话文件路径：`.novel/sessions/<sessionId>.json` */
export function buildSessionFilePath(sessionId: string) {
  return `${SESSIONS_DIR}/${sessionId}.json`
}

/**
 * 保存会话到项目文件系统。写前刷新 updatedAt，保证列表按最近更新排序。
 * 整对象 JSON 覆盖写——会话是状态快照，不需要追加（区别于 agent-log 的 jsonl）。
 */
export async function saveSession(
  project: ProjectSnapshot,
  session: ChatSessionState,
): Promise<void> {
  const stamped: ChatSessionState = {
    ...session,
    updatedAt: new Date().toISOString(),
  }
  const text = JSON.stringify(stamped, null, 2)
  await writeProjectTextFile(project.handle, buildSessionFilePath(session.sessionId), text)
}

/** 读取单个会话。文件缺失或解析失败时返回 null（兜底，不抛）。 */
export async function loadSession(
  project: ProjectSnapshot,
  sessionId: string,
): Promise<ChatSessionState | null> {
  try {
    const text = await readProjectTextFile(project.handle, buildSessionFilePath(sessionId))
    return parseSession(text)
  } catch {
    return null
  }
}

/** 删除会话文件。文件不存在时静默成功（removeEntry 对缺失条目本就抛错，这里吞掉）。 */
export async function deleteSessionFile(
  project: ProjectSnapshot,
  sessionId: string,
): Promise<void> {
  try {
    await removeProjectFile(project.handle, buildSessionFilePath(sessionId))
  } catch {
    // 文件已不存在视为删除成功
  }
}

/**
 * 列出项目下所有历史会话的摘要，按 updatedAt 降序（最近更新的在前）。
 *
 * 只打开 `.novel/sessions/` 这一个目录遍历文件，而非 rescanProject 的全树扫描——
 * 会话列表的瓶颈在章节数众多的项目里，全树扫描会遍历 chapters/、elements/ 等无关目录。
 * 单文件自包含、不维护 index.json，对齐 agent-log 哲学（会话量在小说项目里很小）。
 */
export async function listSessionMetas(
  project: ProjectSnapshot,
): Promise<SessionMeta[]> {
  const allPaths = await listFilesInDirectory(project.handle, SESSIONS_DIR)
  const sessionPaths = allPaths.filter((path) => path.endsWith('.json'))
  if (sessionPaths.length === 0) {
    return []
  }

  const metas = await Promise.all(
    sessionPaths.map(async (path) => {
      try {
        const text = await readProjectTextFile(project.handle, path)
        return parseSessionMeta(text)
      } catch {
        return null
      }
    }),
  )

  return metas
    .filter((meta): meta is SessionMeta => meta !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export type SessionMeta = {
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

/** 解析会话全文为完整状态。解析失败返回 null。 */
function parseSession(text: string): ChatSessionState | null {
  try {
    const parsed = JSON.parse(text) as ChatSessionState
    if (!parsed?.sessionId) {
      return null
    }
    return normalizeSession(parsed)
  } catch {
    return null
  }
}

/** 解析出列表展示所需的摘要字段，避免给前端塞完整消息体。 */
function parseSessionMeta(text: string): SessionMeta | null {
  const session = parseSession(text)
  if (!session) {
    return null
  }

  return {
    sessionId: session.sessionId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  }
}

/**
 * 容错归一化：兼容缺少 title/createdAt/updatedAt 的旧文件（理论上当前不存在，但落盘数据要稳）。
 */
function normalizeSession(session: ChatSessionState): ChatSessionState {
  const now = new Date().toISOString()
  return {
    ...session,
    title: session.title ?? '未命名对话',
    createdAt: session.createdAt ?? now,
    updatedAt: session.updatedAt ?? now,
  }
}
