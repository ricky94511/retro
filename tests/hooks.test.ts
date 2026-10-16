import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 測試在 bun 裡跑，有 setTimeout；mod 的型別環境沒有
declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown

type Engine = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[0]

// 外掛底下的世界：沒裝 JEV、模型回覆、帳本檔案
type World = { writes: Record<string, string>; haiku: string[]; haikuReply: string }

const setup = (on: On, over: Partial<World> = {}): World => {
  const w: World = { writes: {}, haiku: [], haikuReply: '{"isHabit": true, "entryId": null, "rule": "不要用 rm -rf"}', ...over }
  const ok = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', ($, e) => {
    const script = e.argv[2] ?? ''
    if (script === 'printf %s "$HOME"') return ok('/home/u')
    return ok('') // 找不到 jev.py
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('fs.read', () => ({ value: '' })) // 檔案都不存在
  on('fs.list', () => ({ value: [] }))
  on('fs.write', ($, e) => {
    w.writes[e.path] = e.text
    return { value: undefined }
  })
  on('model.complete', ($, e) => {
    w.haiku.push(e.model)
    return { value: { isAnswered: true, text: w.haikuReply } as never }
  })
  on('session.root', () => ({ value: '/proj' }))
  return w
}

const submit = async ($: Engine, text: string, kind = 'composer') => {
  await $.prompt.submit({ text, wait: false, origin: { kind } as never })
  // 偵測在背景跑，讓它有機會寫完
  await new Promise(r => setTimeout(r, 50))
}

test('斜線指令與機器送的訊息不問模型', async ($, on) => {
  const w = setup(on)
  await submit($, '/fupan')
  await submit($, '別再用 rm -rf 了', 'task-notification')
  expect(w.haiku).toEqual([])
})

test('沒裝 JEV：沒有糾正用語就不問 Haiku', async ($, on) => {
  const w = setup(on)
  await submit($, '幫我看這個 bug')
  expect(w.haiku).toEqual([])
})

test('沒裝 JEV：糾正用語 → Haiku 判定是習慣 → 寫進帳本', async ($, on) => {
  const w = setup(on)
  await submit($, '別再用 rm -rf 了')
  expect(w.haiku).toEqual(['haiku'])
  const path = Object.keys(w.writes).find(p => p.endsWith('/.claude/retro/ledger.json'))
  expect(path).toBeDefined()
  const ledger = JSON.parse(w.writes[path!]!)
  expect(ledger.entries[0].rule).toBe('不要用 rm -rf')
  expect(ledger.events[0].quote).toBe('別再用 rm -rf 了')
})

test('Haiku 說不是習慣糾正 → 不記', async ($, on) => {
  const w = setup(on, { haikuReply: '{"isHabit": false, "entryId": null, "rule": ""}' })
  await submit($, '不要這個檔案，只改這次')
  expect(Object.keys(w.writes).filter(p => p.endsWith('ledger.json'))).toEqual([])
})
