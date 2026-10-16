// 偵測糾正：斜線指令與機器送的訊息不判斷；關鍵字先篩，過了才問 JEV 或 Haiku

export type Origin = { kind: string }

// 只有人打的（或 SDK、遠端、無法分類的）才判斷；其他（背景任務、排程、別的 Claude 送來的）跳過
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'unclassified'])

export const isCandidate = (text: string, origin: Origin | undefined): boolean => {
  if (text.trimStart().startsWith('/')) return false
  return origin !== undefined && HUMAN_ORIGINS.has(origin.kind)
}

// 中英文的糾正用語
const KEYWORDS = [
  /不要/, /別再/, /又/, /我說過/, /每次/, /一律/, /應該先/, /應該要/, /下次/,
  /\bnever\b/i, /\balways\b/i, /\bagain\b/i, /don'?t\s+(?:do|use|ever)/i, /I (?:already )?told you/i,
]

export const hasKeyword = (text: string): boolean => KEYWORDS.some(re => re.test(text))

export const JEV_THRESHOLD = 0.6

// JEV ask 的輸出是 {"<題目名>": 機率}；只取 noul 題的機率
export const parseJevProbability = (stdout: string, name = 'q'): number | undefined => {
  try {
    const v = JSON.parse(stdout) as Record<string, unknown>
    const p = v[name]
    return typeof p === 'number' ? p : undefined
  } catch {
    return undefined
  }
}

// Haiku 的回覆：{"isHabit":bool,"entryId":string|null,"rule":string}；亂回就丟掉
export type Verdict = { isHabit: boolean; entryId: string | null; rule: string }

export const parseVerdict = (text: string): Verdict | null => {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return null
  try {
    const v = JSON.parse(json) as Partial<Verdict>
    if (typeof v.isHabit !== 'boolean') return null
    return {
      isHabit: v.isHabit,
      entryId: typeof v.entryId === 'string' ? v.entryId : null,
      rule: typeof v.rule === 'string' ? v.rule.trim() : '',
    }
  } catch {
    return null
  }
}

export const VERDICT_PROMPT = (ledgerRules: { id: string; rule: string }[], text: string) => `判斷下面這句話是不是「對以後的習慣糾正」（只改這一次內容的不算）。
如果是，從既有規則挑出對應的 id（沒有對應就 null），並把這個糾正改寫成一句可照做的規則。
只回 JSON：{"isHabit": true|false, "entryId": "<id 或 null>", "rule": "<一句規則>"}

既有規則：
${ledgerRules.map(r => `- ${r.id}: ${r.rule}`).join('\n') || '（無）'}

這句話：
${text}`
