import { assertChapterNameFormat, isChapterPath } from './chapter-name'
import { SKILLS_DIRECTORY } from '../skills/types'

const TEXT_FILE_EXTENSIONS = ['.md', '.json', '.txt'] as const

export function normalizeProjectPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/')

  if (!normalized) {
    throw new Error('文件路径不能为空')
  }

  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error('工具只能使用小说项目内的相对路径')
  }

  const segments = normalized.split('/').filter(Boolean)

  if (segments.length === 0) {
    throw new Error('文件路径不能为空')
  }

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('文件路径不能包含 . 或 ..')
  }

  if (normalized.endsWith('/')) {
    throw new Error('工具目标必须是文件，不能是目录')
  }

  return segments.join('/')
}

export function normalizeProjectDirectoryPath(path: string | undefined): string {
  const normalized = (path ?? '').trim().replace(/\\/g, '/')

  if (!normalized || normalized === '.') {
    return ''
  }

  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error('工具只能使用小说项目内的相对路径')
  }

  const segments = normalized.split('/').filter(Boolean)

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('目录路径不能包含 . 或 ..')
  }

  return segments.join('/')
}

/**
 * 内部路径与可见性（单一来源）：「哪些东西不给模型看/碰」的全部判定都住在这里，
 * 判定消费方（读写断言族、目录列表、遍历）一律从这里导入，不各自保留副本。
 * 名单本身保持私有——外部消费「是不是」，不消费名单；名单变更零外溢。
 */

/** 比较前统一小写：macOS APFS 大小写不敏感，`Novel.Config.JSON` / `.NOVEL/` 变体同样命中真实内部文件。 */
function foldInternalPath(path: string): string {
  return path.toLowerCase()
}

/** 内部文件名（项目根的配置文件，含模型密钥）。 */
const INTERNAL_CONFIG_FILE = 'novel.config.json'

/** 内部目录名（应用自行管理的隐藏目录）。 */
const INTERNAL_DIRECTORIES = ['.novel', '.novai'] as const

/** 内部目录中唯一放行读取的例外：spill 是超长工具结果的取回通道（详见 spill 重设计）。 */
const SPILL_READABLE_DIR = '.novel/spill'
const SPILL_READABLE_PREFIX = '.novel/spill/'

/** 项目根相对路径是否内部路径（文件或目录，含裸目录名与 spill 子树）。 */
export function isInternalPath(path: string): boolean {
  const folded = foldInternalPath(path)
  return folded === INTERNAL_CONFIG_FILE
    || INTERNAL_DIRECTORIES.some((directory) => folded === directory || folded.startsWith(`${directory}/`))
}

/**
 * 领域账本文件（受保护数据）：由领域服务统一维护的项目级结构化数据
 * （关系图谱的关系账本、时间线的事件账本）。
 * 与内部路径分开判定：内部文件是「应用私有、模型无需知晓」，账本是「领域数据、
 * 有专用工具」——对通用文件工具同样全部禁止读写，但教学式出路指向专用工具。
 * 名单同样保持私有，消费方只消费「是不是」。
 */
const PROTECTED_LEDGER_FILES = ['elements/relations.json', 'elements/timeline.json'] as const

/** 项目根相对路径是否受保护账本文件。 */
export function isProtectedLedgerPath(path: string): boolean {
  const folded = foldInternalPath(path)
  return PROTECTED_LEDGER_FILES.some((file) => folded === file)
}

/**
 * 项目根相对路径是否技能包内文件（skills/ 子树，《技能包底层能力施工计划》3.6）。
 * skills/ 是普通可管理目录（非内部路径、非受保护账本）：读写照常，仅 ReadFile
 * 结果加素材提示行、LoadSkill 用同一前缀定位。根目录名以 skills 领域常量为单一来源。
 */
export function isSkillPath(path: string): boolean {
  return foldInternalPath(path).startsWith(`${SKILLS_DIRECTORY}/`)
}

