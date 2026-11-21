import type { RelationElementOptionView } from '@novai/core/services/relation-service'

/**
 * 关系节点在界面上的键：有稳定标识用标识；尚未分配标识的要素（从未被引用过）用
 * `path:<要素文件路径>`。登记关系时服务层按路径定位并懒分配标识，之后图里只剩标识。
 */
const PATH_PREFIX = 'path:'

export function relationNodeKey(option: Pick<RelationElementOptionView, 'id' | 'sourcePath'>): string {
  return option.id || `${PATH_PREFIX}${option.sourcePath}`
}

export function isPathNodeKey(key: string): boolean {
  return key.startsWith(PATH_PREFIX)
}

/** 界面节点键 → 服务层节点选择器 */
export function relationNodeSelector(key: string): { kind: 'element'; id: string } | { kind: 'element'; sourcePath: string } {
  return isPathNodeKey(key)
    ? { kind: 'element', sourcePath: key.slice(PATH_PREFIX.length) }
    : { kind: 'element', id: key }
}
