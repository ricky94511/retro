// 復盤外掛的狀態契約：每個 $.state 值都在這裡宣告

export type Kind = '加規則' | '新 skill' | '改 skill' | '刪 skill' | '改設定'

// 一條建議：證據是帳本條目與原話；改動是檔案與要替換的原文，或新 skill 全文，或要刪的 skill
export type Suggestion = {
  id: string
  kind: Kind
  title: string
  evidence: { entryId: string; count: number; quotes: string[] }
  change:
    | { file: string; oldText: string; newText: string }
    | { file: string; deleteSkill: true }
    | { file: string; fullText: string }
}

// 輸入框上方問「要不要復盤剛才的對話？」
export type Band = { snapshotId: string; turns: number; corrections: number }

// 面板：這次產生的建議；previews 是按過「預覽改動」的建議（改設定套用前必須有）
export type Review = {
  suggestions: Suggestion[]
  previews: Record<string, string[]>
  note: string | null
}

declare module 'claude-code' {
  interface PluginState {
    fupan: { band: Band | null; review: Review | null }
  }
}
