const LEFT_SINGLE_CURLY_QUOTE = '‘'
const RIGHT_SINGLE_CURLY_QUOTE = '’'
const LEFT_DOUBLE_CURLY_QUOTE = '“'
const RIGHT_DOUBLE_CURLY_QUOTE = '”'

export function countOccurrences(source: string, needle: string) {
  if (!needle) {
    return 0
  }

  return source.split(needle).length - 1
}

export function findActualText(source: string, searchText: string) {
  if (source.includes(searchText)) {
    return searchText
  }

  const normalizedSource = normalizeQuotes(source)
  const normalizedSearchText = normalizeQuotes(searchText)
  const startIndex = normalizedSource.indexOf(normalizedSearchText)

  if (startIndex === -1) {
    return null
  }

  return source.slice(startIndex, startIndex + searchText.length)
}

export function preserveQuoteStyle(oldText: string, actualOldText: string, newText: string) {
  if (oldText === actualOldText) {
    return newText
  }

  let nextText = newText

  if (actualOldText.includes(LEFT_DOUBLE_CURLY_QUOTE) || actualOldText.includes(RIGHT_DOUBLE_CURLY_QUOTE)) {
    nextText = applyCurlyDoubleQuotes(nextText)
  }

  if (actualOldText.includes(LEFT_SINGLE_CURLY_QUOTE) || actualOldText.includes(RIGHT_SINGLE_CURLY_QUOTE)) {
    nextText = applyCurlySingleQuotes(nextText)
  }

  return nextText
}

function normalizeQuotes(text: string) {
  return text
    .split(LEFT_SINGLE_CURLY_QUOTE).join("'")
    .split(RIGHT_SINGLE_CURLY_QUOTE).join("'")
    .split(LEFT_DOUBLE_CURLY_QUOTE).join('"')
    .split(RIGHT_DOUBLE_CURLY_QUOTE).join('"')
}

function applyCurlyDoubleQuotes(text: string) {
  return replaceStraightQuotes(text, '"', LEFT_DOUBLE_CURLY_QUOTE, RIGHT_DOUBLE_CURLY_QUOTE)
}

function applyCurlySingleQuotes(text: string) {
  return replaceStraightQuotes(text, "'", LEFT_SINGLE_CURLY_QUOTE, RIGHT_SINGLE_CURLY_QUOTE)
}

function replaceStraightQuotes(text: string, straightQuote: string, leftQuote: string, rightQuote: string) {
  let open = true

  return Array.from(text).map((char) => {
    if (char !== straightQuote) {
      return char
    }

    const quote = open ? leftQuote : rightQuote
    open = !open
    return quote
  }).join('')
}
