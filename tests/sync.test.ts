import { expect, test } from 'claude-code/testing'
import { fromNotion, parseDatabase, parsePage, resultJson, toNotion } from '../hooks/lib/sync'
import type { Event } from '../hooks/lib/ledger'

const ev: Event = {
  id: 'ev_1', at: Date.parse('2026-10-16T08:00:00.000Z'), kind: 'correct', entryId: 'r_1', rule: '標題用中文',
  sessionId: 's1', project: '/proj', quote: '又用英文標題了', file: '', source: '雲端',
}

test('事件 → Notion 的一列 → 事件，來回一樣', () => {
  const row = toNotion(ev)
  expect(row['類型']).toBe('糾正')
  expect(row['摘要']).toBe('糾正：標題用中文')
  expect(row['date:時間:start']).toBe('2026-10-16T08:00:00.000Z')
  expect(fromNotion(row)).toEqual(ev)
  const applied: Event = { ...ev, id: 'ap_1', kind: 'apply', quote: '', file: '/h/.claude/CLAUDE.md', source: '本機' }
  expect(fromNotion(toNotion(applied))).toEqual(applied)
})

test('Notion 上缺 ID、規則或類型不認得的列丟掉', () => {
  expect(fromNotion({ 摘要: '手動加的' })).toBe(null)
  expect(fromNotion({ ...toNotion(ev), 類型: '其他' })).toBe(null)
  expect(fromNotion({ ...toNotion(ev), 規則ID: '' })).toBe(null)
})

test('從 fetch 回覆找出 data source 與 view，組成讀取用的網址', () => {
  const fetched = 'x <data-source url="{{collection://3df503d3-10f1-4a72-b655-a9819a0045e0}}"> y <view url="{{view://912435fe-d7ff-4466-ac5f-e7253b65d22b}}">'
  expect(parseDatabase('https://app.notion.com/p/e0ec8fd62e61450a84be3fe7d28206f5', fetched)).toEqual({
    database: 'https://app.notion.com/p/e0ec8fd62e61450a84be3fe7d28206f5',
    dataSourceId: '3df503d3-10f1-4a72-b655-a9819a0045e0',
    viewUrl: 'https://www.notion.so/e0ec8fd62e61450a84be3fe7d28206f5?v=912435fed7ff4466ac5fe7253b65d22b',
  })
  expect(parseDatabase('https://app.notion.com/p/e0ec8fd62e61450a84be3fe7d28206f5', '沒有')).toBe(null)
})

test('讀 view 的結果：列、下一頁游標；MCP 回覆的第一個文字區塊是 JSON', () => {
  const page = { results: [{ 事件ID: 'a' }], has_more: true, next_cursor: 'c1' }
  expect(resultJson([{ type: 'text', text: JSON.stringify(page) }])).toEqual(page)
  expect(parsePage(page)).toEqual({ rows: [{ 事件ID: 'a' }], next: 'c1' })
  expect(parsePage({ results: [], has_more: false })).toEqual({ rows: [], next: null })
  expect(resultJson([{ type: 'text', text: '不是 JSON' }])).toBe(undefined)
})
