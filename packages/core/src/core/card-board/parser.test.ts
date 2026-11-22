import { describe, expect, it } from 'vitest'

import {
  firstNonEmptyLine,
  formatFrontmatter,
  formatStringList,
  normalizeOrder,
  normalizeTime,
  parseBoolean,
  parseFrontmatterLines,
  parseNullableString,
  parseStringList,
  sanitizeFileNameFragment,
  splitFrontmatter,
} from './parser'

describe('splitFrontmatter', () => {
  it('拆分标准 frontmatter 与正文', () => {
    const content = '---\nid: F-001\nname: 旧照片之谜\n---\n\n## 读者视角\n\n正文内容'
    const result = splitFrontmatter(content)

    expect(result.frontmatter).toBe('id: F-001\nname: 旧照片之谜')
    expect(result.body).toBe('\n## 读者视角\n\n正文内容')
  })

  it('无 frontmatter 时全文为正文', () => {
    const result = splitFrontmatter('只是正文')
    expect(result.frontmatter).toBe('')
    expect(result.body).toBe('只是正文')
  })

  it('未闭合的 frontmatter 按无 frontmatter 处理', () => {
    const result = splitFrontmatter('---\nid: F-001\n正文混入')
    expect(result.frontmatter).toBe('')
    expect(result.body).toBe('---\nid: F-001\n正文混入')
  })

  it('CRLF 统一为 LF 后拆分', () => {
    const result = splitFrontmatter('---\r\nid: F-001\r\n---\r\n\r\n正文')
    expect(result.frontmatter).toBe('id: F-001')
    expect(result.body).toBe('\n正文')
  })
})

describe('parseFrontmatterLines', () => {
  it('解析 key: value 行', () => {
    expect(parseFrontmatterLines('id: F-001\nstatus: planted')).toEqual({
      id: 'F-001',
      status: 'planted',
    })
  })

  it('注释行与无冒号行跳过（frontmatter 分组注释可用）', () => {
    expect(parseFrontmatterLines('# 计划值（作者/AI 规划时填写）\nid: F-001\n\n无冒号行')).toEqual({
      id: 'F-001',
    })
  })

  it('值内冒号保留（章节路径）', () => {
    expect(parseFrontmatterLines('planted_at: 第一卷/第012章')).toEqual({
      planted_at: '第一卷/第012章',
    })
  })
})

describe('字段规范化', () => {
  it('normalizeOrder：非法与缺失回退 0', () => {
    expect(normalizeOrder(undefined)).toBe(0)
    expect(normalizeOrder('abc')).toBe(0)
    expect(normalizeOrder(' 250 ')).toBe(250)
    expect(normalizeOrder('-3')).toBe(-3)
  })

  it('normalizeTime：非法时间置空串、合法时间原样保留', () => {
    expect(normalizeTime(undefined)).toBe('')
    expect(normalizeTime('not-a-time')).toBe('')
    expect(normalizeTime('2026-11-08T10:00:00.000Z')).toBe('2026-11-08T10:00:00.000Z')
  })

  it('firstNonEmptyLine：跳过空行取首个非空行', () => {
    expect(firstNonEmptyLine('\n\n  \n第一行\n第二行')).toBe('第一行')
    expect(firstNonEmptyLine('')).toBe('')
  })
})

describe('列表与可空字段', () => {
  it('parseStringList：行内数组逐项 trim、丢空项', () => {
    expect(parseStringList('[第一卷/第080章, 第二卷/第090章]')).toEqual(['第一卷/第080章', '第二卷/第090章'])
    expect(parseStringList('[主角, 研究员K]')).toEqual(['主角', '研究员K'])
    expect(parseStringList('[]')).toEqual([])
    expect(parseStringList('null')).toEqual([])
    expect(parseStringList(undefined)).toEqual([])
  })

  it('parseStringList：无括号裸值按单元素容错', () => {
    expect(parseStringList('主角')).toEqual(['主角'])
  })

  it('formatStringList 与 parseStringList 互逆', () => {
    const values = ['主角', '研究员K', '母亲']
    expect(parseStringList(formatStringList(values))).toEqual(values)
    expect(formatStringList([])).toBe('[]')
  })

  it('parseNullableString：null/空串 → null', () => {
    expect(parseNullableString('null')).toBeNull()
    expect(parseNullableString('')).toBeNull()
    expect(parseNullableString(undefined)).toBeNull()
    expect(parseNullableString('第一卷/第120章')).toBe('第一卷/第120章')
  })

  it('parseBoolean：true/false 精确解析，其余回退默认', () => {
    expect(parseBoolean('true', false)).toBe(true)
    expect(parseBoolean('false', true)).toBe(false)
    expect(parseBoolean('yes', true)).toBe(true)
    expect(parseBoolean(undefined, false)).toBe(false)
  })
})

describe('sanitizeFileNameFragment', () => {
  it('去掉文件系统非法字符并压缩空白', () => {
    expect(sanitizeFileNameFragment('旧照片之谜')).toBe('旧照片之谜')
    expect(sanitizeFileNameFragment('母亲 的 沉默')).toBe('母亲_的_沉默')
    expect(sanitizeFileNameFragment('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij')
  })

  it('控制字符清除、清理后为空返回 null', () => {
    expect(sanitizeFileNameFragment('  \u0001 ')).toBeNull()
    expect(sanitizeFileNameFragment('...')).toBe('...')
    expect(sanitizeFileNameFragment('.')).toBeNull()
    expect(sanitizeFileNameFragment('..')).toBeNull()
  })

  it('超长片段截断到 60 字符', () => {
    expect(sanitizeFileNameFragment('长'.repeat(80)).length).toBe(60)
  })
})

describe('formatFrontmatter', () => {
  it('输出 --- 包裹的键值行，null 写 null', () => {
    expect(formatFrontmatter([
      ['id', 'F-001'],
      ['resolved_at', null],
    ])).toBe('---\nid: F-001\nresolved_at: null\n---')
  })
})
