import { describe, expect, it } from 'vitest'
import {
  CHAPTER_NAME_PATTERN,
  assertChapterNameFormat,
  isChapterPath,
  parseChapterNumber,
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

  describe('CHAPTER_NAME_PATTERN', () => {
    it('accepts compliant names', () => {
      expect(CHAPTER_NAME_PATTERN.test('第001章-火中拾婴.txt')).toBe(true)
      expect(CHAPTER_NAME_PATTERN.test('第999章-终局.txt')).toBe(true)
      expect(CHAPTER_NAME_PATTERN.test('第1000章-超长篇续.txt')).toBe(true) // 超 999 自然 4 位
    })

    it('rejects names missing the title', () => {
      expect(CHAPTER_NAME_PATTERN.test('第001章.txt')).toBe(false)
    })

    it('rejects names with insufficient zero-padding', () => {
      expect(CHAPTER_NAME_PATTERN.test('第1章-火中拾婴.txt')).toBe(false)
      expect(CHAPTER_NAME_PATTERN.test('第01章-火中拾婴.txt')).toBe(false)
    })

    it('rejects wrong extension', () => {
      expect(CHAPTER_NAME_PATTERN.test('第001章-火中拾婴.md')).toBe(false)
    })

    it('rejects empty title', () => {
      expect(CHAPTER_NAME_PATTERN.test('第001章-.txt')).toBe(false)
    })

    it('rejects non-chapter filenames', () => {
      expect(CHAPTER_NAME_PATTERN.test('chapter-001-火中拾婴.txt')).toBe(false)
      expect(CHAPTER_NAME_PATTERN.test('legacy.md')).toBe(false)
    })

    it('captures number and title', () => {
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
})
