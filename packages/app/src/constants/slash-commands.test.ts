import { describe, expect, it } from 'vitest'

import { ELEMENT_MANAGER_TASK_PROMPT, INIT_NOVEL_PROMPT } from '@novai/core/services/agent-service'

import { bareSlashCommandHint, expandSlashCommand, slashCommandDraftText } from './slash-commands'

describe('expandSlashCommand 发送链路前缀拦截（W3 D6）', () => {
  it('行首裸命令：替换为驱动 prompt 全文', () => {
    expect(expandSlashCommand('/管理要素')).toBe(ELEMENT_MANAGER_TASK_PROMPT)
    expect(expandSlashCommand('/生成项目记忆')).toBe(INIT_NOVEL_PROMPT)
  })

  it('行首命令 + 参数：prompt 与参数以空行分隔', () => {
    expect(expandSlashCommand('/管理要素 只整理前两章')).toBe(`${ELEMENT_MANAGER_TASK_PROMPT}\n\n只整理前两章`)
    expect(expandSlashCommand('/生成项目记忆 重新生成')).toBe(`${INIT_NOVEL_PROMPT}\n\n重新生成`)
  })

  it('命令与参数间的多余空白被收敛，参数本身原样保留', () => {
    expect(expandSlashCommand('/管理要素    提取人物   与地点')).toBe(
      `${ELEMENT_MANAGER_TASK_PROMPT}\n\n提取人物   与地点`,
    )
  })

  it('多行草稿：首行命令展开，其余行原样拼回', () => {
    expect(expandSlashCommand('/管理要素\n第二行\n第三行')).toBe(
      `${ELEMENT_MANAGER_TASK_PROMPT}\n第二行\n第三行`,
    )
    expect(expandSlashCommand('/管理要素 只整理\n补充说明')).toBe(
      `${ELEMENT_MANAGER_TASK_PROMPT}\n\n只整理\n补充说明`,
    )
  })

  it('非行首命令不替换：正文提及命令名不是指令', () => {
    const draft = '可以在正文里提到 /管理要素 这个词'
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
    expect(expandSlashCommand('  /管理要素')).toBe(ELEMENT_MANAGER_TASK_PROMPT)
  })

  it('命令前缀需完整匹配：/管理要素库 不是 /管理要素 命令', () => {
    const draft = '/管理要素库啥的'
    expect(expandSlashCommand(draft)).toBe(draft)
  })
})

describe('slashCommandDraftText 落输入框文本', () => {
  it('命令文本尾部带空格，光标置后可直接补参数', () => {
    expect(slashCommandDraftText('/管理要素')).toBe('/管理要素 ')
  })
})

describe('bareSlashCommandHint 裸发行内提示（入口重构 W1）', () => {
  it('裸发形态（命令文本 + 尾随空白）返回配置的提示', () => {
    expect(bareSlashCommandHint('/管理要素 ')).toBe('← 可在此补充范围/目标，留空则整理整个要素库')
    expect(bareSlashCommandHint('/管理要素')).toBe('← 可在此补充范围/目标，留空则整理整个要素库')
  })

  it('带参数 / 多行 / 未配置 bareHint 的命令不提示', () => {
    expect(bareSlashCommandHint('/管理要素 只整理前两章')).toBe('')
    expect(bareSlashCommandHint('/管理要素\n补充说明')).toBe('')
    expect(bareSlashCommandHint('/生成项目记忆 ')).toBe('')
    expect(bareSlashCommandHint('')).toBe('')
  })

  it('正文里包含命令文本不提示（须整条草稿恰为命令）', () => {
    expect(bareSlashCommandHint('帮忙跑一下 /管理要素 ')).toBe('')
  })
})
