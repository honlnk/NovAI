import { scanElementCatalog } from '../elements/catalog'
import { readProjectFile } from '../fs/project-fs'

import type { LoadElementsInput, LoadElementsOutput, LoadedElement, ToolDefinition } from './types'

/**
 * LoadElements（渐进式披露 L2，决策 0007）：按要素名批量加载四类稳定要素
 * （characters/locations/entities/worldbuilding）的完整正文。要素目录 reminder（L1）
 * 里的 name 即本工具的入参；未知名不抛错，返回 notFound 标记让模型自行处理。
 */
export const loadElementsTool: ToolDefinition<'LoadElements', LoadElementsInput, LoadElementsOutput> = {
  name: 'LoadElements',
  description: '批量加载角色/地点/实体/世界观要素的完整定义（含 frontmatter 与正文）。',
  validateInput(input) {
    if (!input || typeof input !== 'object') {
      throw new Error('LoadElements 参数必须是包含 names 数组的对象')
    }

    const raw = (input as Record<string, unknown>).names
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('names 必须是非空字符串数组（来自上下文中的要素清单）')
    }

    const names = raw.map((name) => {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('names 只能包含非空字符串')
      }
      return name.trim()
    })

    return { names }
  },
  async run(input, runtime) {
    const entries = await scanElementCatalog(runtime.project)
    const byName = new Map(entries.map((entry) => [entry.name, entry]))

    const elements: LoadedElement[] = []
    for (const name of input.names) {
      const entry = byName.get(name)
      if (!entry) {
        elements.push({ name, notFound: true })
        continue
      }
      const file = await readProjectFile(runtime.project, entry.sourcePath)
      elements.push({
        name: entry.name,
        type: entry.type,
        sourcePath: entry.sourcePath,
        content: file.content,
      })
    }

    return { elements }
  },
  summarizeInput(input) {
    return `加载要素：${input.names.join('、')}`
  },
  summarizeOutput(output) {
    const found = output.elements.filter((element) => !element.notFound)
    const missing = output.elements.length - found.length
    const base = `已加载 ${found.length} 个要素定义`
    return missing > 0 ? `${base}，${missing} 个未找到` : base
  },
}

/**
 * 工具结果渲染（仿 dsh renderSkillContent）：每个要素一帧 `<element_content>`；
 * 未找到的标记 notFound 并提示回看清单，不渲染空帧。
 */
export function renderElementContent(output: LoadElementsOutput): string {
  const frames = output.elements.map((element) => {
    if (element.notFound) {
      return `<element_content name="${element.name}" notFound="true"/>\n未找到名为「${element.name}」的要素；请核对要素清单中的名称后重试。`
    }
    return [
      `<element_content name="${element.name}" type="${element.type}" path="${element.sourcePath}">`,
      (element.content ?? '').trimEnd(),
      '</element_content>',
    ].join('\n')
  })

  return [loadElementsTool.summarizeOutput(output), ...frames].join('\n\n')
}
