import { expect, test } from 'claude-code/testing'
import {
  addCorrection, dueEntries, emptyLedger, ledgerSummary, markApplied, markSkipped, markSynced, mergeEvents, parseLedger, type Ledger,
} from '../hooks/lib/ledger'

let n = 0
let clock = 0
const newId = () => `e${++n}`
const fix = (l: Ledger, rule: string, quote: string, entryId?: string) =>
  addCorrection(
    l,
    { entryId, rule, quote, sessionId: 's1', project: '/p', at: ++clock, eventId: `ev${++n}` },
    newId,
  )
const at = () => ({ at: ++clock })

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
  expect(l.entries[0]!.rule).toBe('標題要用繁中')
  expect(l.entries[0]!.quotes).toEqual(['二', '三', '四'])
  expect(l.events.length).toBe(4)
  expect(l.events.every(e => e.entryId === id)).toBe(true)
})

test('累積 3 次才處理；略過後要再多 3 次', () => {
  let l = emptyLedger()
  for (const q of ['a', 'b']) l = fix(l, '規則', q, l.entries[0]?.id).ledger
  expect(dueEntries(l).length).toBe(0)
  l = fix(l, '規則', 'c', l.entries[0]?.id).ledger
  expect(dueEntries(l)[0]!.reason).toBe('new')
  l = markSkipped(l, l.entries[0]!.id, at())
  expect(dueEntries(l).length).toBe(0)
  for (const q of ['d', 'e']) l = fix(l, '', q, l.entries[0]?.id).ledger
  expect(dueEntries(l).length).toBe(0)
  l = fix(l, '', 'f', l.entries[0]?.id).ledger
  expect(dueEntries(l)[0]!.reason).toBe('new')
})

test('寫成規則後又被糾正 2 次 → 改寫原規則，不另加一條', () => {
  let l = emptyLedger()
  for (const q of ['a', 'b', 'c']) l = fix(l, '規則', q, l.entries[0]?.id).ledger
  l = markApplied(l, l.entries[0]!.id, '/p/CLAUDE.md', at())
  expect(l.entries[0]!.status).toEqual({ kind: 'applied', file: '/p/CLAUDE.md', atCount: 3, quote: 'c', text: '' })
  expect(dueEntries(l).length).toBe(0)
  l = fix(l, '', 'd', l.entries[0]?.id).ledger
  expect(dueEntries(l).length).toBe(0)
  l = fix(l, '', 'e', l.entries[0]?.id).ledger
  const due = dueEntries(l)
  expect(due.length).toBe(1)
  expect(due[0]!.reason).toBe('rewrite')
  expect(l.entries.length).toBe(1)
})

test('合併別處的事件：依 ID 去重，次數相加，對方已有的不用再推', () => {
  let a = emptyLedger()
  a = fix(a, '規則', '本機一', 'r1').ledger // r1 不在帳本裡 → 新條目
  const id = a.entries[0]!.id
  let b = emptyLedger()
  b = mergeEvents(b, a.events) // 雲端拿到本機的事件
  b = fix(b, '', '雲端一', id).ledger
  b = fix(b, '', '雲端二', id).ledger
  // 本機拉回雲端的全部事件（含自己那筆）
  const merged = mergeEvents(a, b.events)
  expect(merged.events.length).toBe(3)
  expect(merged.entries[0]!.count).toBe(3)
  expect(merged.entries[0]!.quotes).toEqual(['本機一', '雲端一', '雲端二'])
  expect(merged.unsynced).toEqual([]) // 本機那筆已經在雲端看到了
  expect(dueEntries(merged)[0]!.reason).toBe('new')
  // 同一批再合併一次不會重複算
  expect(mergeEvents(merged, b.events).entries[0]!.count).toBe(3)
})

test('還沒推上的事件記在 unsynced；推完就拿掉', () => {
  let l = fix(emptyLedger(), '規則', 'a').ledger
  l = fix(l, '', 'b', l.entries[0]!.id).ledger
  expect(l.unsynced.length).toBe(2)
  l = markSynced(l, [l.unsynced[0]!])
  expect(l.unsynced.length).toBe(1)
})

test('壞掉的帳本檔當空的；讀檔時規則由事件重算', () => {
  expect(parseLedger('{壞掉')).toEqual(emptyLedger())
  expect(parseLedger(undefined)).toEqual(emptyLedger())
  const l = fix(emptyLedger(), '規則', 'a').ledger
  const again = parseLedger(JSON.stringify({ ...l, entries: [] }))
  expect(again.entries[0]!.count).toBe(1)
})

test('同步回報：事件與規則分開數（3 次糾正 + 2 次套用 = 2 條規則都已套用）', () => {
  let l = fix(emptyLedger(), '中文', 'a').ledger
  const zh = l.entries[0]!.id
  l = fix(l, '', 'b', zh).ledger
  l = fix(l, '篩選', 'c').ledger
  const filter = l.entries.find(e => e.id !== zh)!.id
  l = markApplied(l, zh, '~/.claude/CLAUDE.md', at())
  l = markApplied(l, filter, '~/.claude/CLAUDE.md', at())
  expect(ledgerSummary(l)).toBe('帳本：5 個事件（糾正 3、套用 2、略過 0），歸成 2 條規則（已套用 2、累積中 0、已略過 0）。')
})

test('對話裡的糾正（帳本沒有條目）套用時補一條，事件會推上 Notion', () => {
  let l = emptyLedger()
  l = markApplied(l, '無帳本條目（對話糾正）', '~/.claude/CLAUDE.md', {
    ...at(), text: '- 待辦做完要標完成', rule: '待辦做完同一輪標完成', quotes: ['那有把那則編著完成？'],
  })
  expect(l.entries.length).toBe(1)
  const e = l.entries[0]!
  expect(e.rule).toBe('待辦做完同一輪標完成')
  expect(e.count).toBe(1)
  expect(e.quotes).toEqual(['那有把那則編著完成？'])
  expect(e.status).toEqual({ kind: 'applied', file: '~/.claude/CLAUDE.md', atCount: 1, quote: '那有把那則編著完成？', text: '- 待辦做完要標完成' })
  expect(l.events.map(ev => ev.kind)).toEqual(['correct', 'apply'])
  expect(l.unsynced).toEqual(l.events.map(ev => ev.id))
})

test('帳本沒有條目、也沒給規則：照舊不記', () => {
  const l = markApplied(emptyLedger(), '不存在', '/p/CLAUDE.md', at())
  expect(l.events.length).toBe(0)
})
