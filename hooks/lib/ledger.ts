// 帳本：每條規則的次數、最近原話、狀態；每次糾正存成一個有 ID 的事件（之後合併用）

export type Status =
  | { kind: 'accumulating' }
  | { kind: 'skipped'; atCount: number }
  | { kind: 'applied'; file: string; atCount: number; quote: string | null }

export type Entry = {
  id: string
  rule: string
  count: number
  quotes: string[] // 最近 3 句原話
  status: Status
}

export type Event = {
  id: string
  at: number
  sessionId: string
  project: string
  quote: string
  entryId: string
}

export type Ledger = { entries: Entry[]; events: Event[] }

export const emptyLedger = (): Ledger => ({ entries: [], events: [] })

export const QUOTES_KEPT = 3
export const THRESHOLD = 3 // 累積到這個次數就提醒
export const REWRITE_AFTER = 2 // 寫成規則後又被糾正這麼多次，就改寫原規則

type Correction = {
  entryId?: string // 對到舊條目；沒有就用 rule 新增一條
  rule: string
  quote: string
  sessionId: string
  project: string
  at: number
  eventId: string
}

// 記一次糾正，回傳新帳本與是否剛好跨過提醒門檻
export const addCorrection = (ledger: Ledger, c: Correction, newId: () => string): { ledger: Ledger; crossed: boolean } => {
  const found = c.entryId ? ledger.entries.find(e => e.id === c.entryId) : undefined
  const entry: Entry = found ?? { id: newId(), rule: c.rule, count: 0, quotes: [], status: { kind: 'accumulating' } }
  const count = entry.count + 1
  const updated: Entry = {
    ...entry,
    count,
    quotes: [...entry.quotes, c.quote].slice(-QUOTES_KEPT),
  }
  const others = ledger.entries.filter(e => e.id !== entry.id)
  const crossed = updated.status.kind === 'accumulating' && count === THRESHOLD
  const event: Event = {
    id: c.eventId,
    at: c.at,
    sessionId: c.sessionId,
    project: c.project,
    quote: c.quote,
    entryId: entry.id,
  }
  return {
    ledger: { entries: [...others, updated], events: [...ledger.events, event] },
    crossed,
  }
}

export type Due = { entry: Entry; reason: 'new' | 'rewrite' }

// 這次要處理的條目
export const dueEntries = (ledger: Ledger): Due[] =>
  ledger.entries.flatMap((entry): Due[] => {
    const s = entry.status
    if (s.kind === 'accumulating' && entry.count >= THRESHOLD) return [{ entry, reason: 'new' }]
    if (s.kind === 'skipped' && entry.count - s.atCount >= THRESHOLD) return [{ entry, reason: 'new' }]
    if (s.kind === 'applied' && entry.count - s.atCount >= REWRITE_AFTER) return [{ entry, reason: 'rewrite' }]
    return []
  })

export const markApplied = (ledger: Ledger, id: string, file: string, quote: string | null): Ledger => ({
  ...ledger,
  entries: ledger.entries.map(e =>
    e.id === id ? { ...e, status: { kind: 'applied', file, atCount: e.count, quote } } : e,
  ),
})

export const markSkipped = (ledger: Ledger, id: string): Ledger => ({
  ...ledger,
  entries: ledger.entries.map(e =>
    e.id === id ? { ...e, status: { kind: 'skipped', atCount: e.count } } : e,
  ),
})

// 讀寫帳本的 JSON；壞掉或缺漏就當空的，不讓復盤整個死掉
export const parseLedger = (text: string | undefined): Ledger => {
  if (!text) return emptyLedger()
  try {
    const v = JSON.parse(text) as Partial<Ledger>
    return { entries: v.entries ?? [], events: v.events ?? [] }
  } catch {
    return emptyLedger()
  }
}
