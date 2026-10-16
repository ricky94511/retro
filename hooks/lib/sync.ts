// Notion 同步：帳本事件與 Notion「復盤帳本」資料庫的列互相轉換。
// 外掛透過已連上的 Notion 連接器（$.mcp.call）讀寫，不需要另外的金鑰。
import type { Event, EventKind, Source } from './ledger'

// 本機的連接器叫「claude.ai Notion」，雲端 session 叫「Notion」：依序試
export const SERVERS = ['Notion', 'claude.ai Notion']

export type NotionConfig = {
  database: string // 資料庫網址
  dataSourceId: string // 寫入用
  viewUrl: string // 讀取用（view 模式沒有方案額度限制）
}

const KIND_LABEL: Record<EventKind, string> = { correct: '糾正', apply: '套用', skip: '略過' }
const LABEL_KIND: Record<string, EventKind> = { 糾正: 'correct', 套用: 'apply', 略過: 'skip' }

// 一個事件 → Notion 的一列
export const toNotion = (ev: Event): Record<string, string | number> => ({
  摘要: `${KIND_LABEL[ev.kind]}：${ev.rule}`.slice(0, 100),
  事件ID: ev.id,
  類型: KIND_LABEL[ev.kind],
  規則ID: ev.entryId,
  規則: ev.rule,
  原話: ev.quote,
  專案: ev.project,
  對話: ev.sessionId,
  來源: ev.source,
  檔案: ev.file,
  'date:時間:start': new Date(ev.at).toISOString(),
  'date:時間:is_datetime': 1,
})

// Notion 讀回來的文字是 Markdown：換行變 <br>、特殊字元被跳脫、像網域的字（CLAUDE.md）被自動加上連結。
// 還原成寫進去時的純文字，路徑與規則全文才對得上
export const plain = (v: string): string =>
  v
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\[([^\]]*)\]\((?:https?:\/\/)?([^)]*)\)/g, (all, label: string, url: string) =>
      url === label || url.replace(/\/$/, '') === label ? label : all,
    )
    .replace(/\\([\\`*_{}\[\]()#+\-.!~|>])/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const text = (v: unknown): string => (typeof v === 'string' ? plain(v) : '')

// Notion 的一列 → 事件；缺 ID 或類型不認得就丟掉（例如有人手動加的列）
export const fromNotion = (row: Record<string, unknown>): Event | null => {
  const id = text(row['事件ID'])
  const kind = LABEL_KIND[text(row['類型'])]
  const entryId = text(row['規則ID'])
  if (!id || !kind || !entryId) return null
  const at = Date.parse(text(row['date:時間:start']) || text(row['createdTime']))
  const source: Source = text(row['來源']) === '雲端' ? '雲端' : '本機'
  return {
    id,
    at: Number.isNaN(at) ? 0 : at,
    kind,
    entryId,
    rule: text(row['規則']),
    sessionId: text(row['對話']),
    project: text(row['專案']),
    quote: text(row['原話']),
    file: text(row['檔案']),
    source,
  }
}

// fetch 資料庫的回覆裡找出 data source 與第一個 view
export const parseDatabase = (database: string, fetched: string): NotionConfig | null => {
  const dbId = database.match(/[0-9a-f]{32}/i)?.[0] ?? database.match(/[0-9a-f-]{36}/i)?.[0]?.replace(/-/g, '')
  const dataSourceId = fetched.match(/collection:\/\/([0-9a-f-]{36})/i)?.[1]
  const viewId = fetched.match(/view:\/\/([0-9a-f-]{36})/i)?.[1]
  if (!dbId || !dataSourceId || !viewId) return null
  return { database, dataSourceId, viewUrl: `https://www.notion.so/${dbId}?v=${viewId.replace(/-/g, '')}` }
}

// MCP 工具的回覆：第一個文字區塊是 JSON
export const resultJson = (content: readonly { type: string; text?: string }[]): unknown => {
  const block = content.find(c => c.type === 'text' && typeof c.text === 'string')
  if (!block?.text) return undefined
  try {
    return JSON.parse(block.text)
  } catch {
    return undefined
  }
}

// view 模式的一頁結果
export const parsePage = (v: unknown): { rows: Record<string, unknown>[]; next: string | null } => {
  const o = (v ?? {}) as { results?: unknown; has_more?: unknown; next_cursor?: unknown }
  const rows = Array.isArray(o.results) ? (o.results as Record<string, unknown>[]) : []
  const next = o.has_more === true && typeof o.next_cursor === 'string' ? o.next_cursor : null
  return { rows, next }
}

export const PUSH_BATCH = 50 // 一次建立的列數上限（工具允許 100，留點餘裕）
