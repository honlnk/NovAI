import { describe, expect, it } from 'vitest'

import { removeDirectoryEntry, removeDirectoryTree } from './remove-directory'

/* ---------- 内存文件系统（桌面 / 手机版 Chrome 两种删除行为） ---------- */

type MemoryFileEntry = {
  kind: 'file'
  name: string
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

type RemoveBehavior = {
  /** 手机版 Chrome：一次性递归删除非空目录报类型不匹配错误（单文件、空文件夹正常）。 */
  phoneStyle?: boolean
  /** 模拟竞态：一次性递归删除连已不存在的目录也报类型不匹配。 */
  recursiveRemoveAlwaysFails?: boolean
  /** 个别环境：不带参数的 `remove()` 不接受目录。 */
  plainRemoveRejectsDirectory?: boolean
}

function createDirectoryHandle(
  entry: MemoryDirectoryEntry,
  parent: MemoryDirectoryEntry | null,
  behavior: RemoveBehavior,
): MemoryDirectoryHandle {
  return {
    kind: 'directory',
    name: entry.name,
    __entry: entry,
    async getDirectoryHandle(name: string) {
      const current = entry.entries.get(name)
      if (current?.kind === 'directory') {
        return createDirectoryHandle(current, entry, behavior)
      }
      if (current) {
        throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      }
      throw new DOMException(`Not found: ${name}`, 'NotFoundError')
    },
    async removeEntry(name: string, options?: { recursive?: boolean }) {
      const current = entry.entries.get(name)
      if (behavior.recursiveRemoveAlwaysFails && options?.recursive) {
        throw new DOMException('Type mismatch', 'TypeMismatchError')
      }
      if (!current) {
        throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      }
      assertRemovable(current, options?.recursive === true, behavior)
      entry.entries.delete(name)
    },
    async remove(options?: { recursive?: boolean }) {
      if (!parent) {
        throw new DOMException('Cannot remove the root directory', 'InvalidModificationError')
      }
      if (behavior.recursiveRemoveAlwaysFails && options?.recursive) {
        throw new DOMException('Type mismatch', 'TypeMismatchError')
      }
      if (parent.entries.get(entry.name) !== entry) {
        throw new DOMException(`Not found: ${entry.name}`, 'NotFoundError')
      }
      assertRemovable(entry, options?.recursive === true, behavior)
      if (behavior.plainRemoveRejectsDirectory && !options?.recursive) {
        throw new DOMException('Not a file', 'TypeMismatchError')
      }
      parent.entries.delete(entry.name)
    },
    async *values() {
      for (const child of entry.entries.values()) {
        yield child.kind === 'directory'
          ? createDirectoryHandle(child, entry, behavior)
          : { kind: 'file', name: child.name } as FileSystemFileHandle
      }
    },
  } as unknown as MemoryDirectoryHandle
}

function assertRemovable(entry: MemoryEntry, recursive: boolean, behavior: RemoveBehavior) {
  if (entry.kind !== 'directory' || entry.entries.size === 0) {
    return
  }
  if (!recursive) {
    throw new DOMException('Directory not empty', 'InvalidModificationError')
  }
  if (behavior.phoneStyle) {
    throw new DOMException('Type mismatch', 'TypeMismatchError')
  }
}

function createRoot(behavior: RemoveBehavior = {}) {
  const entry: MemoryDirectoryEntry = { kind: 'directory', name: 'novel', entries: new Map() }
  return createDirectoryHandle(entry, null, behavior)
}

/** 写入文件（自动建中间目录）。 */
function seedFile(root: MemoryDirectoryHandle, path: string) {
  const fileName = path.split('/').pop() as string
  resolveDirectory(root, path).entries.set(fileName, { kind: 'file', name: fileName })
}

/** 建出一个空目录（自动建中间目录）。 */
function seedEmptyDirectory(root: MemoryDirectoryHandle, path: string) {
  const name = path.split('/').pop() as string
  resolveDirectory(root, path).entries.set(name, { kind: 'directory', name, entries: new Map() })
}

function resolveDirectory(root: MemoryDirectoryHandle, path: string): MemoryDirectoryEntry {
  let current = root.__entry
  for (const segment of path.split('/').slice(0, -1)) {
    const existing = current.entries.get(segment)
    if (existing?.kind === 'file') {
      throw new Error(`路径中段不是目录：${path}`)
    }
    if (existing) {
      current = existing
      continue
    }
    const created: MemoryDirectoryEntry = { kind: 'directory', name: segment, entries: new Map() }
    current.entries.set(segment, created)
    current = created
  }
  return current
}

/** 列出目录下现存的全部相对路径（含空目录），按首次出现的顺序。 */
async function listPaths(handle: FileSystemDirectoryHandle, prefix = ''): Promise<string[]> {
  const paths: string[] = []
  for await (const entry of handle.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      paths.push(path, ...await listPaths(entry as FileSystemDirectoryHandle, path))
    } else {
      paths.push(path)
    }
  }
  return paths
}

