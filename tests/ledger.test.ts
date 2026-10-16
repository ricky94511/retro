import { expect, test } from 'claude-code/testing'
import { addCorrection, dueEntries, emptyLedger, markApplied, markSkipped, parseLedger, type Ledger } from '../hooks/lib/ledger'

let n = 0
const newId = () => `e${++n}`
const fix = (l: Ledger, rule: string, quote: string, entryId?: string) =>
  addCorrection(
    l,
    { entryId, rule, quote, sessionId: 's1', project: '/p', at: 1, eventId: `ev${n}-${quote}` },
    newId,
  )

test('同一條規則累積，原話只留最近 3 句，第 3 次剛好跨過門檻', () => {
  let l = emptyLedger()
  let r = fix(l, '標題要用繁中', '一', undefined)
  l = r.ledger
  const id = l.entries[0]!.id
  r = fix(l, '', '二', id); l = r.ledger
  expect(r.crossed).toBe(false)
  r = fix(l, '', '三', id); l = r.ledger
  expect(r.crossed).toBe(true)
  r = fix(l, '', '四', id); l = r.ledger
  expect(r.crossed).toBe(false)
  expect(l.entries[0]!.count).toBe(4)
  expect(l.entries[0]!.quotes).toEqual(['二', '三', '四'])
  expect(l.events.length).toBe(4)
  expect(l.events[0]!.entryId).toBe(id)
})

test('累積 3 次才處理；略過後要再多 3 次', () => {
  let l = emptyLedger()
  for (const q of ['a', 'b']) l = fix(l, '規則', q, l.entries[0]?.id).ledger
  expect(dueEntries(l).length).toBe(0)
  l = fix(l, '規則', 'c', l.entries[0]?.id).ledger
  expect(dueEntries(l)[0]!.reason).toBe('new')
  l = markSkipped(l, l.entries[0]!.id)
  expect(dueEntries(l).length).toBe(0)
  for (const q of ['d', 'e']) l = fix(l, '', q, l.entries[0]?.id).ledger
  expect(dueEntries(l).length).toBe(0)
  l = fix(l, '', 'f', l.entries[0]?.id).ledger
  expect(dueEntries(l)[0]!.reason).toBe('new')
})

test('寫成規則後又被糾正 2 次 → 改寫原規則，不另加一條', () => {
  let l = emptyLedger()
  for (const q of ['a', 'b', 'c']) l = fix(l, '規則', q, l.entries[0]?.id).ledger
  l = markApplied(l, l.entries[0]!.id, '/p/CLAUDE.md', 'c')
  expect(dueEntries(l).length).toBe(0)
  l = fix(l, '', 'd', l.entries[0]?.id).ledger
  expect(dueEntries(l).length).toBe(0)
  l = fix(l, '', 'e', l.entries[0]?.id).ledger
  const due = dueEntries(l)
  expect(due.length).toBe(1)
  expect(due[0]!.reason).toBe('rewrite')
  expect(l.entries.length).toBe(1)
})

test('壞掉的帳本檔當空的', () => {
  expect(parseLedger('{壞掉')).toEqual(emptyLedger())
  expect(parseLedger(undefined)).toEqual(emptyLedger())
})
