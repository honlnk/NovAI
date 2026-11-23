/**
 * 删除非空目录（带回退）。
 *
 * 标准做法是让浏览器一次性递归删除，桌面 Chrome 正常；但手机版 Chrome 对非空目录
 * 会直接报类型不匹配错误（单文件、空文件夹的删除正常）。这里先试一次性删除，
 * 失败且不是「目录不存在」时回退为逐项删除。需要删除非空目录的两处调用
 * （删除技能、移除项目并删除本地目录）共用。
 */

/** 带 `remove()` 的目录句柄：`remove()` 并非所有环境都有，恒为可选。 */
export type RemovableDirectoryHandle = FileSystemDirectoryHandle & {
  remove?: (options?: { recursive?: boolean }) => Promise<void>
}

/** 删除父目录下的某个子目录及其全部内容。 */
export async function removeDirectoryEntry(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await parent.removeEntry(name, { recursive: true })
  } catch (error) {
    if (isNotFound(error)) {
      throw error
    }

    const child = await parent.getDirectoryHandle(name)
    await clearDirectory(child)
    await parent.removeEntry(name)
  }
}

/** 删除一个已经拿到句柄的目录及其全部内容（拿不到父目录时使用）。 */
export async function removeDirectoryTree(directory: FileSystemDirectoryHandle): Promise<void> {
  const target = directory as RemovableDirectoryHandle

  if (!target.remove) {
    throw new Error('当前浏览器不支持直接删除这个目录，请在系统文件管理器中手动删除。')
  }

  try {
    await target.remove({ recursive: true })
  } catch (error) {
    if (isNotFound(error)) {
      throw error
    }

    await clearDirectory(directory)
    try {
      await target.remove()
    } catch {
      // 目录已清空，个别环境的 `remove()` 不接受目录：再试一次递归删除
      await target.remove({ recursive: true })
    }
  }
}

async function clearDirectory(directory: FileSystemDirectoryHandle): Promise<void> {
  // 先把子项列完再逐个删：边遍历边删会漏项或报错。
  const children: FileSystemHandle[] = []
  for await (const entry of directory.values()) {
    children.push(entry)
  }

  for (const child of children) {
    if (child.kind === 'directory') {
      await clearDirectory(child as FileSystemDirectoryHandle)
    }
    await directory.removeEntry(child.name)
  }
}

function isNotFound(error: unknown) {
  return error instanceof DOMException && error.name === 'NotFoundError'
}
