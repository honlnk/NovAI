// @vitest-environment happy-dom
/**
 * 输入区自适应高度（fitComposerHeight）回归：量高度时的 auto 会让宿主瞬间不再溢出、浏览器把滚动位置
 * 钳回 0——长草稿里每删一个字就跳回最开头的根因。happy-dom 没有布局，这里给宿主挂一套最小滚动模型
 * （读布局即按当前高度钳 scrollTop），并用对照用例证明模型与浏览器行为一致。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPOSER_MAX_HEIGHT, fitComposerHeight } from './composer-height'

const HOST_TOP = 100
const LINE_HEIGHT = 24

/** 宿主在视口里的位置：内容超过上限时高度恒为上限 */
const hostRect = {
  top: HOST_TOP,
  bottom: HOST_TOP + COMPOSER_MAX_HEIGHT,
  left: 0,
  right: 320,
  width: 320,
  height: COMPOSER_MAX_HEIGHT,
  x: 0,
  y: HOST_TOP,
  toJSON: () => ({}),
} as DOMRect

function caretRect(top: number): DOMRect {
  return {
    top,
    bottom: top + LINE_HEIGHT,
    left: 0,
    right: 0,
    width: 0,
    height: LINE_HEIGHT,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

const EMPTY_RECT = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect

/**
 * 给宿主挂一套最小滚动模型：clientHeight 取 inline height（没设或 auto 时等于内容高），scrollHeight
 * 不小于 clientHeight；任何一次读取布局都先按当前可滚范围钳掉越界的 scrollTop——这正是 height 设成
 * auto 的瞬间（内容不再溢出）滚动位置被清零的过程。
 */
function mockScroller(host: HTMLElement, contentHeight: number) {
  let content = contentHeight
  let top = 0
  let left = 0
  const natural = () => host.style.height === '' || host.style.height === 'auto'
  const clientHeight = () => (natural() ? content : parseFloat(host.style.height))
  const maxScroll = () => Math.max(0, content - clientHeight())
  // 浏览器在布局时钳；这里在每次读写布局时钳，对外表现一致
  const settle = () => {
    top = Math.max(0, Math.min(top, maxScroll()))
  }
  Object.defineProperties(host, {
    clientHeight: {
      configurable: true,
      get: () => {
        settle()
        return clientHeight()
      },
    },
    scrollHeight: {
      configurable: true,
      get: () => {
        settle()
        return Math.max(content, clientHeight())
      },
    },
    scrollTop: {
      configurable: true,
      get: () => {
        settle()
        return top
      },
      set: (value: number) => {
        top = value
        settle()
      },
    },
    scrollLeft: {
      configurable: true,
      get: () => left,
      set: (value: number) => {
        left = value
      },
    },
  })
  return {
    setContentHeight: (height: number) => {
      content = height
    },
    /** 用户滚动：直接落位，不经钳 */
    scrollTo: (value: number) => {
      top = value
    },
  }
}

function select(range: Range) {
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

/** 让选区的矩形列表返回 rects（空数组 = 量不出矩形） */
function stubCaretRects(rects: DOMRect[]) {
  vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(rects as unknown as DOMRectList)
}

/** 把（折叠的）光标放进 container 末尾的文本里，并让它的矩形列表返回 rects */
function placeCaret(container: HTMLElement, rects: DOMRect[]) {
  container.textContent = '草稿'
  const range = document.createRange()
  range.setStart(container.firstChild!, container.textContent.length)
  range.collapse(true)
  select(range)
  stubCaretRects(rects)
}

describe('fitComposerHeight 高度与滚动位置', () => {
  let host: HTMLElement
  let layout: ReturnType<typeof mockScroller>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    // 长草稿：内容 520px，超过 200px 上限
    layout = mockScroller(host, 520)
    fitComposerHeight(host)
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('内容超过上限：高度钳在上限', () => {
    expect(host.style.height).toBe(`${COMPOSER_MAX_HEIGHT}px`)
    expect(host.clientHeight).toBe(COMPOSER_MAX_HEIGHT)
  })

  it('长草稿滚到底后删一个字：滚动位置保住，不再跳回最开头', () => {
    layout.scrollTo(320)
    fitComposerHeight(host)
    expect(host.scrollTop).toBe(320)
  })

  it('对照：量完高度不还原滚动位置，它就被清零（模型与浏览器行为一致）', () => {
    layout.scrollTo(320)
    host.style.height = 'auto'
    host.style.height = `${Math.min(host.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
    expect(host.scrollTop).toBe(0)
  })

  it('内容变短：还原的旧位置钳到新的可滚上限，仍停在末尾', () => {
    layout.scrollTo(320)
    layout.setContentHeight(480)
    fitComposerHeight(host)
    expect(host.scrollTop).toBe(280)
  })

  it('内容没超上限：高度贴合内容，不产生滚动', () => {
    layout.setContentHeight(120)
    fitComposerHeight(host)
    expect(host.style.height).toBe('120px')
    expect(host.scrollTop).toBe(0)
  })

  it('横向滚动位置同样保住', () => {
    layout.scrollTo(320)
    host.scrollLeft = 24
    fitComposerHeight(host)
    expect(host.scrollLeft).toBe(24)
  })
})

describe('fitComposerHeight 光标显露', () => {
  let host: HTMLElement
  let layout: ReturnType<typeof mockScroller>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    // 内容 600px（可滚 0–400），停在 320：上下都还有滚动余量
    layout = mockScroller(host, 600)
    fitComposerHeight(host)
    layout.scrollTo(320)
    host.focus()
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(hostRect)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.getSelection()?.removeAllRanges()
    document.body.innerHTML = ''
  })

  it('内容在末尾增长、光标落到视野下方：向下滚到整行露出', () => {
    placeCaret(host, [caretRect(312)])
    fitComposerHeight(host)
    expect(host.scrollTop).toBe(356)
  })

  it('光标在视野上方：向上滚到整行露出', () => {
    placeCaret(host, [caretRect(60)])
    fitComposerHeight(host)
    expect(host.scrollTop).toBe(280)
  })

  it('光标在视野内：滚动位置不动', () => {
    placeCaret(host, [caretRect(250)])
    fitComposerHeight(host)
    expect(host.scrollTop).toBe(320)
  })

  it('边缘 1px 内的亚像素差不算被挡', () => {
    placeCaret(host, [caretRect(300.4 - LINE_HEIGHT)])
    fitComposerHeight(host)
    expect(host.scrollTop).toBe(320)
  })

  it('编辑器没有焦点（焦点在别的控件上）：只保住滚动位置，不追光标', () => {
    host.blur()
    expect(document.activeElement).not.toBe(host)
    placeCaret(host, [caretRect(312)])
    fitComposerHeight(host)
    expect(host.scrollTop).toBe(320)
  })

  it('光标不在宿主里：不介入', () => {
    const elsewhere = document.createElement('div')
    elsewhere.textContent = '别处'
    document.body.appendChild(elsewhere)
    placeCaret(elsewhere, [caretRect(312)])
    fitComposerHeight(host)
    expect(host.scrollTop).toBe(320)
  })

  it('量不出任何矩形：不动也不报错', () => {
    placeCaret(host, [])
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(EMPTY_RECT)
    fitComposerHeight(host)
    expect(host.scrollTop).toBe(320)
  })

  it('空行上的光标（刚换过行）量不出矩形：改用所在段落的盒子', () => {
    host.innerHTML = '<p><br></p>'
    const line = host.querySelector('p')!
    const range = document.createRange()
    range.setStart(line, 0)
    range.collapse(true)
    select(range)
    stubCaretRects([])
    vi.spyOn(line, 'getBoundingClientRect').mockReturnValue(caretRect(312))
    fitComposerHeight(host)
    expect(host.scrollTop).toBe(356)
  })
})
