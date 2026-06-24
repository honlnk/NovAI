import { describe, expect, it } from 'vitest'
import {
  CHAPTER_NAME_PATTERN,
  assertChapterNameFormat,
  formatChapterName,
  isChapterNameCompliant,
  isChapterPath,
  parseChapterNumber,
  suggestChapterTitle,
} from './chapter-name'

describe('chapter-name', () => {
  describe('isChapterPath', () => {
    it('returns true for paths under chapters/', () => {
      expect(isChapterPath('chapters/第001章-火中拾婴.txt')).toBe(true)
      expect(isChapterPath('chapters/')).toBe(true)
    })

    it('returns false for non-chapter paths', () => {
      expect(isChapterPath('elements/characters/云溪.md')).toBe(false)
      expect(isChapterPath('prompts/system.md')).toBe(false)
      expect(isChapterPath('novel.config.json')).toBe(false)
    })
  })

  describe('CHAPTER_NAME_PATTERN / isChapterNameCompliant', () => {
    it('accepts compliant names', () => {
      expect(isChapterNameCompliant('第001章-火中拾婴.txt')).toBe(true)
      expect(isChapterNameCompliant('第999章-终局.txt')).toBe(true)
      expect(isChapterNameCompliant('第1000章-超长篇续.txt')).toBe(true) // 超 999 自然 4 位
    })

    it('rejects names missing the title', () => {
      expect(isChapterNameCompliant('第001章.txt')).toBe(false)
    })

    it('rejects names with insufficient zero-padding', () => {
      expect(isChapterNameCompliant('第1章-火中拾婴.txt')).toBe(false)
      expect(isChapterNameCompliant('第01章-火中拾婴.txt')).toBe(false)
    })

    it('rejects wrong extension', () => {
      expect(isChapterNameCompliant('第001章-火中拾婴.md')).toBe(false)
    })

    it('rejects empty title', () => {
      expect(isChapterNameCompliant('第001章-.txt')).toBe(false)
    })

    it('rejects non-chapter filenames', () => {
      expect(isChapterNameCompliant('chapter-001-火中拾婴.txt')).toBe(false)
      expect(isChapterNameCompliant('legacy.md')).toBe(false)
    })

    it('CHAPTER_NAME_PATTERN captures number and title', () => {
      const match = CHAPTER_NAME_PATTERN.exec('第001章-火中拾婴.txt')
      expect(match?.[1]).toBe('001')
      expect(match?.[2]).toBe('火中拾婴')
    })
  })

  describe('parseChapterNumber', () => {
    it('extracts number from compliant names', () => {
      expect(parseChapterNumber('第001章-火中拾婴.txt')).toBe(1)
      expect(parseChapterNumber('第1000章-终局.txt')).toBe(1000)
    })

    it('extracts number from loosely-formatted names', () => {
      expect(parseChapterNumber('第1章.txt')).toBe(1)
      expect(parseChapterNumber('第1章-火中拾婴.txt')).toBe(1) // 补零不足但能提取编号
    })

    it('returns null for names without Chinese chapter marker', () => {
      expect(parseChapterNumber('chapter-001-火中拾婴.txt')).toBeNull()
      expect(parseChapterNumber('legacy.md')).toBeNull()
      expect(parseChapterNumber('火中拾婴.txt')).toBeNull()
    })
  })

  describe('formatChapterName', () => {
    it('pads number to at least 3 digits', () => {
      expect(formatChapterName(1, '火中拾婴')).toBe('第001章-火中拾婴.txt')
      expect(formatChapterName(42, '留他一命')).toBe('第042章-留他一命.txt')
    })

    it('does not truncate numbers over 999', () => {
      expect(formatChapterName(1000, '终局')).toBe('第1000章-终局.txt')
    })

    it('trims the title', () => {
      expect(formatChapterName(1, '  火中拾婴  ')).toBe('第001章-火中拾婴.txt')
    })

    it('throws on empty title', () => {
      expect(() => formatChapterName(1, '')).toThrow('章节标题不能为空')
      expect(() => formatChapterName(1, '   ')).toThrow('章节标题不能为空')
    })
  })

  describe('assertChapterNameFormat', () => {
    it('passes for compliant chapter paths', () => {
      expect(() => assertChapterNameFormat('chapters/第001章-火中拾婴.txt')).not.toThrow()
    })

    it('throws with a helpful message for non-compliant paths', () => {
      expect(() => assertChapterNameFormat('chapters/legacy.txt')).toThrow('章节文件名不规范')
      expect(() => assertChapterNameFormat('chapters/第1章-火中拾婴.txt')).toThrow('章节文件名不规范')
      expect(() => assertChapterNameFormat('chapters/第001章.txt')).toThrow('章节文件名不规范')
    })

    it('error message includes the required format sample', () => {
      expect(() => assertChapterNameFormat('chapters/bad.txt')).toThrow('第NNN章-标题.txt')
    })
  })

  describe('suggestChapterTitle', () => {
    it('uses the first non-empty line as the title source', () => {
      expect(suggestChapterTitle('第一行标题\n正文内容')).toBe('第一行标题')
      expect(suggestChapterTitle('\n\n  第一行标题  \n正文')).toBe('第一行标题')
    })

    it('strips leading Markdown heading markers', () => {
      expect(suggestChapterTitle('# 火中拾婴\n正文')).toBe('火中拾婴')
      expect(suggestChapterTitle('## 第一章 火中拾婴\n正文')).toBe('火中拾婴')
    })

    it('strips leading chapter-number prefix from the line', () => {
      expect(suggestChapterTitle('第001章 火中拾婴\n正文')).toBe('火中拾婴')
      expect(suggestChapterTitle('第1章-火中拾婴\n正文')).toBe('火中拾婴')
    })

    it('truncates long titles with an ellipsis', () => {
      const long = '这是一个非常非常非常长的章节标题文本内容'
      const result = suggestChapterTitle(long)
      expect(result.length).toBeLessThanOrEqual(13) // 12 字 + 省略号
      expect(result.endsWith('…')).toBe(true)
    })

    it('respects custom maxLen', () => {
      // slice(0, maxLen) 截取 4 字，再加省略号
      expect(suggestChapterTitle('火中拾婴记', 4)).toBe('火中拾婴…')
    })

    it('falls back to a placeholder for empty content', () => {
      expect(suggestChapterTitle('')).toBe('未命名章节')
      expect(suggestChapterTitle('\n\n  \n')).toBe('未命名章节')
    })
  })
})
