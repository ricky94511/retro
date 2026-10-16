// /fupan 的文字介面：App 裡看不到面板時，建議、預覽、套用結果都用指令回覆顯示
import type { Review } from '../../types'

export type FupanArgs =
  | { action: 'run' }
  | { action: 'preview' | 'apply' | 'skip'; n: number }
  | { action: 'help' }

const VERBS: Record<string, 'preview' | 'apply' | 'skip'> = {
  預覽: 'preview', preview: 'preview',
  套用: 'apply', apply: 'apply',
  略過: 'skip', skip: 'skip',
}

export const parseFupanArgs = (args: string): FupanArgs => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { action: 'run' }
  const verb = VERBS[words[0]!.toLowerCase()]
  const n = Number(words[1])
  if (!verb || !Number.isInteger(n) || n < 1) return { action: 'help' }
  return { action: verb, n }
}

export const HELP = '用法：/fupan（復盤這段對話）、/fupan 預覽 N、/fupan 套用 N、/fupan 略過 N'

export const formatReview = (r: Review): string => {
  const lines: string[] = []
  if (r.note) lines.push(r.note)
  if (r.suggestions.length === 0) {
    lines.push('沒有建議。')
    return lines.join('\n')
  }
  r.suggestions.forEach((s, i) => {
    const done = r.done[s.id]
    lines.push(`${i + 1}. 【${s.kind}】${s.title}${done ? `（已${done === 'applied' ? '套用' : '略過'}）` : ''}`)
    lines.push(`   證據：${s.evidence.count} 次${s.evidence.quotes.length ? `，「${s.evidence.quotes.at(-1)}」` : ''}`)
    lines.push(`   檔案：${s.change.file}`)
  })
  lines.push('', HELP)
  return lines.join('\n')
}
