import type { ProjectFileNodeView } from '@novai/core/services/types'

/**
 * 文件树工具函数。
 *
 * currentProject.files 是嵌套结构：顶层是项目根目录的直接条目（chapters/、elements/ 等
 * 目录节点 + novel.config.json 文件），目录的子项在 node.children 里。
 *
 * 分类面板需要按业务前缀从这棵嵌套树里提取内容，这里集中维护提取逻辑。
 */

/**
 * 在嵌套树里找到路径精确匹配 prefix 的目录节点，返回它的直接子节点（保持目录层级）。
 *
 * 用于章节页：取 chapters/ 目录的直接子项（可能含子目录「卷/部」+ 章节文件）。
 * 用于提示词页：取 prompts/ 目录的直接子项（system.md + scenes/ 子目录）。
 *
 * @param files 全量嵌套树
 * @param prefix 目录路径，如 'chapters' 或 'prompts'
 * @returns 该目录的直接子节点数组；目录不存在时返回 []
 */
export function pickDirectoryChildren(
  files: ProjectFileNodeView[],
  prefix: string,
): ProjectFileNodeView[] {
  for (const node of files) {
    if (node.kind === 'directory' && node.path === prefix) {
      return node.children ?? []
    }
    // 递归往子目录里找（应对嵌套较深的场景）
    if (node.kind === 'directory' && node.children?.length) {
      const found = pickDirectoryChildren(node.children, prefix)
      if (found.length > 0) {
        return found
      }
    }
  }
  return []
}

/**
 * 递归收集某目录前缀下的所有文件节点（拍平，不含目录）。
 *
 * 用于要素页：取 elements/characters/ 等目录下的所有 .md 文件，
 * 无论嵌套多深都收集为扁平列表。
 *
 * 注意：必须**无条件递归遍历所有目录**，因为目标目录的祖先（如 elements/）
 * 自身路径不以 'elements/characters/' 开头，但它的 children 里藏着目标文件。
 * 只在收集 file 节点时做前缀判断即可。
 *
 * @param files 全量嵌套树
 * @param prefix 目录路径前缀，如 'elements/characters'
 * @returns 该前缀下所有 file 节点（已扁平化）；目录不存在或为空时返回 []
 */
export function collectFilesByPrefix(
  files: ProjectFileNodeView[],
  prefix: string,
): ProjectFileNodeView[] {
  const result: ProjectFileNodeView[] = []
  const visit = (nodes: ProjectFileNodeView[]) => {
    for (const node of nodes) {
      // file 节点：路径前缀匹配则收集
      if (node.kind === 'file' && node.path.startsWith(`${prefix}/`)) {
        result.push(node)
        continue
      }
      // directory 节点：无条件递归进 children（祖先目录的 path 不匹配前缀，
      // 但目标文件可能藏在更深层）
      if (node.kind === 'directory' && node.children?.length) {
        visit(node.children)
      }
    }
  }
  visit(files)
  return result
}
