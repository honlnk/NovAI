import { beforeEach, describe, expect, it } from 'vitest'

import { discoverSkills } from './discovery'
import type { ProjectSnapshot } from '../../types/project'

/* ---------- 内存文件系统（与 json-ledger 测试同款内联实现） ---------- */

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

function createMemoryDirectory(name: string): MemoryDirectoryHandle {
  return createDirectoryHandle({ kind: 'directory', name, entries: new Map() })
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
    async removeEntry(name: string) {
      if (!entry.entries.delete(name)) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
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
      let nextContent = ''
      return {
        async write(data: string) {
          nextContent += data
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as FileSystemFileHandle
}

/* ---------- 测试 ---------- */

let root: MemoryDirectoryHandle

function project(): ProjectSnapshot {
  return {
    id: 'test-project',
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
function seedFile(path: string, content: string) {
  const segments = path.split('/')
  const fileName = segments.pop()!
  let current = root.__entry

  for (const segment of segments) {
    let next = current.entries.get(segment)
    if (!next || next.kind !== 'directory') {
      next = { kind: 'directory', name: segment, entries: new Map() }
      current.entries.set(segment, next)
    }
    current = next
  }

  current.entries.set(fileName, { kind: 'file', name: fileName, content, lastModified: Date.now() })
}

function seedSkill(folderName: string, frontmatter: string, body = '正文') {
  seedFile(`skills/${folderName}/SKILL.md`, `---\n${frontmatter}\n---\n\n${body}`)
}

beforeEach(() => {
  root = createMemoryDirectory('novel')
})

describe('discoverSkills', () => {
  it('无 skills/ 目录：发现结果为空，不注入、不报错', async () => {
    seedFile('chapters/第001章-试炼.txt', '正文')

    const outcome = await discoverSkills(project())

    expect(outcome.skills).toEqual([])
    expect(outcome.diagnostics).toEqual([])
  })

  it('空 skills/ 目录：结果为空', async () => {
    seedFile('skills/.keep', '')

    const outcome = await discoverSkills(project())

    expect(outcome.skills).toEqual([])
    expect(outcome.diagnostics).toEqual([])
  })

  it('正常技能：解析 description/when_to_use、清单含附属文件与分类', async () => {
    seedSkill('去AI味', 'name: 去AI味\ndescription: 降低 AI 腔的写作方法\nwhen_to_use: 写正文时用')
    seedFile('skills/去AI味/references/词表.md', '词表内容')
    seedFile('skills/去AI味/scripts/check.py', 'print(1)')
    seedFile('skills/去AI味/assets/cover.png', 'binary')

    const outcome = await discoverSkills(project())

    expect(outcome.diagnostics).toEqual([])
    expect(outcome.skills).toHaveLength(1)
    const skill = outcome.skills[0]!
    expect(skill.name).toBe('去AI味')
    expect(skill.description).toBe('降低 AI 腔的写作方法')
    expect(skill.whenToUse).toBe('写正文时用')
    expect(skill.directory).toBe('skills/去AI味')
    expect(skill.skillFilePath).toBe('skills/去AI味/SKILL.md')
    expect(skill.files.map((file) => [file.path, file.kind])).toEqual([
      ['assets/cover.png', 'unsupported'],
      ['references/词表.md', 'text'],
      ['scripts/check.py', 'script'],
    ])
    // 附属文件大小 = 内容字节数（词表内容 12 个汉字 = 36 字节 UTF-8）
    expect(skill.files.find((file) => file.path === 'references/词表.md')!.size).toBe(
      new TextEncoder().encode('词表内容').length,
    )
  })

  it('点开头文件夹跳过；skills/ 根自身的 SKILL.md 不认', async () => {
    seedSkill('去AI味', 'description: 说明')
    seedFile('skills/.隐藏技能/SKILL.md', '---\ndescription: 隐藏\n---\n')
    seedFile('skills/SKILL.md', '---\ndescription: 根技能\n---\n')

    const outcome = await discoverSkills(project())

    expect(outcome.skills.map((skill) => skill.name)).toEqual(['去AI味'])
    expect(outcome.diagnostics).toEqual([])
  })

  it('无 SKILL.md 的子文件夹不是技能候选（静默跳过）', async () => {
    seedFile('skills/杂物/readme.md', '不是技能')

    const outcome = await discoverSkills(project())

    expect(outcome.skills).toEqual([])
    expect(outcome.diagnostics).toEqual([])
  })

  it('frontmatter name 与文件夹名不一致：warning 诊断、以文件夹名为准并保留 displayName', async () => {
    seedSkill('去AI味', 'name: deaiify\ndescription: 说明')

    const outcome = await discoverSkills(project())

    expect(outcome.skills).toHaveLength(1)
    expect(outcome.skills[0]!.name).toBe('去AI味')
    expect(outcome.skills[0]!.displayName).toBe('deaiify')
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ code: 'skill_name_mismatch', severity: 'warning', skillName: '去AI味' }),
    ])
  })

  it('缺 description（含无 frontmatter）：error 诊断并跳过', async () => {
    seedSkill('坏技能', 'name: 只有名字')
    seedFile('skills/无frontmatter/SKILL.md', '直接正文没有 frontmatter')

    const outcome = await discoverSkills(project())

    expect(outcome.skills).toEqual([])
    expect(outcome.diagnostics.map((item) => item.code)).toEqual([
      'skill_missing_description',
      'skill_missing_description',
    ])
    expect(outcome.diagnostics.every((item) => item.severity === 'error')).toBe(true)
  })

  it('description 超过 1024 字：error 诊断并跳过', async () => {
    seedSkill('啰嗦技能', `description: ${'长'.repeat(1025)}`)

    const outcome = await discoverSkills(project())

    expect(outcome.skills).toEqual([])
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ code: 'skill_description_too_long', severity: 'error' }),
    ])
  })

  it('frontmatter 未闭合：skill_invalid_frontmatter 并跳过', async () => {
    seedFile('skills/未闭合/SKILL.md', '---\nname: 甲\n没有闭合线')

    const outcome = await discoverSkills(project())

    expect(outcome.skills).toEqual([])
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ code: 'skill_invalid_frontmatter', severity: 'error' }),
    ])
  })

  it('清单超 200 条截断：skill_too_many_files warning、filesOmitted 记数', async () => {
    seedSkill('大技能', 'description: 说明')
    for (let index = 1; index <= 205; index += 1) {
      seedFile(`skills/大技能/references/词表${String(index).padStart(3, '0')}.md`, 'x')
    }

    const outcome = await discoverSkills(project())

    expect(outcome.skills).toHaveLength(1)
    const skill = outcome.skills[0]!
    expect(skill.files).toHaveLength(200)
    expect(skill.filesOmitted).toBe(5)
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ code: 'skill_too_many_files', severity: 'warning', skillName: '大技能' }),
    ])
  })

  it('坏技能不阻塞他者：跳过的技能不进目录，好技能照常发现且按 name 排序', async () => {
    seedSkill('乙技能', 'description: 乙的说明')
    seedSkill('丙技能', 'name: 丙\ndescription: 丙的说明')
    seedSkill('甲技能', 'description: 甲的说明')
    seedSkill('坏技能', 'name: 缺描述') // 缺 description → 跳过

    const outcome = await discoverSkills(project())

    expect(outcome.skills.map((skill) => skill.name)).toEqual(['丙技能', '乙技能', '甲技能'])
    // 丙技能 name 不一致发 warning，坏技能缺描述发 error——都不影响好技能进目录
    expect(outcome.diagnostics.map((item) => item.code)).toEqual(['skill_name_mismatch', 'skill_missing_description'])
  })
})
