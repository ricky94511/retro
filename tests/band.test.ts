import { expect, test } from 'claude-code/testing'
import { shouldAsk } from '../hooks/lib/snapshot'

// 輸入框上方的提示：是否要問只看快照的輪數與糾正次數（畫面由 register.tsx 的 AbovePrompt 畫）
test('結束的對話：少於 5 輪沒糾正不提示；有糾正就提示', () => {
  expect(shouldAsk({ turns: 2, corrections: 0 })).toBe(false)
  expect(shouldAsk({ turns: 2, corrections: 1 })).toBe(true)
})
