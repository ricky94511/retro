import { expect, test } from 'claude-code/testing'
import { quote, redact, redactSettings } from '../hooks/lib/redact'

const KEY = 'sk_live_' + 'a'.repeat(40)

test('金鑰樣式與 KEY=… 的值遮成 ***', () => {
  expect(redact(`用 ${KEY} 登入`)).toBe('用 *** 登入')
  expect(redact('TYPESAFE_API_KEY=abc123')).toBe('TYPESAFE_API_KEY=***')
})

test('原話：遮蔽後截到 200 字', () => {
  expect(quote('短句')).toBe('短句')
  expect(quote('字'.repeat(300)).length).toBe(200)
  expect(quote(`給你 ${KEY}`)).toBe('給你 ***')
})

test('設定檔：名稱像金鑰的值全遮，其餘保留', () => {
  const out = redactSettings({ env: { TYPESAFE_API_KEY: 'x', HOME_DIR: '/a' }, model: 'opus', hooks: [{ token: 't' }] })
  expect(out).toEqual({ env: { TYPESAFE_API_KEY: '***', HOME_DIR: '/a' }, model: 'opus', hooks: [{ token: '***' }] })
})
