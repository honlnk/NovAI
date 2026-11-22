import { parseSkillFile } from './frontmatter'
import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FILE_NAME,
  SKILL_MANIFEST_MAX_FILES,
  SKILLS_DIRECTORY,
  classifySkillFile,
  type SkillDiagnostic,
  type SkillDiscoveryOutcome,
  type SkillFileEntry,
  type SkillMetadata,
} from './types'
import type { ProjectSnapshot } from '../../types/project'

/**
 * 技能发现（《技能包底层能力施工计划》§3.1–3.3）：遍历项目根 `skills/` 的直接
 * 子文件夹，含 `SKILL.md`（大小写精确）者为技能候选；解析 frontmatter、产出
 * 包内清单与诊断。
 *
 * 遍历走活句柄（`skills/` 子树）而非快照 `project.tree`（施工偏差，见施工日志）：
 * 快照树在 AI 同轮新建/修改后不刷新，无法满足「LoadSkill 每次调用重新发现、
 * 同轮新建立即可加载」；只扫 `skills/` 子树，成本远小于全树重扫（对齐 timeline
 * 工具按需自扫描的先例）。没有 `skills/` 目录或目录为空：发现结果为空，不注入、不报错。
 */
export async function discoverSkills(project: ProjectSnapshot): Promise<SkillDiscoveryOutcome> {
  const skills: SkillMetadata[] = []
  const diagnostics: SkillDiagnostic[] = []

  const skillsDir = await getDirectoryIfExists(project.handle, SKILLS_DIRECTORY)
  if (!skillsDir) {
    return { skills, diagnostics }
  }

  for await (const entry of skillsDir.values()) {
    if (entry.kind !== 'directory' || entry.name.startsWith('.')) {
      continue
    }
    const skill = await discoverSkillFolder(entry as FileSystemDirectoryHandle, entry.name, diagnostics)
    if (skill) {
      skills.push(skill)
    }
  }

  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { skills, diagnostics }
}

/** 发现单个技能文件夹：无 SKILL.md（或大小写不符）静默跳过；一个坏技能不阻塞他者。 */
async function discoverSkillFolder(
  folder: FileSystemDirectoryHandle,
  folderName: string,
  diagnostics: SkillDiagnostic[],
): Promise<SkillMetadata | null> {
  const directory = `${SKILLS_DIRECTORY}/${folderName}`
  const skillFilePath = `${directory}/${SKILL_FILE_NAME}`

  let content: string
  try {
    const fileHandle = await folder.getFileHandle(SKILL_FILE_NAME)
    // 大小写精确（§3.1）：大小写不敏感文件系统上 getFileHandle 可能命中 skill.md 变体
    if (fileHandle.name !== SKILL_FILE_NAME) {
      return null
    }
    content = await (await fileHandle.getFile()).text()
  } catch (error) {
    const isMissing = error instanceof DOMException && error.name === 'NotFoundError'
    if (isMissing) {
      // 无 SKILL.md：不是技能候选（skills/ 根自身的 SKILL.md 天然不认——只遍历子文件夹）
      return null
    }
    diagnostics.push({
      code: 'skill_read_failed',
      severity: 'error',
      message: `技能 ${folderName} 的 SKILL.md 读取失败，已跳过（${error instanceof Error ? error.message : String(error)}）`,
      path: skillFilePath,
      skillName: folderName,
    })
    return null
  }

  const parsed = parseSkillFile(content)
  if (!parsed.ok) {
    diagnostics.push({
      code: 'skill_invalid_frontmatter',
      severity: 'error',
      message: `技能 ${folderName} 的 frontmatter 以 --- 开头但缺少闭合分隔线，已跳过`,
      path: skillFilePath,
      skillName: folderName,
    })
    return null
  }

  const description = parsed.frontmatter.description?.trim() ?? ''
  if (!description) {
    // 无 frontmatter 同样落到这里（§3.2：技能必须自我描述，否则模型无从判断何时用）
    diagnostics.push({
      code: 'skill_missing_description',
      severity: 'error',
      message: `技能 ${folderName} 缺少 description（frontmatter 必需，一句话说明做什么、何时用），已跳过`,
      path: skillFilePath,
      skillName: folderName,
    })
    return null
  }

  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    diagnostics.push({
      code: 'skill_description_too_long',
      severity: 'error',
      message: `技能 ${folderName} 的 description 超过 ${SKILL_DESCRIPTION_MAX_LENGTH} 字（当前 ${description.length} 字），已跳过；请压缩到一句话说明`,
      path: skillFilePath,
      skillName: folderName,
    })
    return null
  }

  const frontmatterName = parsed.frontmatter.name?.trim()
  if (frontmatterName && frontmatterName !== folderName) {
    diagnostics.push({
      code: 'skill_name_mismatch',
      severity: 'warning',
      message: `技能 ${folderName} 的 frontmatter name（${frontmatterName}）与文件夹名不一致，以文件夹名为准`,
      path: skillFilePath,
      skillName: folderName,
    })
  }

  const { files, filesOmitted } = await collectManifest(folder)
  if (filesOmitted !== undefined) {
    diagnostics.push({
      code: 'skill_too_many_files',
      severity: 'warning',
      message: `技能 ${folderName} 的附属文件超过 ${SKILL_MANIFEST_MAX_FILES} 个（共 ${SKILL_MANIFEST_MAX_FILES + filesOmitted} 个），清单已截断、其余 ${filesOmitted} 个未列出`,
      path: skillFilePath,
      skillName: folderName,
    })
  }

  return {
    name: folderName,
    description,
    ...(parsed.frontmatter.whenToUse?.trim() ? { whenToUse: parsed.frontmatter.whenToUse.trim() } : {}),
    ...(frontmatterName && frontmatterName !== folderName ? { displayName: frontmatterName } : {}),
    directory,
    skillFilePath,
    ignoredKeys: parsed.ignoredKeys,
    files,
    ...(filesOmitted !== undefined ? { filesOmitted } : {}),
  }
}

