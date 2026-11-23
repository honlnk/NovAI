import { discoverSkills } from '../core/skills/discovery'
import {
  SKILLS_DIRECTORY,
  SKILL_FILE_NAME,
  SKILL_DESCRIPTION_MAX_LENGTH,
  type SkillDiagnostic,
} from '../core/skills/types'
import { removeDirectoryEntry } from '../core/fs/remove-directory'
import { writeProjectTextFile } from '../core/fs/project-fs'

import { requireRuntimeProject } from './project-runtime'
import type {
  BrokenSkillView,
  SkillImportCandidateView,
  SkillImportOutcomeView,
  SkillImportScanView,
  SkillListView,
  SkillView,
} from './types'

/**
 * 技能服务（技能包 UI/UX 施工计划 §3.1）：服务层桥接——发现/诊断走领域层
 * `discoverSkills`，写操作走 project-fs，不改领域层与 Agent 链路。
 *
 * 界面上的新建、导入、删除是作者本人操作（决策 9）：不走 AI 写入确认卡、
 * 不进变更账本；写操作后的项目文件刷新由调用方（UI store）按现有文件操作
 * 同一通道触发，技能列表随重算。
 */

/** 新建空白技能时目标文件夹已存在：不覆盖，调用方提示换个名字。 */
export class SkillFolderExistsError extends Error {
  readonly folderName: string

  constructor(folderName: string) {
    super(`已有同名技能 skills/${folderName}，请换个名字`)
    this.name = 'SkillFolderExistsError'
    this.folderName = folderName
  }
}

/** 导入扫描没有找到任何技能（所选文件夹及其一级子文件夹都没有 SKILL.md）。 */
export class SkillImportScanError extends Error {
  constructor() {
    super('所选文件夹里没有找到技能包（缺少 SKILL.md）')
    this.name = 'SkillImportScanError'
  }
}

/** 删除时技能文件夹不存在（可能已被 AI 或作者删除）。 */
export class SkillNotFoundError extends Error {
  readonly folderName: string

  constructor(folderName: string) {
    super(`技能 skills/${folderName} 不存在，可能已被删除，请刷新列表`)
    this.name = 'SkillNotFoundError'
    this.folderName = folderName
  }
}

/**
 * 技能列表（§3.1 listSkills）：合格技能 + 被跳过的 broken 技能。
 * warning 级诊断按 skillName 归到对应技能行；error 级（技能被跳过）按文件夹名归入 broken。
 */
export async function listSkills(projectId: string): Promise<SkillListView> {
  const project = requireRuntimeProject(projectId)
  const outcome = await discoverSkills(project)

  const skillViews = new Map<string, SkillView>(
    outcome.skills.map((skill) => [
      skill.name,
      {
        name: skill.name,
        ...(skill.displayName ? { displayName: skill.displayName } : {}),
        description: skill.description,
        ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
        directory: skill.directory,
        skillFilePath: skill.skillFilePath,
        files: skill.files.map((file) => ({ ...file })),
        ...(skill.filesOmitted !== undefined ? { filesOmitted: skill.filesOmitted } : {}),
        warnings: [],
      },
    ]),
  )

  const broken: BrokenSkillView[] = []
  const brokenNames = new Set<string>()
  for (const diagnostic of outcome.diagnostics) {
    const skillName = diagnostic.skillName ?? ''
    if (diagnostic.severity === 'warning') {
      skillViews.get(skillName)?.warnings.push({ code: diagnostic.code, message: diagnostic.message })
      continue
    }
    // error 级：技能被跳过 → broken（一个文件夹只发一条 error，去重防御）
    if (!skillName || brokenNames.has(skillName)) {
      continue
    }
    brokenNames.add(skillName)
    broken.push({
      name: skillName,
      directory: `${SKILLS_DIRECTORY}/${skillName}`,
      reason: humanizeBrokenReason(diagnostic),
      code: diagnostic.code,
      ...(diagnostic.path ? { skillFilePath: diagnostic.path } : {}),
    })
  }

  return { skills: [...skillViews.values()], broken }
}

/** error 级诊断 → 人话原因 + 修复提示（决策 8：写作者要的是「怎么修」）。 */
function humanizeBrokenReason(diagnostic: SkillDiagnostic): string {
  switch (diagnostic.code) {
    case 'skill_missing_description':
      return '缺少描述，AI 看不到这个技能。打开 SKILL.md 补上 description 即可'
    case 'skill_description_too_long':
      return `描述超过 ${SKILL_DESCRIPTION_MAX_LENGTH} 字，AI 看不到这个技能。打开 SKILL.md 把 description 压缩到一句话`
    case 'skill_invalid_frontmatter':
      return 'SKILL.md 的 frontmatter 缺少闭合分隔线，AI 看不到这个技能。打开 SKILL.md 修正（--- 开头的元信息块需要再一行 --- 结束）'
    case 'skill_read_failed':
      return `SKILL.md 读取失败（${diagnostic.message}），AI 看不到这个技能`
    default:
      return diagnostic.message
  }
}

/**
 * 新建空白技能（§3.4 模板）：写 `skills/<folderName>/SKILL.md`。
 * 文件夹已存在报 SkillFolderExistsError，不覆盖。模板 description 是占位文字，
 * 不改也合格（作者自负其责，列表上能看到）。
 */
export async function createBlankSkill(projectId: string, folderName: string): Promise<void> {
  const project = requireRuntimeProject(projectId)
  const name = assertSkillFolderName(folderName)

  if (await directoryExists(project.handle, `${SKILLS_DIRECTORY}/${name}`)) {
    throw new SkillFolderExistsError(name)
  }

  await writeProjectTextFile(project.handle, `${SKILLS_DIRECTORY}/${name}/${SKILL_FILE_NAME}`, blankSkillTemplate(name))
}

