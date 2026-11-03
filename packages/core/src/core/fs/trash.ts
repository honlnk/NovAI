/**
 * 回收站路径生成（软删除语义的统一实现）。
 *
 * DeleteFile 工具与计划卡片删除共用：被删文件先写入 `.novel/trash/{时间戳-随机串}/{原路径}`，
 * 再删除原文件。原路径含子目录时保留目录结构，便于按原位置恢复。
 */
export function createTrashPath(path: string, now = new Date()): string {
  const stamp = [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, '0'),
    `${now.getDate()}`.padStart(2, '0'),
    `${now.getHours()}`.padStart(2, '0'),
    `${now.getMinutes()}`.padStart(2, '0'),
    `${now.getSeconds()}`.padStart(2, '0'),
    Math.random().toString(36).slice(2, 8),
  ].join('-')

  return `.novel/trash/${stamp}/${path}`
}
