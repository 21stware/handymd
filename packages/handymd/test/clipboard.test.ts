import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection } from 'prosemirror-state'
import { concealPlugin } from '../src/conceal/plugin'
import { clipboardPlugin, htmlToMarkdown, markdownToSlice } from '../src/clipboard'
import { docToMarkdown, markdownToDoc, toCommonMark } from '../src/markdown'

function mkState(md: string, from: number, to = from): EditorState {
  const s = EditorState.create({ doc: markdownToDoc(md), plugins: [concealPlugin(), clipboardPlugin()] })
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, to)))
}

describe('plain text clipboard keeps one line per block', () => {
  test('pasting text with blank lines keeps every blank line', () => {
    let state = mkState('', 1)
    state = state.apply(state.tr.replaceSelection(markdownToSlice('a\n\nb\n\n\nc')))
    expect(docToMarkdown(state.doc)).toBe('a\n\nb\n\n\nc')
  })

  test('pasting multiple lines mid-line merges the first and last line', () => {
    let state = mkState('- foobar', 6)
    state = state.apply(state.tr.replaceSelection(markdownToSlice('X\nY')))
    expect(docToMarkdown(state.doc)).toBe('- fooX\nYbar')
  })

  test('copy serializer joins lines with a single newline', () => {
    const state = mkState('l1\nl2\n\nl3', 1)
    const plugin = clipboardPlugin()
    const slice = state.doc.slice(1, state.doc.content.size - 1)
    expect(plugin.props.clipboardTextSerializer!.call(plugin, slice, null as never)).toBe('l1\nl2\n\nl3')
  })
})

describe('htmlToMarkdown', () => {
  test('headings, lists, inline marks and links', () => {
    const md = htmlToMarkdown(
      '<h2>Head</h2><ul><li>one</li><li>two <strong>bold</strong></li></ul>' +
        '<p>x <em>it</em> <a href="https://a.b">link</a></p>',
    )
    expect(md).toBe('## Head\n\n- one\n- two **bold**\n\nx *it* [link](https://a.b)')
  })

  test('nested and ordered lists, todos', () => {
    const md = htmlToMarkdown(
      '<ol start="3"><li>a<ul><li>b</li></ul></li><li>c</li></ol>' +
        '<ul><li><input type="checkbox" checked>done</li></ul>',
    )
    expect(md).toBe('3. a\n  - b\n4. c\n\n- [x] done')
  })

  test('code blocks keep whitespace and language', () => {
    const md = htmlToMarkdown('<pre><code class="language-ts">  const a = 1\nfoo()\n</code></pre>')
    expect(md).toBe('```ts\n  const a = 1\nfoo()\n```')
  })

  test('blockquote, hr, br, table', () => {
    const md = htmlToMarkdown(
      '<blockquote><p>q1</p><p>q2</p></blockquote><hr><p>a<br>b</p>' +
        '<table><tr><th>h1</th><th>h2</th></tr><tr><td>1</td><td>2</td></tr></table>',
    )
    expect(md).toBe('> q1\n>\n> q2\n\n---\n\na\nb\n\n| h1 | h2 |\n| --- | --- |\n| 1 | 2 |')
  })

  test('Google Docs wrapper <b style="font-weight:normal"> is not bold', () => {
    const md = htmlToMarkdown(
      '<b style="font-weight:normal"><p><span style="font-weight:700">Bold</span> plain</p></b>',
    )
    expect(md).toBe('**Bold** plain')
  })
})

describe('toCommonMark', () => {
  test('adjacent text lines become hard breaks by default', () => {
    expect(toCommonMark('a\nb\n\nc')).toBe('a  \nb\n\nc')
  })

  test('paragraph mode inserts blank lines', () => {
    expect(toCommonMark('a\nb', { lineBreak: 'paragraph' })).toBe('a\n\nb')
  })

  test('prevents setext headings, lazy continuation and list interruption', () => {
    expect(toCommonMark('text\n---')).toBe('text\n\n---')
    expect(toCommonMark('text\n===')).toBe('text\n\n===')
    expect(toCommonMark('- item\nafter')).toBe('- item\n\nafter')
    expect(toCommonMark('> q\nafter')).toBe('> q\n\nafter')
    expect(toCommonMark('intro\n2. b')).toBe('intro\n\n2. b')
  })

  test('code blocks and headings are untouched', () => {
    const md = '# T\nbody\n```\na\nb\n```'
    expect(toCommonMark(md)).toBe(md)
  })
})
