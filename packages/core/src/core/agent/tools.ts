import {
  createFileTool,
  deleteFileTool,
  editFileTool,
  readFileTool,
  renameFileTool,
} from '../tools/file-tools'
import { findFilesTool, listDirectoryTool } from '../tools/directory-tools'
import { ragSearchTool } from '../tools/rag-search'

import type {
  AgentToolName,
  AgentToolSchema,
} from './messages'
import type {
  CreateFileInput,
  CreateFileOutput,
  DeleteFileInput,
  DeleteFileOutput,
  EditFileInput,
  EditFileOutput,
  FindFilesOutput,
  ListDirectoryOutput,
  ReadFileInput,
  ReadFileOutput,
  RagSearchOutput,
  RenameFileInput,
  RenameFileOutput,
  ToolDefinition,
} from '../tools/types'

export type AgentRunnableTool<TInput = unknown, TOutput = unknown> = {
  name: AgentToolName
  isReadOnly: boolean
  isConcurrencySafe: boolean
  schema: AgentToolSchema
  core: ToolDefinition<AgentToolName, TInput, TOutput>
  formatResult(output: TOutput): string
}

export type AgentRunnableToolMap = Record<AgentToolName, AgentRunnableTool>

export function createAgentTools(): AgentRunnableToolMap {
  return {
    ReadFile: {
      name: 'ReadFile',
      isReadOnly: true,
      isConcurrencySafe: true,
      schema: {
        type: 'function',
        function: {
          name: 'ReadFile',
          description: '读取当前小说项目中的 .md、.json、.txt 文本文件，返回带行号的内容；默认最多读取 2000 行。',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '项目内相对路径，例如 chapters/第001章-火中拾婴.txt',
              },
              offset: {
                type: 'integer',
                minimum: 1,
                description: '可选，从第几行开始读取，默认 1。已知目标片段或继续读取长文件时使用。',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                description: '可选，最多读取多少行；默认 2000。长文件应使用 offset/limit 分段读取。',
              },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      core: readFileTool,
      formatResult(output: ReadFileOutput) {
        const notice = output.notice ? `<system-reminder>${output.notice}</system-reminder>` : ''
        const body = output.numberedContent || output.content
        const sections = [
          readFileTool.summarizeOutput(output),
          notice,
          body ? `\n${body}` : '',
        ]

        return sections.filter(Boolean).join('\n')
      },
    },
    EditFile: {
      name: 'EditFile',
      isReadOnly: false,
      isConcurrencySafe: false,
      schema: {
        type: 'function',
        function: {
          name: 'EditFile',
          description: '用精确文本替换的方式修改当前小说项目中的已有文本文件；调用前必须先 ReadFile 读取目标内容。',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '项目内相对路径。',
              },
              oldText: {
                type: 'string',
                description: '要替换的原文，必须来自 ReadFile 返回内容；不要包含行号前缀，保留原文缩进。必须非空。重复文本只改一处时，用目标行加相邻行组成唯一片段。',
              },
              newText: {
                type: 'string',
                description: '替换后的新文本。',
              },
              replaceAll: {
                type: 'boolean',
                description: '是否替换所有匹配项。默认 false；oldText 匹配多处时，如需全部替换才设为 true。',
              },
            },
            required: ['path', 'oldText', 'newText'],
            additionalProperties: false,
          },
        },
      },
      core: editFileTool,
      formatResult(output: EditFileOutput) {
        return editFileTool.summarizeOutput(output)
      },
    },
    CreateFile: {
      name: 'CreateFile',
      isReadOnly: false,
      isConcurrencySafe: false,
      schema: {
        type: 'function',
        function: {
          name: 'CreateFile',
          description: '在当前小说项目中新建文本文件；中间目录会自动创建，目标已存在时会失败。章节必须创建为 chapters/第NNN章-标题.txt（编号至少 3 位补零，标题非空），同编号章节会被拒绝；要素和提示词使用 .md。已有文件请用 EditFile 修改。',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '项目内相对路径；父目录不存在时会自动创建。新建章节必须形如 chapters/第001章-标题.txt，编号至少 3 位补零、标题非空、扩展名 .txt，不能使用 chapters/*.md。',
              },
              content: {
                type: 'string',
                description: '新文件完整内容；章节正文应为纯文本，不要以 Markdown 标题符号 # 开头。',
              },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      core: createFileTool,
      formatResult(output: CreateFileOutput) {
        return createFileTool.summarizeOutput(output)
      },
    },
    RenameFile: {
      name: 'RenameFile',
      isReadOnly: false,
      isConcurrencySafe: false,
      schema: {
        type: 'function',
        function: {
          name: 'RenameFile',
          description: '重命名或移动当前小说项目中的单个文本文件；目标路径已存在时会失败。',
          parameters: {
            type: 'object',
            properties: {
              fromPath: {
                type: 'string',
                description: '要移动或重命名的项目内相对路径；必须是已存在的 .md、.json 或 .txt 文件。',
              },
              toPath: {
                type: 'string',
                description: '新的项目内相对路径；父目录不存在时会自动创建，目标文件不能已存在。移动到 chapters/ 下时必须形如 第NNN章-标题.txt，编号重复会被拒绝。',
              },
            },
            required: ['fromPath', 'toPath'],
            additionalProperties: false,
          },
        },
      },
      core: renameFileTool,
      formatResult(output: RenameFileOutput) {
        return renameFileTool.summarizeOutput(output)
      },
    },
    DeleteFile: {
      name: 'DeleteFile',
      isReadOnly: false,
      isConcurrencySafe: false,
      schema: {
        type: 'function',
        function: {
          name: 'DeleteFile',
          description: '将当前小说项目中的单个文本文件移入回收站；不会直接永久删除。',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '要移入回收站的项目内相对路径；必须是已存在的 .md、.json 或 .txt 文件。',
              },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      core: deleteFileTool,
      formatResult(output: DeleteFileOutput) {
        return deleteFileTool.summarizeOutput(output)
      },
    },
    ListDirectory: {
      name: 'ListDirectory',
      isReadOnly: true,
      isConcurrencySafe: true,
      schema: {
        type: 'function',
        function: {
          name: 'ListDirectory',
          description: '查看当前小说项目中某个目录的直接文件结构；不读取文件内容。',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '可选，项目内目录相对路径；不传则查看项目根目录。',
              },
              showHidden: {
                type: 'boolean',
                description: '是否显示以 . 开头的隐藏文件或目录。默认 false。',
              },
            },
            additionalProperties: false,
          },
        },
      },
      core: listDirectoryTool,
      formatResult(output: ListDirectoryOutput) {
        const lines = output.entries.map((entry) => {
          const marker = entry.kind === 'directory' ? '[dir]' : '[file]'
          return `${marker} ${entry.path}`
        })

        return [
          listDirectoryTool.summarizeOutput(output),
          '',
          lines.join('\n') || '目录为空',
        ].join('\n')
      },
    },
    FindFiles: {
      name: 'FindFiles',
      isReadOnly: true,
      isConcurrencySafe: true,
      schema: {
        type: 'function',
        function: {
          name: 'FindFiles',
          description: '按 glob 模式递归查找当前小说项目中的文件路径；不读取文件内容。',
          parameters: {
            type: 'object',
            properties: {
              pattern: {
                type: 'string',
                description: '必填，glob 文件匹配模式，例如 **/*.md、chapters/*.txt、**/*来信*.md。',
              },
              path: {
                type: 'string',
                description: '可选，项目内目录相对路径；不传则从项目根目录查找。',
              },
              includeHidden: {
                type: 'boolean',
                description: '是否包含以 . 开头的隐藏文件或目录。默认 false。',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 500,
                description: '可选，最多返回多少个匹配文件，默认 100，最大 500。',
              },
            },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
      },
      core: findFilesTool,
      formatResult(output: FindFilesOutput) {
        return [
          findFilesTool.summarizeOutput(output),
          '',
          output.filenames.length ? output.filenames.join('\n') : 'No files found',
          output.truncated ? '\n(结果已截断，请使用更具体的 path 或 pattern。)' : '',
        ].join('\n').trim()
      },
    },
    RagSearch: {
      name: 'RagSearch',
      isReadOnly: true,
      isConcurrencySafe: true,
      schema: {
        type: 'function',
        function: {
          name: 'RagSearch',
          description: '从当前小说项目的 RAG 要素索引中语义检索相关人物、地点、剧情、时间线和世界观设定；适合在写作、改稿或回答设定问题前召回背景上下文。',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: '检索问题或关键词，例如“鸿影 云溪 武当派 第一章需要用到的设定”。',
              },
              topK: {
                type: 'integer',
                minimum: 1,
                description: '可选，向量召回候选数量；不传则使用项目配置 ragCandidateLimit。',
              },
              finalLimit: {
                type: 'integer',
                minimum: 1,
                description: '可选，最终返回给上下文的条数；不传则使用项目配置 ragContextMaxItems。',
              },
              filters: {
                type: 'object',
                properties: {
                  type: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: ['character', 'location', 'entity', 'timeline', 'plot', 'worldbuilding'],
                    },
                    description: '可选，只检索指定类型的要素。',
                  },
                  tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '可选，只检索包含这些标签之一的要素。',
                  },
                  lastUpdatedChapter: {
                    type: 'string',
                    description: '可选，只检索最后关联到指定章节的要素。',
                  },
                },
                additionalProperties: false,
              },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
      core: ragSearchTool,
      formatResult(output: RagSearchOutput) {
        const lines = output.candidates.map((candidate, index) => {
          const score = formatScore(candidate.rerankScore ?? candidate.score)
          const tags = candidate.tags.length ? candidate.tags.join(', ') : '无'
          const chapters = candidate.relatedChapters.length ? candidate.relatedChapters.join(', ') : '无'

          return [
            `#${index + 1} ${candidate.name} (${candidate.type})`,
            `path: ${candidate.sourcePath}`,
            score ? `score: ${score}` : '',
            `tags: ${tags}`,
            `lastUpdatedChapter: ${candidate.lastUpdatedChapter || '无'}`,
            `relatedChapters: ${chapters}`,
            `summary: ${candidate.summary || '无'}`,
            `retrievalText: ${candidate.retrievalText || '无'}`,
          ].filter(Boolean).join('\n')
        })

        return [
          ragSearchTool.summarizeOutput(output),
          `query: ${output.query}`,
          '',
          lines.join('\n\n') || '暂无匹配结果。若项目已有要素，请先在设置中重建 RAG 索引。',
        ].join('\n')
      },
    },
  }
}

export function isAgentToolName(value: string): value is AgentToolName {
  return value === 'ReadFile'
    || value === 'EditFile'
    || value === 'CreateFile'
    || value === 'RenameFile'
    || value === 'DeleteFile'
    || value === 'ListDirectory'
    || value === 'FindFiles'
    || value === 'RagSearch'
}

function formatScore(value: number | undefined) {
  return typeof value === 'number' ? value.toFixed(4) : ''
}
