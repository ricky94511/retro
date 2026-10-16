import { expect, test } from 'claude-code/testing'
import { clipTranscript, pendingAsk, shouldAsk, withStatus, TRANSCRIPT_MAX, type Snapshot } from '../hooks/lib/snapshot'

const snap = (over: Partial<Snapshot>): Snapshot => ({
  sessionId: 'a', project: '/p', turns: 6, corrections: 0, transcript: '', resume: { id: 'a' }, status: 'open', at: 1, ...over,
})

test('逐字稿超過 3 萬字就保留最後面', () => {
  const long = 'x'.repeat(TRANSCRIPT_MAX + 100) + 'END'
  const out = clipTranscript(long)
  expect(out.endsWith('END')).toBe(true)
  expect(out.length).toBeLessThan(TRANSCRIPT_MAX + 100)
  expect(clipTranscript('短')).toBe('短')
})

test('少於 5 輪且沒有糾正不問；有糾正或到 5 輪就問', () => {
  expect(shouldAsk({ turns: 4, corrections: 0 })).toBe(false)
  expect(shouldAsk({ turns: 4, corrections: 1 })).toBe(true)
  expect(shouldAsk({ turns: 5, corrections: 0 })).toBe(true)
})

test('開新對話時撿上一個沒復盤的；已處理或同一個對話不撿', () => {
  expect(pendingAsk([snap({ sessionId: 'old' })], 'new')?.sessionId).toBe('old')
  expect(pendingAsk([snap({ sessionId: 'old', status: 'dismissed' })], 'new')).toBe(undefined)
  expect(pendingAsk([snap({ sessionId: 'old', status: 'reviewed' })], 'new')).toBe(undefined)
  expect(pendingAsk([snap({ sessionId: 'cur' })], 'cur')).toBe(undefined)
  expect(pendingAsk([snap({ sessionId: 'few', turns: 2 })], 'new')).toBe(undefined)
})

test('按「不用」標記已處理', () => {
  expect(withStatus([snap({ sessionId: 'a' })], 'a', 'dismissed')[0]!.status).toBe('dismissed')
})
