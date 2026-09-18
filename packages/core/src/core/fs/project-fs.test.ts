import { describe, expect, it } from 'vitest'

import { createDefaultConfig } from '../project/defaults'
import { readProjectConfig, repairProject, writeProjectConfig } from './project-fs'

describe('project fs repair', () => {
  it('does not recreate the default scene prompt after it has been deleted or renamed', async () => {
    const rootHandle = createMemoryDirectory('novel')

    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      project: {
        name: 'Test Novel',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }))
    writeProjectTextSync(rootHandle, '.novel/manifest.json', JSON.stringify({
      projectId: 'test-project',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
    }))
    writeProjectTextSync(rootHandle, 'prompts/system.md', '# System Prompt')
    writeProjectTextSync(rootHandle, 'prompts/scenes/renamed-scene.md', '# Renamed Scene Prompt')

    const project = await repairProject(rootHandle)

    expect(project.tree).toContainEqual(expect.objectContaining({
      kind: 'directory',
      path: 'prompts',
    }))
    await expect(readProjectText(rootHandle, 'prompts/scenes/scene-001.md')).rejects.toThrow('Not found')
    await expect(readProjectText(rootHandle, 'prompts/scenes/renamed-scene.md')).resolves.toBe('# Renamed Scene Prompt')
  })
})

describe('project config 数值钳制', () => {
  it('越界值钳到 UI 边界，非法值回退默认；agentMaxTurns 不钳（W6 安全阀语义预留）', async () => {
    const rootHandle = createMemoryDirectory('novel')
    const config = createDefaultConfig('novel')
    const saved = await writeProjectConfig(rootHandle, {
      ...config,
      rerank: { ...config.rerank, topN: 0 },
      completion: { ...config.completion, debounceMs: 10, maxTokens: 9999 },
      settings: {
        ...config.settings,
        ragCandidateLimit: -3,
        ragContextMaxItems: 500,
        conversationTokenLimit: 5,
        compressionKeepRecentTurns: 0,
        agentMaxTurns: 0,
      },
    })

    expect(saved.settings.conversationTokenLimit).toBe(1000)
    expect(saved.settings.compressionKeepRecentTurns).toBe(1)
    expect(saved.settings.ragCandidateLimit).toBe(1)
    expect(saved.settings.ragContextMaxItems).toBe(50)
    expect(saved.completion.debounceMs).toBe(200)
    expect(saved.completion.maxTokens).toBe(256)
    expect(saved.rerank.topN).toBe(1)
    // W6 前不钳 agentMaxTurns：0 原样保留
    expect(saved.settings.agentMaxTurns).toBe(0)

    // 上限方向也钳
    const savedHigh = await writeProjectConfig(rootHandle, {
      ...config,
      settings: {
        ...config.settings,
        conversationTokenLimit: 999999,
        compressionKeepRecentTurns: 100,
      },
    })
    expect(savedHigh.settings.conversationTokenLimit).toBe(200000)
    expect(savedHigh.settings.compressionKeepRecentTurns).toBe(20)
  })

  it('JSON 里的非数值（null/字符串/缺失）回退默认值', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({
      settings: {
        conversationTokenLimit: null,
        compressionKeepRecentTurns: 'abc',
        ragCandidateLimit: 30,
      },
    }))

    const config = await readProjectConfig(rootHandle)

    expect(config.settings.conversationTokenLimit).toBe(12000)
    expect(config.settings.compressionKeepRecentTurns).toBe(5)
    expect(config.settings.ragCandidateLimit).toBe(30)
  })

  it('权限档位：旧配置缺字段回填默认档，非法值回退默认档', async () => {
    const rootHandle = createMemoryDirectory('novel')
    writeProjectTextSync(rootHandle, 'novel.config.json', JSON.stringify({ settings: {} }))

    const config = await readProjectConfig(rootHandle)
    expect(config.settings.permissionPreset).toBe('chapter-material')

    await writeProjectConfig(rootHandle, {
      ...config,
      settings: { ...config.settings, permissionPreset: 'nonsense' as never },
    })
    expect((await readProjectConfig(rootHandle)).settings.permissionPreset).toBe('chapter-material')

    // 合法档位原样保留
    await writeProjectConfig(rootHandle, {
      ...config,
      settings: { ...config.settings, permissionPreset: 'review' },
    })
    expect((await readProjectConfig(rootHandle)).settings.permissionPreset).toBe('review')
  })
})

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
  return createDirectoryHandle({
    kind: 'directory',
    name,
    entries: new Map(),
  })
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

      const next: MemoryDirectoryEntry = {
        kind: 'directory',
        name,
        entries: new Map(),
      }
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

      const next: MemoryFileEntry = {
        kind: 'file',
        name,
        content: '',
        lastModified: Date.now(),
      }
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
        yield child.kind === 'directory'
          ? createDirectoryHandle(child)
          : createFileHandle(child)
      }
    },
  } as unknown as MemoryDirectoryHandle
}

function createFileHandle(entry: MemoryFileEntry): FileSystemFileHandle {
  return {
    kind: 'file',
    name: entry.name,
    async getFile() {
      return new File([entry.content], entry.name, {
        type: 'text/plain',
        lastModified: entry.lastModified,
      })
    },
    async createWritable() {
      let nextContent = ''

      return {
        async write(data: FileSystemWriteChunkType) {
          nextContent = typeof data === 'string'
            ? data
            : data instanceof Blob
              ? await data.text()
              : String(data)
        },
        async close() {
          entry.content = nextContent
          entry.lastModified = Date.now()
        },
      } as FileSystemWritableFileStream
    },
  } as unknown as FileSystemFileHandle
}

function writeProjectTextSync(rootHandle: MemoryDirectoryHandle, path: string, content: string) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()

  if (!fileName) {
    throw new Error(`Invalid file path: ${path}`)
  }

  let current = rootHandle.__entry

  for (const segment of segments) {
    const existing = current.entries.get(segment)

    if (existing?.kind === 'file') {
      throw new Error(`Not a directory: ${segment}`)
    }

    if (existing?.kind === 'directory') {
      current = existing
      continue
    }

    const next: MemoryDirectoryEntry = {
      kind: 'directory',
      name: segment,
      entries: new Map(),
    }
    current.entries.set(segment, next)
    current = next
  }

  current.entries.set(fileName, {
    kind: 'file',
    name: fileName,
    content,
    lastModified: Date.now(),
  })
}

async function readProjectText(rootHandle: FileSystemDirectoryHandle, path: string) {
  const fileHandle = await resolveMemoryFileHandle(rootHandle, path)
  return (await fileHandle.getFile()).text()
}

async function resolveMemoryFileHandle(
  rootHandle: FileSystemDirectoryHandle,
  path: string,
) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()

  if (!fileName) {
    throw new Error(`Invalid file path: ${path}`)
  }

  let current = rootHandle

  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment)
  }

  return current.getFileHandle(fileName)
}
