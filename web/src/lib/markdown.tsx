import { Fragment, type ReactNode } from 'react'

/**
 * Markdown, hand-rolled, for the chat transcript.
 *
 * ChatView renders what the assistant *wrote* — markdown source straight out
 * of the session transcript — and this is the whole renderer: headings, bold,
 * italic, strikethrough, inline code, fenced code blocks, ordered and
 * unordered lists (one level of nesting), links, blockquotes, tables,
 * horizontal rules, paragraphs. Nothing else, on purpose: a dependency here
 * would be the first npm package Forge Web pulls in for presentation, and the
 * transcript never needs more than this.
 *
 * Everything is built as React elements — React's own escaping is the XSS
 * story, there is no `dangerouslySetInnerHTML` anywhere and must never be.
 * Malformed markdown is not an error state: whatever a rule fails to claim
 * falls through to a plain paragraph, and if the parser itself throws, the
 * whole source is rendered as plain paragraphs. Words always land on the page.
 *
 * Class names are `md__*`; the styles live in ChatView.css beside the only
 * component that uses them.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^ {0,3}([-*_])( *\1){2,}\s*$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** Render markdown source to React elements. Never throws. */
export function renderMarkdown(source: string): ReactNode {
  try {
    return <Fragment>{parseBlocks(source.split('\n'))}</Fragment>
  } catch {
    // A renderer bug must never take the words with it.
    return (
      <Fragment>
        {source
          .split(/\n{2,}/)
          .filter((p) => p.trim())
          .map((p, i) => (
            <p key={i} className="md__p">
              {p}
            </p>
          ))}
      </Fragment>
    )
  }
}

/* ------------------------------------------------------------------ blocks */

function parseBlocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const raw = lines[i]!

    if (!raw.trim()) {
      i += 1
      continue
    }

    // Fenced code: everything until the matching fence, verbatim.
    const fence = FENCE.exec(raw)
    if (fence) {
      const marker = fence[1]!
      const lang = fence[2] ?? ''
      const body: string[] = []
      i += 1
      while (i < lines.length) {
        const close = FENCE.exec(lines[i]!)
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length && !close[2]) {
          i += 1
          break
        }
        body.push(lines[i]!)
        i += 1
      }
      out.push(
        <div key={key++} className="md__codeblock">
          {lang ? (
            <span className="md__lang" aria-hidden>
              {lang}
            </span>
          ) : null}
          <pre className="md__code">
            <code>{body.join('\n')}</code>
          </pre>
        </div>
      )
      continue
    }

    const heading = HEADING.exec(raw)
    if (heading) {
      const level = Math.min(heading[1]!.length, 6)
      // h1 in a chat turn is a section title, not a page title: everything is
      // clamped to h3..h5 so the transcript keeps one obvious hierarchy.
      const Tag = (['h3', 'h3', 'h4', 'h4', 'h5', 'h5'] as const)[level - 1]!
      out.push(
        <Tag key={key++} className="md__h" data-level={level}>
          {parseInline(heading[2]!)}
        </Tag>
      )
      i += 1
      continue
    }

    if (HR.test(raw)) {
      out.push(<hr key={key++} className="md__hr" />)
      i += 1
      continue
    }

    if (QUOTE.test(raw)) {
      const inner: string[] = []
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!)
        if (!q) break
        inner.push(q[1]!)
        i += 1
      }
      out.push(
        <blockquote key={key++} className="md__quote">
          {parseBlocks(inner)}
        </blockquote>
      )
      continue
    }

    // Table: a row with pipes whose next line is the divider row.
    if (raw.includes('|') && i + 1 < lines.length && lines[i + 1]!.includes('|') && TABLE_DIVIDER.test(lines[i + 1]!)) {
      const head = splitRow(raw)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!))
        i += 1
      }
      out.push(
        <div key={key++} className="md__tablewrap">
          <table className="md__table">
            <thead>
              <tr>
                {head.map((cell, c) => (
                  <th key={c}>{parseInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {head.map((_, c) => (
                    <td key={c}>{row[c] !== undefined ? parseInline(row[c]!) : null}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    const item = ITEM.exec(raw)
    if (item) {
      const chunk: string[] = []
      while (i < lines.length) {
        const line = lines[i]!
        if (ITEM.test(line) || (line.trim() && /^\s/.test(line))) {
          chunk.push(line)
          i += 1
        } else break
      }
      out.push(<Fragment key={key++}>{parseList(chunk)}</Fragment>)
      continue
    }

    // Paragraph: consecutive plain lines. Newlines inside are kept as breaks —
    // the transcript is chat, and a model's deliberate line break should
    // survive the way it does in the official app.
    const para: string[] = [raw]
    i += 1
    while (i < lines.length) {
      const line = lines[i]!
      if (!line.trim() || FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line)) {
        break
      }
      para.push(line)
      i += 1
    }
    out.push(
      <p key={key++} className="md__p">
        {para.map((line, n) => (
          <Fragment key={n}>
            {n > 0 ? <br /> : null}
            {parseInline(line)}
          </Fragment>
        ))}
      </p>
    )
  }

  return out
}

function splitRow(row: string): string[] {
  let s = row.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  // A pipe inside an inline code span stays a pipe; anything fancier (escaped
  // pipes) degrades to an extra cell, which is still a table, not a break.
  return s.split('|').map((cell) => cell.trim())
}

/** One list chunk — the base indent comes from its first item. */
function parseList(chunk: string[]): ReactNode {
  const first = ITEM.exec(chunk[0]!)
  if (!first) return <p className="md__p">{parseInline(chunk.join(' '))}</p>
  const base = first[1]!.length
  const ordered = /\d/.test(first[2]!)

  const items: { text: string[]; sub: string[] }[] = []
  for (const line of chunk) {
    const m = ITEM.exec(line)
    if (m && m[1]!.length <= base + 1) {
      items.push({ text: [m[3]!], sub: [] })
    } else if (items.length) {
      const current = items[items.length - 1]!
      if (m) current.sub.push(line)
      else current.text.push(line.trim())
    }
  }

  const children = items.map((item, n) => (
    <li key={n}>
      {parseInline(item.text.join(' '))}
      {item.sub.length ? parseList(item.sub) : null}
    </li>
  ))

  return ordered ? <ol className="md__list">{children}</ol> : <ul className="md__list">{children}</ul>
}

/* ------------------------------------------------------------------ inline */

const TOKEN_SOURCE = [
  '(`+)([^`]+?)\\1', //                                          1,2  code span
  '\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)', //          3,4  link
  '\\*\\*([^*\\n]+?)\\*\\*', //                                  5    bold **
  '__([^_\\n]+)__', //                                           6    bold __
  '\\*([^*\\n]+)\\*', //                                         7    italic *
  '(?<![\\w`])_([^_\\n]+)_(?![\\w`])', //                        8    italic _
  '~~([^~\\n]+)~~' //                                            9    strike
].join('|')

function parseInline(text: string, depth = 0): ReactNode {
  if (depth > 3 || !text) return text
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  // A fresh regex per call: parseInline recurses, and a shared `/g` regex
  // would have its lastIndex clobbered by the inner call — the outer loop
  // then rematches the same token forever.
  const token = new RegExp(TOKEN_SOURCE, 'g')
  for (let m = token.exec(text); m; m = token.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[2] !== undefined) {
      out.push(
        <code key={key++} className="md__inline-code">
          {m[2]}
        </code>
      )
    } else if (m[3] !== undefined && m[4] !== undefined) {
      out.push(
        <a key={key++} className="md__link" href={m[4]} target="_blank" rel="noopener noreferrer">
          {parseInline(m[3], depth + 1)}
        </a>
      )
    } else if (m[5] !== undefined || m[6] !== undefined) {
      out.push(<strong key={key++}>{parseInline(m[5] ?? m[6]!, depth + 1)}</strong>)
    } else if (m[7] !== undefined || m[8] !== undefined) {
      out.push(<em key={key++}>{parseInline(m[7] ?? m[8]!, depth + 1)}</em>)
    } else if (m[9] !== undefined) {
      out.push(<del key={key++}>{parseInline(m[9], depth + 1)}</del>)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.length === 1 ? out[0] : <Fragment>{out}</Fragment>
}
