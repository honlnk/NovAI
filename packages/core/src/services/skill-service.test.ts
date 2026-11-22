import { beforeEach, describe, expect, it } from 'vitest'

import {
  createBlankSkill,
  deleteSkill,
  importSkills,
  listSkills,
  scanImportSource,
  SkillFolderExistsError,
  SkillImportScanError,
  SkillNotFoundError,
} from './skill-service'
import { setRuntimeProject } from './project-runtime'
import type { ProjectSnapshot } from '../types/project'

/* ---------- 内存文件系统（与 discovery.test.ts 同款内联实现，补 removeEntry recursive） ---------- */

type MemoryFileEntry = {
  kind: 'file'
  name: string
  content: string
  lastModified: number
}

type MemoryDirectoryEntry = {
  kind: 'directory'
  name: string
  entries: Map<string, MemoryEntry>
}

type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry

type MemoryDirectoryHandle = FileSystemDirectoryHandle & {
  __entry: MemoryDirectoryEntry
}

function createDirectoryHandle(entry: MemoryDirectoryEntry): MemoryDirectoryHandle {
  return {
    kind: 'directory',
    name: entry.name,
    __entry: entry,
    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'directory') {
        return createDirectoryHandle(current)
      }
      if (current) {
        throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      }
      if (!options?.create) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
      const next: MemoryDirectoryEntry = { kind: 'directory', name, entries: new Map() }
      entry.entries.set(name, next)
      return createDirectoryHandle(next)
    },
    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
      const current = entry.entries.get(name)
      if (current?.kind === 'file') {
        return createFileHandle(current)
      }
      if (current) {
        throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
      }
      if (!options?.create) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
      const next: MemoryFileEntry = { kind: 'file', name, content: '', lastModified: Date.now() }
      entry.entries.set(name, next)
      return createFileHandle(next)
    },
    async removeEntry(name: string, options?: FileSystemRemoveOptions) {
      const current = entry.entries.get(name)
      if (!current) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
      if (current.kind === 'directory' && !options?.recursive && current.entries.size > 0) {
        throw new DOMException('Directory not empty', 'InvalidModificationError')
      }
      entry.entries.delete(name)
    },
    async *values() {
      for (const child of entry.entries.values()) {
        yield child.kind === 'directory' ? createDirectoryHandle(child) : createFileHandle(child)
      }
    },
  } as unknown as MemoryDirectoryHandle
}

