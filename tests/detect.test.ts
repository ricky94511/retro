import { expect, test } from 'claude-code/testing'
import { hasKeyword, isCandidate, parseJevProbability, parseVerdict } from '../hooks/lib/detect'

test('斜線指令與機器送的訊息不判斷，人打的才判斷', () => {
  expect(isCandidate('/fupan', { kind: 'composer' })).toBe(false)
  expect(isCandidate('背景完成', { kind: 'task-notification' })).toBe(false)
  expect(isCandidate('別再用 rm 了', { kind: 'composer' })).toBe(true)
  expect(isCandidate('別再用 rm 了', { kind: 'bridge' })).toBe(true)
  expect(isCandidate('x', undefined)).toBe(false)
})

test('關鍵字篩：中英文命中，一般句子不命中', () => {
  expect(hasKeyword('不要用 sed 改檔')).toBe(true)
  expect(hasKeyword('你又忘了')).toBe(true)
  expect(hasKeyword('Never use rm -rf')).toBe(true)
  expect(hasKeyword('幫我看這個 bug')).toBe(false)
})

test('JEV 的機率：取 q 欄位，壞掉就 undefined', () => {
  expect(parseJevProbability('{"q": 0.83}')).toBe(0.83)
  expect(parseJevProbability('not json')).toBe(undefined)
})

test('Haiku 回覆：取出 JSON，亂回就 null', () => {
  expect(parseVerdict('好的：{"isHabit": true, "entryId": "e1", "rule": "標題用繁中"}')).toEqual({
    isHabit: true, entryId: 'e1', rule: '標題用繁中',
  })
  expect(parseVerdict('{"isHabit": true, "entryId": null, "rule": "x"}')?.entryId).toBe(null)
  expect(parseVerdict('不是 JSON')).toBe(null)
  expect(parseVerdict('{"entryId": "e1"}')).toBe(null)
})
