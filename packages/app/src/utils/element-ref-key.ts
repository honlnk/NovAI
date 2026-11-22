/**
 * 要素引用在界面上的键：有稳定标识用标识；尚未分配标识的要素（从未被引用过）用
 * `path:<要素文件路径>`。提交时服务层按路径定位并懒分配标识，落盘后草稿只剩标识。
 *
 * 关系图谱节点与时间线参与者/情节共用这套约定。
 */
const PATH_PREFIX = 'path:'

export function elementRefKey(option: { id: string; sourcePath: string }): string {
  return option.id || `${PATH_PREFIX}${option.sourcePath}`
}

export function isPathRefKey(key: string): boolean {
  return key.startsWith(PATH_PREFIX)
}

/** 界面键 → 服务层要素选择器 */
export function elementRefSelector(key: string): { kind: 'element'; id: string } | { kind: 'element'; sourcePath: string } {
  return isPathRefKey(key)
    ? { kind: 'element', sourcePath: key.slice(PATH_PREFIX.length) }
    : { kind: 'element', id: key }
}