/**
 * 包内清单：递归遍历技能文件夹（跳过点开头条目），不含 SKILL.md；按 path 排序。
 * 上限 SKILL_MANIFEST_MAX_FILES 条，超出截断并返回未列出数（诊断由调用方发）。
 */
async function collectManifest(folder: FileSystemDirectoryHandle): Promise<{
  files: SkillFileEntry[]
  filesOmitted?: number
}> {
  const rawEntries = await walkFolder(folder, '')

  rawEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  if (rawEntries.length > SKILL_MANIFEST_MAX_FILES) {
    return {
      files: rawEntries.slice(0, SKILL_MANIFEST_MAX_FILES).map(toSkillFileEntry),
      filesOmitted: rawEntries.length - SKILL_MANIFEST_MAX_FILES,
    }
  }

  return { files: rawEntries.map(toSkillFileEntry) }
}

type RawManifestEntry = { path: string; size: number }

async function walkFolder(folder: FileSystemDirectoryHandle, prefix: string): Promise<RawManifestEntry[]> {
  const entries: RawManifestEntry[] = []

  for await (const entry of folder.values()) {
    if (entry.name.startsWith('.')) {
      continue
    }
    if (entry.kind === 'directory') {
      entries.push(...(await walkFolder(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`)))
      continue
    }
    if (prefix === '' && entry.name === SKILL_FILE_NAME) {
      continue
    }
    try {
      const file = await (entry as FileSystemFileHandle).getFile()
      entries.push({ path: `${prefix}${entry.name}`, size: file.size })
    } catch {
      // 单个附属文件读取失败：清单里少一条即可，不阻塞技能整体
    }
  }

  return entries
}

function toSkillFileEntry(entry: RawManifestEntry): SkillFileEntry {
  return {
    path: entry.path,
    size: entry.size,
    kind: classifySkillFile(entry.path),
  }
}

/** 逐级解析目录路径；不存在返回 null（不创建）。 */
async function getDirectoryIfExists(
  rootHandle: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle | null> {
  let current = rootHandle
  for (const segment of path.split('/').filter(Boolean)) {
    try {
      current = await current.getDirectoryHandle(segment)
    } catch {
      return null
    }
  }
  return current
}