describe('removeDirectoryEntry', () => {
  it('桌面：一次性递归删除整个子目录', async () => {
    const root = createRoot()
    seedFile(root, 'skills/SKILL.md')
    seedFile(root, 'skills/references/词表.md')

    await removeDirectoryEntry(root, 'skills')

    expect(await listPaths(root)).toEqual([])
  })

  it('手机版 Chrome（递归删除报类型不匹配）：回退逐项删除，子目录层层清空后删除自身', async () => {
    const root = createRoot({ phoneStyle: true })
    seedFile(root, 'skills/去AI味/SKILL.md')
    seedFile(root, 'skills/去AI味/references/词表.md')
    seedFile(root, 'skills/去AI味/references/deep/笔记.md')
    seedEmptyDirectory(root, 'skills/去AI味/空目录')
    seedFile(root, 'skills/保留/SKILL.md')
    const skills = await root.getDirectoryHandle('skills')

    await removeDirectoryEntry(skills, '去AI味')

    expect(await listPaths(skills)).toEqual(['保留', '保留/SKILL.md'])
  })

  it('手机版 Chrome：空文件夹一次删掉，不需要回退', async () => {
    const root = createRoot({ phoneStyle: true })
    seedFile(root, 'skills/保留/SKILL.md')
    seedEmptyDirectory(root, 'skills/空')
    const skills = await root.getDirectoryHandle('skills')

    await removeDirectoryEntry(skills, '空')

    expect(await listPaths(skills)).toEqual(['保留', '保留/SKILL.md'])
  })

  it('目录不存在：原样上抛 NotFoundError（桌面与手机一致）', async () => {
    for (const behavior of [{}, { phoneStyle: true }]) {
      const root = createRoot(behavior)

      await expect(removeDirectoryEntry(root, '不存在')).rejects.toMatchObject({ name: 'NotFoundError' })
    }
  })

  it('回退途中发现目录已不存在：同样上抛 NotFoundError', async () => {
    const root = createRoot({ recursiveRemoveAlwaysFails: true })

    await expect(removeDirectoryEntry(root, '不存在')).rejects.toMatchObject({ name: 'NotFoundError' })
  })
})

describe('removeDirectoryTree', () => {
  it('桌面：一次性递归删除', async () => {
    const root = createRoot()
    seedFile(root, 'chapters/第一章.md')
    seedFile(root, '.novel/logs/2026.log')

    await removeDirectoryTree(await root.getDirectoryHandle('chapters'))

    expect(await listPaths(root)).toEqual(['.novel', '.novel/logs', '.novel/logs/2026.log'])
  })

  it('手机版 Chrome：先逐项清空，再删除目录自身', async () => {
    const root = createRoot({ phoneStyle: true })
    seedFile(root, 'projects/第一本/chapters/第一章.md')
    seedFile(root, 'projects/第一本/.novel/logs/2026.log')
    seedFile(root, 'projects/第二本/chapters/第一章.md')
    const projects = await root.getDirectoryHandle('projects')

    await removeDirectoryTree(await projects.getDirectoryHandle('第一本'))

    expect(await listPaths(projects)).toEqual(['第二本', '第二本/chapters', '第二本/chapters/第一章.md'])
  })

  it('手机版 Chrome 且不带参数的 remove() 不接受目录：清空后再试一次递归删除', async () => {
    const root = createRoot({ phoneStyle: true, plainRemoveRejectsDirectory: true })
    seedFile(root, 'projects/第一本/chapters/第一章.md')
    const projects = await root.getDirectoryHandle('projects')

    await removeDirectoryTree(await projects.getDirectoryHandle('第一本'))

    expect(await listPaths(projects)).toEqual([])
  })

  it('浏览器没有 remove()：报不支持，不动任何文件', async () => {
    const root = createRoot()
    seedFile(root, 'projects/第一本/chapters/第一章.md')
    const projects = await root.getDirectoryHandle('projects')
    const first = await projects.getDirectoryHandle('第一本')
    delete (first as { remove?: unknown }).remove

    await expect(removeDirectoryTree(first)).rejects.toThrow('不支持直接删除')

    expect(await listPaths(projects)).toEqual(['第一本', '第一本/chapters', '第一本/chapters/第一章.md'])
  })

  it('目录已不存在：原样上抛 NotFoundError', async () => {
    const root = createRoot({ phoneStyle: true })
    seedFile(root, 'projects/第一本/chapters/第一章.md')
    const projects = await root.getDirectoryHandle('projects')
    const first = await projects.getDirectoryHandle('第一本')
    ;(projects as MemoryDirectoryHandle).__entry.entries.delete('第一本')

    await expect(removeDirectoryTree(first)).rejects.toMatchObject({ name: 'NotFoundError' })
  })
})
