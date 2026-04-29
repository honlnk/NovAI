import {
  createFileTool,
  editFileTool,
  readFileTool,
} from '../tools/file-tools'
import { listDirectoryTool } from '../tools/directory-tools'

import type {
  AgentToolName,
  AgentToolSchema,
} from './messages'
import type {
  CreateFileInput,
  CreateFileOutput,
  EditFileInput,
  EditFileOutput,
  ListDirectoryOutput,
  ReadFileInput,
  ReadFileOutput,
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
          description: '读取当前小说项目中的文本文件，返回带行号的内容。',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '项目内相对路径，例如 chapters/第001章.md',
              },
              offset: {
                type: 'integer',
                minimum: 1,
                description: '可选，从第几行开始读取，默认 1。',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                description: '可选，最多读取多少行。',
              },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      core: readFileTool,
      formatResult(output: ReadFileOutput) {
        return [
          readFileTool.summarizeOutput(output),
          '',
          output.numberedContent || output.content,
        ].join('\n')
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
          description: '用精确文本替换的方式修改当前小说项目中的已有文本文件。',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '项目内相对路径。',
              },
              oldText: {
                type: 'string',
                description: '要替换的原文，必须与文件中内容精确匹配。',
              },
              newText: {
                type: 'string',
                description: '替换后的新文本。',
              },
              replaceAll: {
                type: 'boolean',
                description: '是否替换所有匹配项。默认 false。',
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
          description: '在当前小说项目中新建文本文件；如果目标已存在会失败。',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '项目内相对路径。',
              },
              content: {
                type: 'string',
                description: '新文件完整内容。',
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
  }
}

export function isAgentToolName(value: string): value is AgentToolName {
  return value === 'ReadFile' || value === 'EditFile' || value === 'CreateFile' || value === 'ListDirectory'
}