/** 是否 spill 取回通道自身或其子路径（内部路径中唯一可读的例外）。 */
export function isSpillReadablePath(path: string): boolean {
  const folded = foldInternalPath(path)
  return folded === SPILL_READABLE_DIR || folded.startsWith(SPILL_READABLE_PREFIX)
}

/** 目录条目是否对模型不可见（ListDirectory 用）：点开头条目或内部路径（novel.config.json 也隐藏）。 */
export function isAgentHiddenEntry(entryName: string): boolean {
  return entryName.startsWith('.') || isInternalPath(entryName)
}

/**
 * 遍历是否跳过该路径（walkFiles 用，目录命中即整棵子树跳过）：非 spill 的内部路径跳过，
 * 其余任一路径段点开头也跳过（.git、.DS_Store 等常规隐藏项）；spill 子树永不跳过（取回通道）。
 */
export function shouldSkipInWalk(path: string): boolean {
  if (isSpillReadablePath(path)) {
    return false
  }

  if (isInternalPath(path)) {
    return true
  }

  // 受保护账本文件对模型不可见（查找/搜索遍历跳过），读写拦截在断言族
  if (isProtectedLedgerPath(path)) {
    return true
  }

  return path.split('/').some((segment) => segment.startsWith('.'))
}

/**
 * 教学式报错工厂（D5）：陈述边界 + 陈述原因（密钥）+ 陈述出路（上下文已给/问用户）。
 * 运行时动态反馈对齐 6d24dcf（动态反馈与错误教学替代静态规则），模型撞一次即学会。
 */
export function internalPathError(label: string): Error {
  return new Error(
    `${label} 不能指向应用内部文件。novel.config.json（项目配置，含模型密钥）、.novel/、.novai/ 由应用自行管理，`
    + '不通过工具读写，也不会出现在目录列表和搜索结果中。唯一例外是 .novel/spill/'
    + '（超长工具结果的取回通道，可按指引用 ReadFile 分段读取）。如果你需要项目配置信息（模型、默认目标、权限档位），'
    + '模型名与默认目标已在每条用户指令的上下文中给出，其余请直接询问用户，不要尝试读取配置文件。',
  )
}

/**
 * 受保护账本的教学式报错：陈述边界 + 陈述出路（按账本文件分支指路对应专用工具）。
 * 账本数据由对应领域统一维护，专用工具与作者界面弹窗操作同一份事实来源。
 */
export function protectedLedgerPathError(label: string, path: string): Error {
  if (foldInternalPath(path) === 'elements/timeline.json') {
    return new Error(
      `${label} 不能指向时间线账本文件（elements/timeline.json）。时间线数据由事件账本统一维护：`
      + '查询与浏览用 TimelineList / TimelineRead，登记事件用 TimelineCreatePoint / TimelineCreateSpan，'
      + '修改与移动用 TimelineUpdate，删除用 TimelineDelete。作者界面中的时间轴弹窗与这些工具操作同一份数据。'
      + '该文件不会出现在目录列表与搜索结果中，也不要引导作者手工编辑它。',
    )
  }
  return new Error(
    `${label} 不能指向关系账本文件（elements/relations.json）。关系数据由关系图谱统一维护：`
    + '查询用 RelationList / RelationQuery / RelationRead，登记与修改用 RelationCreate / RelationUpdate / RelationDelete，'
    + '检查数据用 RelationCheck。作者界面中的关系图谱弹窗与这些工具操作同一份数据。'
    + '该文件不会出现在目录列表与搜索结果中，也不要引导作者手工编辑它。',
  )
}

export function assertTextFilePath(path: string): void {
  if (!TEXT_FILE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) {
    throw new Error('当前工具只支持 .md、.json、.txt 文本文件')
  }
}

export function assertWritableTextFilePath(path: string): void {
  assertTextFilePath(path)

  if (path.startsWith('chapters/') && !path.toLowerCase().endsWith('.txt')) {
    throw new Error('章节正文必须写入 chapters/*.txt；要素和提示词才使用 .md')
  }

  // chapters/ 下必须符合「第NNN章-标题.txt」命名规范
  if (isChapterPath(path)) {
    assertChapterNameFormat(path)
  }
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}