function blankSkillTemplate(name: string): string {
  return `---
name: ${name}
description: 一句话说明这个技能做什么、什么时候该用（AI 靠这句话决定是否加载）
---

# ${name}

## 适用场景

## 方法步骤

1.

## 注意事项
`
}

/**
 * 导入来源扫描（决策 12）：根下有 SKILL.md → 单技能；否则扫描一级子文件夹，
 * 含 SKILL.md 的为候选。两者都不是抛 SkillImportScanError。
 * hasConflict 对照当前项目 skills/ 现状（契约补 projectId 参数，见施工日志）。
 */
export async function scanImportSource(
  projectId: string,
  sourceHandle: FileSystemDirectoryHandle,
): Promise<SkillImportScanView> {
  requireRuntimeProject(projectId)

  if (await hasSkillFile(sourceHandle)) {
    return {
      mode: 'single',
      candidates: [await toCandidate(projectId, sourceHandle.name)],
    }
  }

  const candidates: SkillImportCandidateView[] = []
  for await (const entry of sourceHandle.values()) {
    if (entry.kind !== 'directory' || entry.name.startsWith('.')) {
      continue
    }
    const folder = entry as FileSystemDirectoryHandle
    if (await hasSkillFile(folder)) {
      candidates.push(await toCandidate(projectId, entry.name))
    }
  }

  if (candidates.length === 0) {
    throw new SkillImportScanError()
  }
  return { mode: 'collection', candidates }
}

async function toCandidate(projectId: string, folderName: string): Promise<SkillImportCandidateView> {
  const project = requireRuntimeProject(projectId)
  return { folderName, hasConflict: await directoryExists(project.handle, `${SKILLS_DIRECTORY}/${folderName}`) }
}

/**
 * 导入（§3.1 importSkills）：把选中候选逐个整体复制为 `skills/<文件夹名>/`。
 * 只复制、不解析、不执行；脚本文件原样复制（清单里标已忽略是发现层的事）。
 * 目标已存在跳过并标 exists（本期不做覆盖/合并）；文件数超清单上限照样复制。
 */
export async function importSkills(
  projectId: string,
  sourceHandle: FileSystemDirectoryHandle,
  folderNames: string[],
): Promise<SkillImportOutcomeView> {
  const project = requireRuntimeProject(projectId)
  if (folderNames.length === 0) {
    return { imported: [], skipped: [] }
  }

  const rootIsSkill = await hasSkillFile(sourceHandle)
  const skillsDir = await project.handle.getDirectoryHandle(SKILLS_DIRECTORY, { create: true })

  const outcome: SkillImportOutcomeView = { imported: [], skipped: [] }
  for (const folderName of folderNames) {
    // 单技能模式源是根本身（folderName 即根名）；合集模式源是一级子文件夹
    const source = rootIsSkill
      ? sourceHandle
      : await sourceHandle.getDirectoryHandle(assertSkillFolderName(folderName))

    if (await directoryExists(skillsDir, folderName)) {
      outcome.skipped.push({ folderName, reason: 'exists' })
      continue
    }
    const target = await skillsDir.getDirectoryHandle(folderName, { create: true })
    await copyDirectoryTree(source, target)
    outcome.imported.push(folderName)
  }
  return outcome
}

/** 删除技能：整夹删除 `skills/<name>/`，不可撤销、不进回收站（决策 9，二次确认由 UI 承担）。 */
export async function deleteSkill(projectId: string, name: string): Promise<void> {
  const project = requireRuntimeProject(projectId)
  const folderName = assertSkillFolderName(name)

  const skillsDir = await getDirectoryIfExists(project.handle, SKILLS_DIRECTORY)
  if (!skillsDir) {
    throw new SkillNotFoundError(folderName)
  }
  try {
    await removeDirectoryEntry(skillsDir, folderName)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      throw new SkillNotFoundError(folderName)
    }
    throw error
  }
}

/* ---------- 内部工具 ---------- */

/** 技能文件夹名单段校验：非空、单段（无 /）、不以点开头。 */
function assertSkillFolderName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')) {
    throw new Error(`技能名不合法：${name}（需要是单个文件夹名，不能以点开头）`)
  }
  return trimmed
}

/** 大小写精确判定文件夹根下是否有 SKILL.md（与发现层口径一致）。 */
async function hasSkillFile(folder: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const fileHandle = await folder.getFileHandle(SKILL_FILE_NAME)
    return fileHandle.name === SKILL_FILE_NAME
  } catch {
    return false
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

async function directoryExists(rootHandle: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  return (await getDirectoryIfExists(rootHandle, path)) !== null
}

/**
 * 递归复制目录树（整体复制）。跳过点开头条目（.DS_Store 等：发现与清单层都
 * 不见它们，复制只浪费空间——见施工日志）；文件按二进制流复制，内容原样。
 */
async function copyDirectoryTree(
  source: FileSystemDirectoryHandle,
  target: FileSystemDirectoryHandle,
): Promise<void> {
  for await (const entry of source.values()) {
    if (entry.name.startsWith('.')) {
      continue
    }
    if (entry.kind === 'directory') {
      const subTarget = await target.getDirectoryHandle(entry.name, { create: true })
      await copyDirectoryTree(entry as FileSystemDirectoryHandle, subTarget)
      continue
    }
    const file = await (entry as FileSystemFileHandle).getFile()
    const targetHandle = await target.getFileHandle(entry.name, { create: true })
    const writable = await targetHandle.createWritable()
    await writable.write(file)
    await writable.close()
  }
}
