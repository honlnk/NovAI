/**
 * 关系节点在界面上的键：有稳定标识用标识；尚未分配标识的要素（从未被引用过）用
 * `path:<要素文件路径>`。登记关系时服务层按路径定位并懒分配标识，之后图里只剩标识。
 * 实现与时间线共用 element-ref-key。
 */
export {
  elementRefKey as relationNodeKey,
  isPathRefKey as isPathNodeKey,
  elementRefSelector as relationNodeSelector,
} from './element-ref-key'
