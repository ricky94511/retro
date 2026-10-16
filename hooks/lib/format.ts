// /fupan 的文字介面：App 裡看不到面板時，建議、預覽、套用結果都用指令回覆顯示
import type { Review } from '../../types'

export type FupanArgs =
  | { action: 'run' }
  | { action: 'preview' | 'apply' | 'skip'; n: number }
  | { action: 'help' }
  | { action: 'probe' } // 測試哪些提示在這個環境看得到
  | { action: 'previous' | 'dismiss' } // 上一個沒復盤的對話：復盤／不用

const VERBS: Record<string, 'preview' | 'apply' | 'skip'> = {
  預覽: 'preview', preview: 'preview',
  套用: 'apply', apply: 'apply',
  略過: 'skip', skip: 'skip',
}

export const parseFupanArgs = (args: string): FupanArgs => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { action: 'run' }
  if (words[0] === '測試顯示' || words[0] === 'probe') return { action: 'probe' }
  if (words[0] === '上一個' || words[0] === 'previous') return { action: 'previous' }
  if (words[0] === '不用' || words[0] === 'dismiss') return { action: 'dismiss' }
  const verb = VERBS[words[0]!.toLowerCase()]
  const n = Number(words[1])
  if (!verb || !Number.isInteger(n) || n < 1) return { action: 'help' }
  return { action: verb, n }
}

export const HELP = '用法：/fupan（復盤這段對話）、/fupan 上一個、/fupan 不用、/fupan 預覽 N、/fupan 套用 N、/fupan 略過 N'

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

// 用選的：一開始三個選項（改設定一定要先預覽，只有兩個）；預覽後只剩套用或略過
export const PREVIEW = '預覽改動'
export const APPLY = '套用'
export const SKIP = '略過'

export const firstChoices = (kind: string): string[] =>
  kind === '改設定' ? [PREVIEW, SKIP] : [PREVIEW, APPLY, SKIP]

export const afterPreviewChoices = (): string[] => [APPLY, SKIP]

export const PREVIEW_LINES = 30

// 問題的標頭：第幾條、證據、檔案
export const questionHead = (s: { kind: string; title: string; evidence: { count: number; quotes: string[] }; change: { file: string } }, i: number, total: number): string => {
  const q = s.evidence.quotes.at(-1)
  return [
    `復盤 ${i}/${total}：【${s.kind}】${s.title}`,
    `證據：${s.evidence.count} 次${q ? `，「${q}」` : ''}`,
    `檔案：${s.change.file}`,
  ].join('\n')
}

export const previewQuestion = (head: string, lines: string[]): string => {
  const shown = lines.slice(0, PREVIEW_LINES)
  const more = lines.length > shown.length ? `\n…（還有 ${lines.length - shown.length} 行）` : ''
  return `${head}\n\n改動：\n${shown.join('\n')}${more}\n\n要套用嗎？`
}
