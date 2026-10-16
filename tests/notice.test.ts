import { expect, test } from 'claude-code/testing'
import { enqueue, noticeContext, previousNotice, thresholdNotice } from '../hooks/lib/notice'
import { latestUnreviewed, type Snapshot } from '../hooks/lib/snapshot'
import { parseFupanArgs } from '../hooks/lib/format'

test('通知去重：同一條規則、同一個對話只排一次', () => {
  let q = enqueue([], thresholdNotice('e1', '標題用中文'))
  q = enqueue(q, thresholdNotice('e1', '標題用中文'))
  q = enqueue(q, previousNotice('s1', 6, 1))
  expect(q.length).toBe(2)
})

test('給 Claude 的指示：每則一行，加在回答最後；沒有通知就不加', () => {
  expect(noticeContext([])).toBe(undefined)
  const ctx = noticeContext([thresholdNotice('e1', '標題用中文'), previousNotice('s1', 6, 1)])!
  expect(ctx).toContain('回答的最後另起一行')
  expect(ctx).toContain('> 復盤：「標題用中文」已糾正 3 次，可以跑 /fupan')
  expect(ctx).toContain('> 復盤：上一個對話（6 輪，糾正 1 次）還沒復盤，跑 /fupan 上一個，或 /fupan 不用')
})

const snap = (over: Partial<Snapshot>): Snapshot => ({
  sessionId: 'a', project: '/p', turns: 6, corrections: 0, transcript: '', resume: { id: 'a' }, status: 'open', at: 1, ...over,
})

test('/fupan 上一個：最近一個沒復盤、沒說不用的別的對話（問過的也算）', () => {
  const snaps = [snap({ sessionId: 'old', at: 1 }), snap({ sessionId: 'asked', status: 'asked', at: 2 }), snap({ sessionId: 'done', status: 'reviewed', at: 3 }), snap({ sessionId: 'cur', at: 4 })]
  expect(latestUnreviewed(snaps, 'cur')?.sessionId).toBe('asked')
  expect(latestUnreviewed([snap({ sessionId: 'x', status: 'dismissed' })], 'cur')).toBe(undefined)
  expect(parseFupanArgs('上一個')).toEqual({ action: 'previous' })
  expect(parseFupanArgs('不用')).toEqual({ action: 'dismiss' })
})
