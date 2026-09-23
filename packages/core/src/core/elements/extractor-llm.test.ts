import { describe, expect, it } from 'vitest'

import { buildExtractionSystemPrompt, parseExtractionResponse } from './extractor-llm'

describe('extractor-llm parseExtractionResponse', () => {
  it('parses a clean JSON object into six buckets', () => {
    const raw = JSON.stringify({
      characters: [{ name: '林远', summary: '本章主角', body: '发现旧信' }],
      locations: [{ name: '藏书楼', summary: '废弃场所', body: '深夜进入' }],
      entities: [],
      timeline: [{ name: '深夜', summary: '事件发生时间', body: '发现信件' }],
      plots: [{ name: '发现密信', summary: '核心事件', body: '林远找到十年前的信' }],
      worldbuilding: [{ name: '旧王朝', summary: '历史背景', body: '密信涉及旧王朝' }],
    })

    const result = parseExtractionResponse(raw, 'chapters/第001章.txt')

    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].name).toBe('林远')
    expect(result.characters[0].tags).toContain('AI 提取')
    expect(result.characters[0].lastUpdatedChapter).toBe('chapters/第001章.txt')
    expect(result.locations).toHaveLength(1)
    expect(result.entities).toHaveLength(0)
    expect(result.plots).toHaveLength(1)
    expect(result.worldbuilding).toHaveLength(1)
  })

  it('extracts JSON from a fenced ```json code block', () => {
    const raw = [
      '好的，以下是提取结果：',
      '```json',
      '{"characters":[{"name":"云溪","summary":"女修","body":"出手相助"}],"locations":[],"entities":[],"timeline":[],"plots":[],"worldbuilding":[]}',
      '```',
    ].join('\n')

    const result = parseExtractionResponse(raw, 'chapters/第002章.txt')

    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].name).toBe('云溪')
  })

  it('extracts JSON when surrounded by extra prose without fences', () => {
    const raw = '分析完成。结果如下：\n{"characters":[{"name":"林远","summary":"","body":""}],"locations":[],"entities":[],"timeline":[],"plots":[],"worldbuilding":[]}\n以上是全部要素。'

    const result = parseExtractionResponse(raw, 'chapters/第001章.txt')

    expect(result.characters).toHaveLength(1)
    // summary 为空时应回填默认文案
    expect(result.characters[0].summary).toContain('林远')
  })

  it('skips items missing name and returns empty buckets for non-array fields', () => {
    const raw = JSON.stringify({
      characters: [{ summary: '没有名字' }, { name: '林远', summary: '有效' }],
      locations: '不是一个数组',
      entities: null,
      timeline: [],
      plots: [],
      worldbuilding: [],
    })

    const result = parseExtractionResponse(raw, 'chapters/第001章.txt')

    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].name).toBe('林远')
    expect(result.locations).toHaveLength(0)
  })

  it('returns all-empty buckets when the response is not valid JSON', () => {
    const result = parseExtractionResponse('这不是 JSON，模型跑偏了', 'chapters/第001章.txt')

    expect(result.characters).toHaveLength(0)
    expect(result.locations).toHaveLength(0)
    expect(result.entities).toHaveLength(0)
    expect(result.timeline).toHaveLength(0)
    expect(result.plots).toHaveLength(0)
    expect(result.worldbuilding).toHaveLength(0)
  })

  it('backfills empty body with a default placeholder', () => {
    const raw = JSON.stringify({
      characters: [{ name: '林远', summary: '主角', body: '' }],
      locations: [],
      entities: [],
      timeline: [],
      plots: [],
      worldbuilding: [],
    })

    const result = parseExtractionResponse(raw, 'chapters/第001章.txt')

    expect(result.characters[0].body).toContain('林远')
  })
})

describe('extractor-llm tags merging', () => {
  function parseTags(tags: unknown): string[] {
    const raw = JSON.stringify({
      characters: [{ name: '云溪', summary: '女修', body: '出手相助', tags }],
      locations: [],
      entities: [],
      timeline: [],
      plots: [],
      worldbuilding: [],
    })

    return parseExtractionResponse(raw, 'chapters/第001章.txt').characters[0].tags
  }

  it('merges model-provided tags after the fallback markers', () => {
    expect(parseTags(['主角', '剑修'])).toEqual(['AI 提取', '人物', '主角', '剑修'])
  })

  it('falls back to the two markers when tags are missing or not an array', () => {
    expect(parseTags(undefined)).toEqual(['AI 提取', '人物'])
    expect(parseTags('主角')).toEqual(['AI 提取', '人物'])
  })

  it('drops non-string members, blanks and duplicates', () => {
    expect(parseTags(['主角', 42, '  ', '主角', ' 剑修 ', null])).toEqual(['AI 提取', '人物', '主角', '剑修'])
  })

  it('does not duplicate tags that restate the type name or fallback markers', () => {
    expect(parseTags(['人物', 'AI 提取', '主角'])).toEqual(['AI 提取', '人物', '主角'])
  })
})

describe('extractor-llm buildExtractionSystemPrompt', () => {
  it('injects the five body templates with their section names', () => {
    const prompt = buildExtractionSystemPrompt()

    for (const bucket of ['characters', 'locations', 'entities', 'timeline', 'plots']) {
      expect(prompt).toContain(`${bucket} 模板：`)
    }

    for (const section of ['## 称呼规则', '## 可见性与可达性', '## 当前归属', '## 暗线铺垫', '## 后续影响']) {
      expect(prompt).toContain(section)
    }

    expect(prompt).not.toContain('worldbuilding 模板：')
  })

  it('requires plots to be split per event and forbids umbrella entries', () => {
    const prompt = buildExtractionSystemPrompt()

    expect(prompt).toContain('按独立事件拆分')
    expect(prompt).toContain('禁止输出「本章剧情」「剧情总纲」这类笼统条目')
  })

  it('requires timeline items to carry 所属阶段 and 故事内时间', () => {
    const prompt = buildExtractionSystemPrompt()

    expect(prompt).toContain('「所属阶段」')
    expect(prompt).toContain('「故事内时间」')
  })

  it('documents the optional tags field', () => {
    const prompt = buildExtractionSystemPrompt()

    expect(prompt).toContain('tags（可选）')
    expect(prompt).toContain('"tags":["主角","少年"]')
  })
})
