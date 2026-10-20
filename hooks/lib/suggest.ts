// 產生建議：組提示詞，解析模型回來的 JSON（最多 5 條，格式不對的丟掉）
import type { Suggestion, Kind } from '../../types'
import type { Due } from './ledger'
import { redact } from './redact'

export const KINDS = ['加規則', '新 skill', '改 skill', '刪 skill', '改設定'] as const

export type Context = {
  due: Due[]
  claudeMd: { path: string; text: string }[]
  memory: string
  skills: { name: string; uses30: number; path: string }[]
  settings: { path: string; text: string }[] // 已遮蔽
}

export const buildPrompt = (c: Context): string => {
  const due = c.due
    .map(d => `- [${d.entry.id}] (${d.reason === 'rewrite' ? '改寫原規則' : '新增'}) ${d.entry.rule}\n  次數 ${d.entry.count}；原話：\n${d.entry.quotes.map(q => `  「${q}」`).join('\n')}`)
    .join('\n')
  return `你是復盤助理。依下面的帳本條目，提出最多 5 條具體改動建議。只回 JSON 陣列，每條格式：
{"id":"s1","kind":"加規則"|"新 skill"|"改 skill"|"刪 skill"|"改設定","title":"一句話","entryId":"帳本 id","count":次數,"quotes":["原話"],
 "change":{"file":"路徑","oldText":"要替換的原文（必須在檔案裡只出現一次；加在檔尾就給空字串）","newText":"替換成的文字"}
   或 {"file":"新 skill 的 SKILL.md 路徑","fullText":"整份內容"}
   或 {"file":"要刪的 skill 資料夾裡的 SKILL.md"} （kind 為刪 skill）}
改設定時 change 只寫 oldText／newText（JSON 片段），不要改金鑰。已有 skill 或規則能涵蓋的，改那個，不要重複加。

## 結構優先
文字規則被違反時不會報錯，所以每條先問：能不能讓這個錯做不出來或一做就被擋？依序選第一個做得到的：
1. 改設定：在 settings.json 加 hook，例如 PreToolUse 擋下錯的工具呼叫並說明該怎麼做、UserPromptSubmit 每輪補提醒、Stop 檢查回答有沒有漏。hook 的 command 要一行寫完（shell 或 python3 -c），不能依賴另外的腳本檔，因為只能改設定檔。
2. 改 skill／新 skill：做法或流程類的經驗。
3. 加規則：要靠判斷、機械檢查不出來的，才寫進 CLAUDE.md。
標「改寫原規則」的條目代表已經有規則卻還是一再被糾正，文字不夠用，優先考慮第 1 種。title 用一句話說明為什麼選這一層。

## 要處理的帳本條目
${due || '（無）'}

## CLAUDE.md
${c.claudeMd.map(f => `### ${f.path}\n${f.text}`).join('\n\n') || '（無）'}

## memory 索引（MEMORY.md）
${c.memory || '（無）'}

## skill 清單（近 30 天使用次數）
${c.skills.map(s => `- ${s.name}：${s.uses30} 次（${s.path}）`).join('\n') || '（無）'}

## 設定檔（金鑰已遮蔽）
${c.settings.map(f => `### ${f.path}\n${f.text}`).join('\n\n') || '（無）'}
`
}

// 解析模型回覆；只留格式對的，最多 5 條
export const parseSuggestions = (text: string): Suggestion[] => {
  const json = text.match(/\[[\s\S]*\]/)?.[0]
  if (!json) return []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Suggestion[] = []
  for (const item of raw) {
    const s = toSuggestion(item, out.length)
    if (s) out.push(s)
    if (out.length === 5) break
  }
  return out
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

const toSuggestion = (item: unknown, index: number): Suggestion | undefined => {
  if (!item || typeof item !== 'object') return undefined
  const o = item as Record<string, unknown>
  const kind = KINDS.find(k => k === o.kind) as Kind | undefined
  const title = str(o.title)
  const entryId = str(o.entryId)
  const change = o.change as Record<string, unknown> | undefined
  const file = str(change?.file)
  if (!kind || !title || !entryId || !file) return undefined
  const quotes = Array.isArray(o.quotes) ? o.quotes.filter((q): q is string => typeof q === 'string').map(q => redact(q)) : []
  const count = typeof o.count === 'number' ? o.count : quotes.length
  let body: Suggestion['change'] | undefined
  if (kind === '刪 skill') body = { file, deleteSkill: true }
  else if (str(change?.fullText) && kind === '新 skill') body = { file, fullText: String(change?.fullText) }
  else if (typeof change?.oldText === 'string' && typeof change?.newText === 'string') {
    body = { file, oldText: change.oldText, newText: change.newText }
  }
  if (!body) return undefined
  return {
    id: str(o.id) ?? `s${index + 1}`,
    kind,
    title,
    evidence: { entryId, count, quotes },
    change: body,
  }
}