function createFileHandle(entry: MemoryFileEntry): FileSystemFileHandle {
  return {
    kind: 'file',
    name: entry.name,
    async getFile() {
      return new File([entry.content], entry.name, { type: 'text/plain', lastModified: entry.lastModified })
    },
    async createWritable() {
      let chunks: BlobPart[] = []
      return {
        async write(data: BlobPart) {
          chunks = [...chunks, data]
        },
        async close() {
          entry.content = await new Blob(chunks).text()
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as FileSystemFileHandle
}

/* ---------- 测试基建 ---------- */

const PROJECT_ID = 'skill-service-test'

let root: MemoryDirectoryHandle

function project(): ProjectSnapshot {
  return {
    id: PROJECT_ID,
    name: 'Test Project',
    rootName: 'novel',
    handle: root,
    config: {} as ProjectSnapshot['config'],
    manifest: {} as ProjectSnapshot['manifest'],
    tree: [],
    metadata: {} as ProjectSnapshot['metadata'],
  }
}

/** 在内存 FS 里写入文件（自动建中间目录）。 */
function seedFile(path: string, content: string, host: MemoryDirectoryHandle = root) {
  const segments = path.split('/')
  const fileName = segments.pop() as string
  let dir = host.__entry
  for (const segment of segments) {
    let next = dir.entries.get(segment)
    if (!next) {
      next = { kind: 'directory', name: segment, entries: new Map() }
      dir.entries.set(segment, next)
    } else if (next.kind !== 'directory') {
      throw new Error(`路径中段不是目录：${path}`)
    }
    dir = next
  }
  dir.entries.set(fileName, { kind: 'file', name: fileName, content, lastModified: Date.now() })
}

/** 读取内存 FS 里的文件内容；不存在返回 null。 */
async function readFile(path: string, host: MemoryDirectoryHandle = root): Promise<string | null> {
  let handle: FileSystemDirectoryHandle | FileSystemFileHandle = host
  for (const segment of path.split('/')) {
    if (handle.kind === 'directory') {
      try {
        handle = await (handle as MemoryDirectoryHandle).getDirectoryHandle(segment)
        continue
      } catch {
        try {
          handle = await (handle as MemoryDirectoryHandle).getFileHandle(segment)
        } catch {
          return null
        }
        continue
      }
    }
    return null
  }
  if (handle.kind !== 'file') return null
  return (await (handle as FileSystemFileHandle).getFile()).text()
}

function skillMd(description: string, name?: string): string {
  const frontmatterName = name === undefined ? '' : `name: ${name}\n`
  return `---\n${frontmatterName}description: ${description}\n---\n\n# 技能\n\n正文`
}

beforeEach(() => {
  root = createDirectoryHandle({ kind: 'directory', name: 'novel', entries: new Map() })
  setRuntimeProject(project())
})

/* ---------- listSkills ---------- */

describe('listSkills', () => {
  it('无 skills/ 目录：技能与 broken 都为空，不报错', async () => {
    const view = await listSkills(PROJECT_ID)

    expect(view.skills).toEqual([])
    expect(view.broken).toEqual([])
  })

  it('合格技能：名称、描述、目录、清单与 whenToUse 齐全', async () => {
    seedFile('skills/去AI味/SKILL.md', `---\nname: 去AI味\ndescription: 去掉机器味\nwhen_to_use: 润色时\n---\n\n正文`)
    seedFile('skills/去AI味/references/词表.md', '词表内容')

    const view = await listSkills(PROJECT_ID)

    expect(view.skills).toHaveLength(1)
    const skill = view.skills[0]
    expect(skill.name).toBe('去AI味')
    expect(skill.description).toBe('去掉机器味')
    expect(skill.whenToUse).toBe('润色时')
    expect(skill.directory).toBe('skills/去AI味')
    expect(skill.skillFilePath).toBe('skills/去AI味/SKILL.md')
    expect(skill.files).toEqual([{ path: 'references/词表.md', size: expect.any(Number), kind: 'text' }])
    expect(skill.warnings).toEqual([])
    expect(view.broken).toEqual([])
  })

  it('frontmatter name 与文件夹名不一致：displayName 副标 + warning 归到技能行', async () => {
    seedFile('skills/去AI味/SKILL.md', skillMd('去掉机器味', 'remove-ai-flavor'))

    const view = await listSkills(PROJECT_ID)

    expect(view.skills[0].displayName).toBe('remove-ai-flavor')
    expect(view.skills[0].warnings).toHaveLength(1)
    expect(view.skills[0].warnings[0].code).toBe('skill_name_mismatch')
    expect(view.broken).toEqual([])
  })

  it('缺 description 的技能：进 broken，人话原因指向修复动作，SKILL.md 可点开', async () => {
    seedFile('skills/坏技能/SKILL.md', `---\nname: 坏技能\n---\n\n正文`)

    const view = await listSkills(PROJECT_ID)

    expect(view.skills).toEqual([])
    expect(view.broken).toHaveLength(1)
    expect(view.broken[0].name).toBe('坏技能')
    expect(view.broken[0].directory).toBe('skills/坏技能')
    expect(view.broken[0].reason).toContain('缺少描述')
    expect(view.broken[0].reason).toContain('description')
    expect(view.broken[0].skillFilePath).toBe('skills/坏技能/SKILL.md')
  })

  it('frontmatter 未闭合：broken 原因写明修复方式', async () => {
    seedFile('skills/断头/SKILL.md', `---\nname: 断头\ndescription: 没有闭合的技能`)

    const view = await listSkills(PROJECT_ID)

    expect(view.skills).toEqual([])
    expect(view.broken).toHaveLength(1)
    expect(view.broken[0].code).toBe('skill_invalid_frontmatter')
    expect(view.broken[0].reason).toContain('闭合')
  })

  it('好坏技能并存：一个坏技能不阻塞他者，warning 与 broken 并存', async () => {
    seedFile('skills/好技能/SKILL.md', skillMd('正常技能', '好技能-renamed'))
    seedFile('skills/坏技能/SKILL.md', `---\n---\n\n正文`)

    const view = await listSkills(PROJECT_ID)

    expect(view.skills).toHaveLength(1)
    expect(view.skills[0].warnings).toHaveLength(1)
    expect(view.broken).toHaveLength(1)
  })
})

/* ---------- createBlankSkill ---------- */

describe('createBlankSkill', () => {
  it('新建：写模板 SKILL.md，frontmatter name 与 description 就位', async () => {
    await createBlankSkill(PROJECT_ID, '文风仿写')

    const content = await readFile('skills/文风仿写/SKILL.md')
    expect(content).toContain('name: 文风仿写')
    expect(content).toContain('description: 一句话说明这个技能做什么、什么时候该用')
    expect(content).toContain('# 文风仿写')
    expect(content).toContain('## 方法步骤')
  })

  it('重名：报 SkillFolderExistsError，不覆盖既有技能', async () => {
    seedFile('skills/去AI味/SKILL.md', skillMd('原文'))
    await expect(createBlankSkill(PROJECT_ID, '去AI味')).rejects.toBeInstanceOf(SkillFolderExistsError)

    expect(await readFile('skills/去AI味/SKILL.md')).toContain('原文')
  })

  it('非法名（空 / 含 / / 点开头）：教学式报错', async () => {
    await expect(createBlankSkill(PROJECT_ID, '  ')).rejects.toThrow('技能名不合法')
    await expect(createBlankSkill(PROJECT_ID, 'a/b')).rejects.toThrow('技能名不合法')
    await expect(createBlankSkill(PROJECT_ID, '.隐藏')).rejects.toThrow('技能名不合法')
  })
})

/* ---------- scanImportSource / importSkills ---------- */

describe('scanImportSource 与 importSkills', () => {
  function makeSource(): MemoryDirectoryHandle {
    return createDirectoryHandle({ kind: 'directory', name: '外部技能集', entries: new Map() })
  }

  it('单技能来源：根下有 SKILL.md，mode single、候选为根名', async () => {
    const source = makeSource()
    seedFile('SKILL.md', skillMd('单技能'), source)

    const scan = await scanImportSource(PROJECT_ID, source)

    expect(scan.mode).toBe('single')
    expect(scan.candidates).toEqual([{ folderName: '外部技能集', hasConflict: false }])
  })

  it('合集来源：列出全部含 SKILL.md 的一级子文件夹，已存在的标冲突', async () => {
    seedFile('skills/去AI味/SKILL.md', skillMd('已有'))
    const source = makeSource()
    seedFile('去AI味/SKILL.md', skillMd('外部同名'), source)
    seedFile('文风仿写/SKILL.md', skillMd('外部新技能'), source)
    seedFile('不是技能/说明.txt', '没有 SKILL.md 的子文件夹', source)

    const scan = await scanImportSource(PROJECT_ID, source)

    expect(scan.mode).toBe('collection')
    const byName = new Map(scan.candidates.map((c) => [c.folderName, c]))
    expect(byName.get('去AI味')?.hasConflict).toBe(true)
    expect(byName.get('文风仿写')?.hasConflict).toBe(false)
    expect(byName.has('不是技能')).toBe(false)
  })

  it('缺 SKILL.md 导入：报「没有找到技能包」', async () => {
    const source = makeSource()
    seedFile('空文件夹/其他.md', '内容', source)

    await expect(scanImportSource(PROJECT_ID, source)).rejects.toBeInstanceOf(SkillImportScanError)
  })

  it('单技能导入：整体复制为 skills/<根名>/，子目录与脚本原样复制', async () => {
    const source = makeSource()
    seedFile('SKILL.md', skillMd('单技能'), source)
    seedFile('references/词表.md', '词表', source)
    seedFile('scripts/run.py', 'print(1)', source)

    const outcome = await importSkills(PROJECT_ID, source, ['外部技能集'])

    expect(outcome.imported).toEqual(['外部技能集'])
    expect(outcome.skipped).toEqual([])
    expect(await readFile('skills/外部技能集/SKILL.md')).toContain('单技能')
    expect(await readFile('skills/外部技能集/references/词表.md')).toBe('词表')
    expect(await readFile('skills/外部技能集/scripts/run.py')).toBe('print(1)')
  })

  it('合集导入：勾选项逐个复制，同名跳过不覆盖，未勾选不复制', async () => {
    seedFile('skills/去AI味/SKILL.md', skillMd('项目原有'))
    const source = makeSource()
    seedFile('去AI味/SKILL.md', skillMd('外部同名'), source)
    seedFile('文风仿写/SKILL.md', skillMd('新技能'), source)
    seedFile('节奏控制/SKILL.md', skillMd('未勾选'), source)

    const outcome = await importSkills(PROJECT_ID, source, ['去AI味', '文风仿写'])

    expect(outcome.imported).toEqual(['文风仿写'])
    expect(outcome.skipped).toEqual([{ folderName: '去AI味', reason: 'exists' }])
    expect(await readFile('skills/去AI味/SKILL.md')).toContain('项目原有')
    expect(await readFile('skills/文风仿写/SKILL.md')).toContain('新技能')
    expect(await readFile('skills/节奏控制/SKILL.md')).toBeNull()
  })

  it('导入后 listSkills 能看到导入的技能', async () => {
    const source = makeSource()
    seedFile('SKILL.md', skillMd('导入即生效'), source)

    await importSkills(PROJECT_ID, source, ['外部技能集'])
    const view = await listSkills(PROJECT_ID)

    expect(view.skills.map((s) => s.name)).toEqual(['外部技能集'])
  })
})

/* ---------- deleteSkill ---------- */

describe('deleteSkill', () => {
  it('删除：整夹移除（含附属文件），不残留空目录', async () => {
    seedFile('skills/去AI味/SKILL.md', skillMd('待删'))
    seedFile('skills/去AI味/references/词表.md', '词表')

    await deleteSkill(PROJECT_ID, '去AI味')

    const view = await listSkills(PROJECT_ID)
    expect(view.skills).toEqual([])
    expect(view.broken).toEqual([])
  })

  it('技能不存在：报 SkillNotFoundError（可能已被 AI 删除）', async () => {
    await expect(deleteSkill(PROJECT_ID, '不存在')).rejects.toBeInstanceOf(SkillNotFoundError)
  })

  it('无 skills/ 目录：同样按不存在报错', async () => {
    await expect(deleteSkill(PROJECT_ID, '去AI味')).rejects.toBeInstanceOf(SkillNotFoundError)
  })
})
