import type { ChatTargetContext } from '../../types/chat'
import type { ProjectSnapshot } from '../../types/project'

export function buildAgentSystemPrompt(customPrompt?: string) {
  const userPrompt = customPrompt?.trim()

  return [
    userPrompt || '你是 NovAI，一个通过工具读写本地小说项目文件的写作 Agent。',
    '',
    '你是交互式小说创作 Agent。你的工作不是把所有正文都堆到聊天里，而是理解用户意图，然后使用工具读取、修改或创建项目文件。',
    '',
    '工作原则：',
    '- 用户的小说、章节、设定、提示词和素材都应保存在项目文件系统中。',
    '- 对已有文件动手前，先使用 ReadFile 读取相关内容。',
    '- 修改已有文件时，优先使用 EditFile 做精确替换；不要在没有读过原文时盲目改写。',
    '- 新建章节、设定或提示词文件时，使用 CreateFile。',
    '- 聊天回复用于说明你做了什么、为什么这么做、下一步建议是什么；不要把完整长篇正文当作唯一结果留在聊天里。',
    '- 如果缺少目标路径或上下文，先说明你需要什么，或先读取项目中最相关的文件。',
    '- 保持中文输出，除非用户明确要求其他语言。',
    '',
    '工具使用规则：',
    '- ReadFile 用于读取 .md、.json、.txt 文件。',
    '- EditFile 用于精确替换已有文件中的片段。oldText 必须来自已读取的文件内容，尽量提供足够上下文避免误替换。',
    '- CreateFile 用于创建不存在的新文件；目标已存在时会失败。',
    '- 可以连续使用多个工具完成任务。完成工具调用后，继续根据工具结果判断是否还需要下一步。',
    '- 完成任务后，用简短自然语言总结变更，不要重复输出整个文件。',
  ].join('\n')
}

export function buildAgentUserContext(input: {
  instruction: string
  project: ProjectSnapshot
  target: ChatTargetContext | null
}) {
  const target = input.target?.primaryPath
    ? `${input.target.displayName} (${input.target.primaryPath})`
    : input.target?.displayName || '当前项目'

  return [
    `用户意图：${input.instruction}`,
    '',
    `当前项目：${input.project.name}`,
    `默认目标：${target}`,
    '',
    '项目文件：',
    listReadableFiles(input.project).join('\n') || '- 暂无可读文本文件',
    '',
    '请按照系统要求，通过工具读取或修改文件。若任务已经完成，请直接总结。若需要写文件，直接调用合适的文件工具。',
  ].join('\n')
}

function listReadableFiles(project: ProjectSnapshot) {
  const files: string[] = []
  const stack = [...project.tree]

  while (stack.length > 0) {
    const node = stack.shift()

    if (!node) {
      continue
    }

    if (node.kind === 'file' && /\.(md|json|txt)$/i.test(node.name)) {
      files.push(`- ${node.path}`)
      continue
    }

    if (node.children?.length) {
      stack.unshift(...node.children)
    }
  }

  return files.sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
}
