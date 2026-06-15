import { describe, expect, it } from 'vitest'

import { parseExtractionResponse } from './extractor-llm'

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
