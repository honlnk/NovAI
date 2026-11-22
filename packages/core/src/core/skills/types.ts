/**
 * 技能领域类型（《技能包底层能力施工计划》§3.3）。
 *
 * 技能 = 项目根 `skills/<文件夹>/SKILL.md` + 附属文件；身份是文件夹名（决策 4），
 * frontmatter `name` 仅作展示参考。诊断模型对齐 ZCode adapters/src/skills：一个坏
 * 技能不阻塞整体发现，被跳过的技能不进目录。
 */

/** 技能根目录（项目内相对路径，无尾斜杠）。 */
export const SKILLS_DIRECTORY = 'skills'

/** 技能入口文件名（大小写精确匹配，决策 3.1）。 */
export const SKILL_FILE_NAME = 'SKILL.md'

/** 包内清单条目数上限（超出截断并发 skill_too_many_files 诊断）。 */
export const SKILL_MANIFEST_MAX_FILES = 200

/** description 长度上限（超出发 skill_description_too_long 并跳过该技能）。 */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024

/** 包内附属文件的分类（决策 8：脚本类只列出、标「已忽略」，不提供内容）。 */
export type SkillFileKind = 'text' | 'script' | 'unsupported'

export type SkillFileEntry = {
  /** 相对技能文件夹的路径，如 'references/词表.md'（不含 SKILL.md）。 */
  path: string
  /** 文件字节数（清单展示用）。 */
  size: number
  kind: SkillFileKind
}

export type SkillMetadata = {
  /** 技能身份：文件夹名（决策 4，同目录天然唯一）。 */
  name: string
  /** frontmatter name（与文件夹名不同时保留作展示参考）。 */
  displayName?: string
  description: string
  whenToUse?: string
  /** 技能文件夹的项目内相对路径，如 'skills/去AI味'。 */
  directory: string
  /** SKILL.md 的项目内相对路径。 */
  skillFilePath: string
  /** 非白名单 frontmatter 键（L2 结果列明）。 */
  ignoredKeys: string[]
  /** 包内清单（不含 SKILL.md），按 path 排序。 */
  files: SkillFileEntry[]
  /** 清单超上限被截断时未列出的文件数（L2 清单末尾提示「其余 N 个文件未列出」）。 */
  filesOmitted?: number
}

export type SkillDiagnosticCode =
  | 'skill_read_failed'
  | 'skill_missing_description'
  | 'skill_description_too_long'
  | 'skill_name_mismatch'
  | 'skill_invalid_frontmatter'
  | 'skill_too_many_files'

export type SkillDiagnostic = {
  code: SkillDiagnosticCode
  severity: 'error' | 'warning'
  message: string
  /** 相关文件路径（通常是 SKILL.md 路径）。 */
  path: string
  skillName?: string
}

export type SkillDiscoveryOutcome = {
  /** 发现成功的技能，按 name 排序（digest 与目录渲染的稳定序）。 */
  skills: SkillMetadata[]
  diagnostics: SkillDiagnostic[]
}

/** 附属文件分类（§3.3）：text 可经 LoadSkill file 参数读取；script 只列出标忽略；其余 unsupported。 */
export function classifySkillFile(path: string): SkillFileKind {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (TEXT_FILE_EXTENSIONS.includes(extension)) {
    return 'text'
  }
  if (SCRIPT_FILE_EXTENSIONS.includes(extension)) {
    return 'script'
  }
  return 'unsupported'
}

const TEXT_FILE_EXTENSIONS = ['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv']

const SCRIPT_FILE_EXTENSIONS = [
  '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts',
  '.ps1', '.bat', '.cmd', '.rb', '.pl', '.php',
]
