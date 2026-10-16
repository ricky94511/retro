// 恢復：雲端 session 每次都是新的容器，~/.claude/CLAUDE.md 是空的。
// 開對話時，把帳本裡「已套用到 ~/.claude/CLAUDE.md」的規則補回去，規則跟著 Notion 走，不跟著容器走。
import type { Ledger } from './ledger'
import { applyChange } from './apply'

export type Restorable = { entryId: string; text: string }

const expand = (file: string, home: string) => (file.startsWith('~/') ? `${home}/${file.slice(2)}` : file)

// 已套用到使用者 CLAUDE.md 的規則：套用時記下的文字，舊事件沒記就用規則本身
export const restorable = (ledger: Ledger, home: string): Restorable[] =>
  ledger.entries.flatMap(e => {
    const s = e.status
    if (s.kind !== 'applied' || expand(s.file, home) !== `${home}/.claude/CLAUDE.md`) return []
    const text = (s.text || `- ${e.rule}`).trim()
    return text ? [{ entryId: e.id, text }] : []
  })

// 檔案裡還沒有的才補在檔尾；都有了回 null（不寫檔）
export const restoreText = (current: string | undefined, rules: Restorable[]): string | null => {
  let text = current
  for (const r of rules) {
    if (text?.includes(r.text)) continue
    const next = applyChange(text, '', r.text)
    if (next.ok) text = next.text
  }
  return text === current ? null : `${text}\n`
}
