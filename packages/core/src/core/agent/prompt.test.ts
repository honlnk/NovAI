import { describe, expect, it } from 'vitest'

import { buildAgentSystemPrompt } from './prompt'
import { hashContent } from '../util/hash'

describe('buildAgentSystemPrompt', () => {
  it('falls back to default opening when no variable inputs given', () => {
    const prompt = buildAgentSystemPrompt()
    expect(prompt).toContain('你是 NovAI')
    // 项目总览 / 场景提示词段落不应出现
    expect(prompt).not.toContain('项目总览')
    expect(prompt).not.toContain('当前场景提示词')
  })

  it('injects novaiOverview into the prompt when provided', () => {
    const prompt = buildAgentSystemPrompt({ novaiOverview: '这是一部武侠小说，主角是云溪。' })
    expect(prompt).toContain('项目总览')
    expect(prompt).toContain('这是一部武侠小说，主角是云溪。')
  })

  it('injects scenePrompt into the prompt when provided', () => {
    const prompt = buildAgentSystemPrompt({ scenePrompt: '本章场景：鸿家庄灭门之夜' })
    expect(prompt).toContain('当前场景提示词')
    expect(prompt).toContain('本章场景：鸿家庄灭门之夜')
  })

  it('places novaiOverview before scenePrompt in the variable head', () => {
    const prompt = buildAgentSystemPrompt({
      novaiOverview: '总览占位 ABC',
      scenePrompt: '场景占位 XYZ',
    })
    const overviewIndex = prompt.indexOf('总览占位 ABC')
    const sceneIndex = prompt.indexOf('场景占位 XYZ')
    expect(overviewIndex).toBeGreaterThan(-1)
    expect(sceneIndex).toBeGreaterThan(-1)
    // 项目总览（相对稳定的项目记忆）应在最具体的场景提示词之前
    expect(overviewIndex).toBeLessThan(sceneIndex)
  })

  it('treats whitespace-only novaiOverview as absent', () => {
    const prompt = buildAgentSystemPrompt({ novaiOverview: '   \n  ' })
    expect(prompt).not.toContain('项目总览')
  })

  it('produces different hash when novaiOverview changes', () => {
    // 这是 systemPromptHash 刷新机制的关键：NovAI.md 内容变化 → system prompt 文本变化 → hash 变化 → 下一轮刷新。
    const withoutOverview = buildAgentSystemPrompt({ systemPrompt: '文风：冷峻' })
    const withOverview = buildAgentSystemPrompt({
      systemPrompt: '文风：冷峻',
      novaiOverview: '主角已觉醒第二形态',
    })
    expect(hashContent(withoutOverview)).not.toBe(hashContent(withOverview))
  })

  it('always appends the fixed working principles regardless of inputs', () => {
    const prompt = buildAgentSystemPrompt({
      systemPrompt: '自定义',
      novaiOverview: '总览',
      scenePrompt: '场景',
    })
    // 固定规则文本（工具使用原则）必须在所有变量输入之后
    expect(prompt).toContain('工作原则')
    expect(prompt).toContain('要素分组规则')
  })
})
