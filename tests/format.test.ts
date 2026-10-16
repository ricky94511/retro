import { expect, test } from 'claude-code/testing'
import { afterPreviewChoices, firstChoices, formatReview, parseFupanArgs, previewQuestion, questionHead } from '../hooks/lib/format'
import type { Review, Suggestion } from '../types'

const s = (id: string): Suggestion => ({
  id, kind: '加規則', title: `規則 ${id}`, evidence: { entryId: 'e1', count: 3, quotes: ['又來了'] },
  change: { file: '/h/.claude/CLAUDE.md', oldText: 'a', newText: 'b' },
})

test('/fupan 參數：中英文動詞與編號，不認得就給用法', () => {
  expect(parseFupanArgs('')).toEqual({ action: 'run' })
  expect(parseFupanArgs('預覽 2')).toEqual({ action: 'preview', n: 2 })
  expect(parseFupanArgs('apply 1')).toEqual({ action: 'apply', n: 1 })
  expect(parseFupanArgs('略過 3')).toEqual({ action: 'skip', n: 3 })
  expect(parseFupanArgs('套用')).toEqual({ action: 'help' })
  expect(parseFupanArgs('亂打 1')).toEqual({ action: 'help' })
})

test('文字結果：編號、證據、檔案；處理過的留在原位並標記', () => {
  const r: Review = { suggestions: [s('a'), s('b')], previews: {}, done: { a: 'applied' }, note: null }
  const text = formatReview(r)
  expect(text).toContain('1. 【加規則】規則 a（已套用）')
  expect(text).toContain('2. 【加規則】規則 b\n')
  expect(text).toContain('「又來了」')
  expect(text).toContain('/fupan 套用 N')
})

test('沒有建議時說沒有建議，附上 note', () => {
  expect(formatReview({ suggestions: [], previews: {}, done: {}, note: '帳本沒有條目' })).toBe('帳本沒有條目\n沒有建議。')
})

test('用選的：一開始三個選項；改設定只能先預覽或略過；預覽後只剩套用或略過', () => {
  expect(firstChoices('加規則')).toEqual(['預覽改動', '套用', '略過'])
  expect(firstChoices('改設定')).toEqual(['預覽改動', '略過'])
  expect(afterPreviewChoices()).toEqual(['套用', '略過'])
})

test('問題附上第幾條、證據、檔案；預覽問題附差異，太長就截斷', () => {
  const head = questionHead(s('a'), 1, 2)
  expect(head).toBe('復盤 1/2：【加規則】規則 a\n證據：3 次，「又來了」\n檔案：/h/.claude/CLAUDE.md')
  const q = previewQuestion(head, Array.from({ length: 40 }, (_, i) => `+ ${i}`))
  expect(q).toContain('+ 29')
  expect(q).not.toContain('+ 30')
  expect(q).toContain('還有 10 行')
  expect(q.endsWith('要套用嗎？')).toBe(true)
})
