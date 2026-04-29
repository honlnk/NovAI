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

export function assertTextFilePath(path: string): void {
  if (!TEXT_FILE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) {
    throw new Error('当前工具只支持 .md、.json、.txt 文本文件')
  }
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}
