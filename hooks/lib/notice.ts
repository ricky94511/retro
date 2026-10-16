// 提醒：有畫面（終端機）用 toast 與按鈕；沒有（雲端 session）在回答結束後直接跳提問對話框，
// 對話框打不開時才退回請 Claude 加在下一次回答最後

export type Notice =
  | { kind: 'rule'; key: string; entryId: string; rule: string; line: string }
  | { kind: 'previous'; key: string; snapshotId: string; turns: number; corrections: number; line: string }

export const thresholdNotice = (entryId: string, rule: string): Notice => ({
  kind: 'rule',
  key: `rule:${entryId}`,
  entryId,
  rule,
  line: `復盤：「${rule}」已糾正 3 次，可以跑 /fupan`,
})

export const previousNotice = (snapshotId: string, turns: number, corrections: number): Notice => ({
  kind: 'previous',
  key: `snap:${snapshotId}`,
  snapshotId,
  turns,
  corrections,
  line: `復盤：上一個對話（${turns} 輪，糾正 ${corrections} 次）還沒復盤，跑 /fupan 上一個，或 /fupan 不用`,
})

export const enqueue = (queue: Notice[], n: Notice): Notice[] =>
  queue.some(q => q.key === n.key) ? queue : [...queue, n]

// 退回的做法：請 Claude 原樣加在回答最後
export const noticeContext = (queue: Notice[]): string | undefined =>
  queue.length === 0
    ? undefined
    : `回答的最後另起一行，原樣加上這些通知（每則一行）：\n${queue.map(n => `> ${n.line}`).join('\n')}`

// 對話框的問題與選項
export const REVIEW = '復盤'
export const LATER = '之後再說'
export const NO = '不用'

export const dialogFor = (n: Notice): { question: string; options: string[] } =>
  n.kind === 'rule'
    ? { question: `「${n.rule}」已經糾正 3 次了，要現在復盤嗎？`, options: [REVIEW, LATER] }
    : {
        question: `上一個對話（${n.turns} 輪，糾正 ${n.corrections} 次）還沒復盤，要現在復盤嗎？`,
        options: [REVIEW, NO, LATER],
      }

// 按下後要做什麼；打其他字（Other）當作之後再說
export type Reaction = 'review-current' | 'review-previous' | 'dismiss-previous' | 'later'

export const reactionFor = (n: Notice, answer: string): Reaction => {
  if (answer === REVIEW) return n.kind === 'rule' ? 'review-current' : 'review-previous'
  if (answer === NO && n.kind === 'previous') return 'dismiss-previous'
  return 'later'
}

// 復盤完的結果也用對話框顯示（回覆一定看得到的只有指令回覆和對話框）
export const DONE_OPTIONS = ['好', '用 /fupan 再看一次']
