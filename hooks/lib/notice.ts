// 沒有畫面的環境（雲端 session）看不到 toast 與按鈕：把通知排隊，下一次送訊息時請 Claude 加在回答最後

export type Notice = { key: string; line: string } // key 用來去重（同一條規則、同一個對話只排一次）

export const thresholdNotice = (entryId: string, rule: string): Notice => ({
  key: `rule:${entryId}`,
  line: `復盤：「${rule}」已糾正 3 次，可以跑 /fupan`,
})

export const previousNotice = (snapshotId: string, turns: number, corrections: number): Notice => ({
  key: `snap:${snapshotId}`,
  line: `復盤：上一個對話（${turns} 輪，糾正 ${corrections} 次）還沒復盤，跑 /fupan 上一個，或 /fupan 不用`,
})

export const enqueue = (queue: Notice[], n: Notice): Notice[] =>
  queue.some(q => q.key === n.key) ? queue : [...queue, n]

// 給 Claude 的指示：原樣加在回答最後
export const noticeContext = (queue: Notice[]): string | undefined =>
  queue.length === 0
    ? undefined
    : `回答的最後另起一行，原樣加上這些通知（每則一行）：\n${queue.map(n => `> ${n.line}`).join('\n')}`
