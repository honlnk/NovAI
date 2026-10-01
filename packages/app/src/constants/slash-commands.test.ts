import { describe, expect, it } from 'vitest'

import { GARDENER_TASK_PROMPT, INIT_NOVEL_PROMPT } from '@novai/core/services/agent-service'

import { expandSlashCommand, slashCommandDraftText } from './slash-commands'

describe('expandSlashCommand 发送链路前缀拦截（W3 D6）', () => {
  it('行首裸命令：替换为驱动 prompt 全文', () => {
    expect(expandSlashCommand('/整理要素')).toBe(GARDENER_TASK_PROMPT)
    expect(expandSlashCommand('/生成项目记忆')).toBe(INIT_NOVEL_PROMPT)
  })

  it('行首命令 + 参数：prompt 与参数以空行分隔', () => {
    expect(expandSlashCommand('/整理要素 只整理前两章')).toBe(`${GARDENER_TASK_PROMPT}\n\n只整理前两章`)
    expect(expandSlashCommand('/生成项目记忆 重新生成')).toBe(`${INIT_NOVEL_PROMPT}\n\n重新生成`)
  })

  it('命令与参数间的多余空白被收敛，参数本身原样保留', () => {
    expect(expandSlashCommand('/整理要素    提取人物   与地点')).toBe(
      `${GARDENER_TASK_PROMPT}\n\n提取人物   与地点`,
    )
  })

  it('多行草稿：首行命令展开，其余行原样拼回', () => {
    expect(expandSlashCommand('/整理要素\n第二行\n第三行')).toBe(
      `${GARDENER_TASK_PROMPT}\n第二行\n第三行`,
    )
    expect(expandSlashCommand('/整理要素 只整理\n补充说明')).toBe(
      `${GARDENER_TASK_PROMPT}\n\n只整理\n补充说明`,
    )
  })

  it('非行首命令不替换：正文提及命令名不是指令', () => {
    const draft = '可以在正文里提到 /整理要素 这个词'
    expect(expandSlashCommand(draft)).toBe(draft)
  })

  it('未注册命令不替换', () => {
    const draft = '/提取要素 第001章'
    expect(expandSlashCommand(draft)).toBe(draft)
  })

  it('普通草稿原样返回', () => {
    const draft = '帮我把第三章重写得更紧凑一些'
    expect(expandSlashCommand(draft)).toBe(draft)
  })

  it('行首空白容忍（缩进的命令同样命中）', () => {
    expect(expandSlashCommand('  /整理要素')).toBe(GARDENER_TASK_PROMPT)
  })

  it('命令前缀需完整匹配：/整理要素库 不是 /整理要素 命令', () => {
    const draft = '/整理要素库啥的'
    expect(expandSlashCommand(draft)).toBe(draft)
  })
})

describe('slashCommandDraftText 落输入框文本', () => {
  it('命令文本尾部带空格，光标置后可直接补参数', () => {
    expect(slashCommandDraftText('/整理要素')).toBe('/整理要素 ')
  })
})
