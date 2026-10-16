// 對話快照：每輪結束存一份，對話結束後才能復盤；少於 5 輪且沒有糾正就不問

export const TRANSCRIPT_MAX = 30_000 // 字，保留最後面的
export const MIN_TURNS_TO_ASK = 5

export type Snapshot = {
  sessionId: string
  project: string
  turns: number
  corrections: number
  transcript: string
  resume: { id: string }
  status: 'open' | 'asked' | 'reviewed' | 'dismissed'
  at: number
}

export const clipTranscript = (text: string, max = TRANSCRIPT_MAX): string =>
  text.length <= max ? text : `…（前面 ${text.length - max} 字省略）\n${text.slice(-max)}`

export const shouldAsk = (s: Pick<Snapshot, 'turns' | 'corrections'>): boolean =>
  s.turns >= MIN_TURNS_TO_ASK || s.corrections > 0

// 要在輸入框上方問的：有快照、值得問、還沒問過或處理過
export const pendingAsk = (snaps: Snapshot[], sessionId?: string): Snapshot | undefined =>
  snaps
    .filter(s => s.status === 'open' && shouldAsk(s) && s.sessionId !== sessionId)
    .sort((a, b) => b.at - a.at)[0]

export const withStatus = (snaps: Snapshot[], id: string, status: Snapshot['status']): Snapshot[] =>
  snaps.map(s => (s.sessionId === id ? { ...s, status } : s))
