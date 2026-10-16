// 帳本：只記事件（糾正、套用、略過），每條規則的次數、最近原話、狀態都由事件算出來。
// 這樣本機、各個雲端 session 與 Notion 的帳本，只要依事件 ID 合併就能算出同一個結果。

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

export type EventKind = 'correct' | 'apply' | 'skip'
export type Source = '本機' | '雲端'

export type Event = {
  id: string
  at: number
  kind: EventKind
  entryId: string
  rule: string
  sessionId: string
  project: string
  quote: string // 糾正的原話；套用、略過時空白
  file: string // 套用寫在哪個檔案；其他空白
  source: Source
}

// unsynced：還沒推上 Notion 的事件 ID
export type Ledger = { entries: Entry[]; events: Event[]; unsynced: string[] }

export const emptyLedger = (): Ledger => ({ entries: [], events: [], unsynced: [] })

export const QUOTES_KEPT = 3
export const THRESHOLD = 3 // 累積到這個次數就提醒
export const REWRITE_AFTER = 2 // 寫成規則後又被糾正這麼多次，就改寫原規則

// 依時間重算每條規則（同一時間照加入順序；sort 是穩定的）
export const rebuild = (events: Event[]): Entry[] => {
  const byId = new Map<string, Entry>()
  for (const ev of [...events].sort((a, b) => a.at - b.at)) {
    const entry = byId.get(ev.entryId) ?? { id: ev.entryId, rule: ev.rule, count: 0, quotes: [], status: { kind: 'accumulating' } }
    if (ev.kind === 'correct') {
      entry.count += 1
      entry.quotes = [...entry.quotes, ev.quote].slice(-QUOTES_KEPT)
    } else if (ev.kind === 'apply') {
      entry.status = { kind: 'applied', file: ev.file, atCount: entry.count, quote: entry.quotes.at(-1) ?? null }
    } else {
      entry.status = { kind: 'skipped', atCount: entry.count }
    }
    byId.set(ev.entryId, entry)
  }
  return [...byId.values()]
}

const withEvent = (ledger: Ledger, ev: Event): Ledger => {
  const events = [...ledger.events, ev]
  return { entries: rebuild(events), events, unsynced: [...ledger.unsynced, ev.id] }
}

const eventId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

type Correction = {
  entryId?: string // 對到舊條目；沒有就用 rule 新增一條
  rule: string
  quote: string
  sessionId: string
  project: string
  at: number
  eventId: string
  source?: Source
}

// 記一次糾正，回傳新帳本與是否剛好跨過提醒門檻
export const addCorrection = (ledger: Ledger, c: Correction, newId: () => string): { ledger: Ledger; crossed: boolean } => {
  const found = c.entryId ? ledger.entries.find(e => e.id === c.entryId) : undefined
  const entryId = found?.id ?? newId()
  const next = withEvent(ledger, {
    id: c.eventId,
    at: c.at,
    kind: 'correct',
    entryId,
    rule: found?.rule ?? c.rule,
    sessionId: c.sessionId,
    project: c.project,
    quote: c.quote,
    file: '',
    source: c.source ?? '本機',
  })
  const entry = next.entries.find(e => e.id === entryId)!
  const crossed = entry.status.kind === 'accumulating' && entry.count === THRESHOLD
  return { ledger: next, crossed }
}

type Mark = { at?: number; eventId?: string; sessionId?: string; project?: string; source?: Source }

const mark = (ledger: Ledger, id: string, kind: 'apply' | 'skip', file: string, m: Mark): Ledger => {
  const entry = ledger.entries.find(e => e.id === id)
  if (!entry) return ledger
  return withEvent(ledger, {
    id: m.eventId ?? eventId(kind === 'apply' ? 'ap' : 'sk'),
    at: m.at ?? Date.now(),
    kind,
    entryId: id,
    rule: entry.rule,
    sessionId: m.sessionId ?? '',
    project: m.project ?? '',
    quote: '',
    file,
    source: m.source ?? '本機',
  })
}

export const markApplied = (ledger: Ledger, id: string, file: string, m: Mark = {}): Ledger => mark(ledger, id, 'apply', file, m)

export const markSkipped = (ledger: Ledger, id: string, m: Mark = {}): Ledger => mark(ledger, id, 'skip', '', m)

// 合併別處的事件（例如 Notion 上的）：依事件 ID 去重，重算規則；已在對方那邊的就不用再推
export const mergeEvents = (ledger: Ledger, remote: Event[]): Ledger => {
  const known = new Set(ledger.events.map(e => e.id))
  const remoteIds = new Set(remote.map(e => e.id))
  const events = [...ledger.events, ...remote.filter(e => !known.has(e.id))]
  return {
    entries: rebuild(events),
    events,
    unsynced: ledger.unsynced.filter(id => !remoteIds.has(id)),
  }
}

export const markSynced = (ledger: Ledger, ids: string[]): Ledger => {
  const done = new Set(ids)
  return { ...ledger, unsynced: ledger.unsynced.filter(id => !done.has(id)) }
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

// 讀帳本的 JSON；壞掉或缺漏就當空的，不讓復盤整個死掉。規則一律由事件重算
export const parseLedger = (text: string | undefined): Ledger => {
  if (!text) return emptyLedger()
  try {
    const v = JSON.parse(text) as Partial<Ledger>
    const events = (v.events ?? []).filter(e => e && typeof e.id === 'string' && typeof e.entryId === 'string')
    return { entries: rebuild(events), events, unsynced: v.unsynced ?? [] }
  } catch {
    return emptyLedger()
  }
}
