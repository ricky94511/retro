import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 測試在 bun 裡跑，有 setTimeout；mod 的型別環境沒有
declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown

type Engine = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[0]

// 外掛底下的世界：沒裝 JEV、模型回覆、帳本檔案
type World = {
  writes: Record<string, string>
  haiku: string[]
  haikuReply: string
  ledger: string
  surfaces: string[]
  sessionId: string
  contexts: string[]
  toasts: string[]
  isCloud: boolean
}

const setup = (on: On, over: Partial<World> = {}): World => {
  const w: World = {
    writes: {}, haiku: [], haikuReply: '{"isHabit": true, "entryId": null, "rule": "不要用 rm -rf"}',
    ledger: '', surfaces: [], sessionId: 's1', contexts: [], toasts: [], isCloud: false, ...over,
  }
  const ok = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', ($, e) => {
    const script = e.argv[2] ?? ''
    if (script === 'printf %s "$HOME"') return ok('/home/u')
    if (script.includes('CLAUDE_CODE_REMOTE_SDK_URL')) return ok(w.isCloud ? 'https://remote' : '')
    return ok('') // 找不到 jev.py
  })
  on('prompt.submit', ($, e) => {
    w.contexts.push((e.context ?? []).join('\n'))
    return { text: e.text }
  })
  // 只有帳本可能有內容，其他檔案都不存在
  on('fs.read', ($, e) => ({ value: w.writes[e.path] ?? (e.path.endsWith('ledger.json') ? w.ledger : '') }))
  on('session.surfaces', () => ({ value: w.surfaces as never }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  // 資料夾內容：寫過的檔案
  on('fs.list', ($, e) => ({
    value: Object.keys(w.writes)
      .filter(p => p.startsWith(`${e.path}/`))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })) as never,
  }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.turns', () => ({ value: 1 }))
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

// 帳本裡已有一條糾正 2 次的規則，這句是第 3 次
const correction = (id: string, quote: string) => ({
  id, at: 1, kind: 'correct', entryId: 'e1', rule: '標題用中文', sessionId: 's0', project: '/proj', quote, file: '', source: '本機',
})
const twice = JSON.stringify({ events: [correction('ev1', 'a'), correction('ev2', 'b')], unsynced: [] })
const third = '{"isHabit": true, "entryId": "e1", "rule": "標題用中文"}'

test('沒有畫面（雲端）：回答結束後跳對話框；對話框打不開就在下一次回答最後加一行，只加一次', async ($, on) => {
  const w = setup(on, { ledger: twice, haikuReply: third })
  on('turn.complete', () => ({ text: '好的' }))
  await submit($, '又用英文標題了')
  expect(w.toasts).toEqual([])
  // 這一輪結束：測試環境沒有對話框，問不了
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '好的' } as never)
  await new Promise(r => setTimeout(r, 50))
  await submit($, '幫我看這個 bug')
  expect(w.contexts.at(-1)).toContain('> 復盤：「標題用中文」已糾正 3 次，可以跑 /fupan')
  await submit($, '再看一個')
  expect(w.contexts.at(-1)).not.toContain('已糾正 3 次')
})

test('有畫面（終端機）：累積到 3 次就跳 toast，不加在回答裡', async ($, on) => {
  const w = setup(on, { ledger: twice, haikuReply: third, surfaces: ['terminal'] })
  await submit($, '又用英文標題了')
  expect(w.toasts).toEqual(['復盤：「標題用中文」已糾正 3 次，可以跑 /fupan'])
  await submit($, '幫我看這個 bug')
  expect(w.contexts.at(-1)).not.toContain('已糾正 3 次')
})

const SESSIONS = '/home/u/.claude/retro/sessions'
const snapshot = (id: string) =>
  JSON.stringify({ sessionId: id, project: '/proj', turns: 1, corrections: 1, transcript: '用戶：不要這樣', resume: { id }, status: 'open', at: 1 })

const startAndFinishTurn = async ($: Engine, on: On) => {
  on('turn.complete', () => ({ text: '好的' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: true })
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: true }) // 熱重載：session.start 再跑一次
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '好的' } as never)
  await new Promise(r => setTimeout(r, 50))
  await submit($, '下一句')
}

test('熱重載不是新對話：同一個 session 不會問「上一個對話要不要復盤」', async ($, on) => {
  const w = setup(on)
  w.writes[`${SESSIONS}/s1.json`] = snapshot('s1')
  await startAndFinishTurn($, on)
  expect(w.contexts.at(-1)).not.toContain('上一個對話')
  expect(Object.keys(w.writes).filter(p => p.startsWith(SESSIONS))).toEqual([`${SESSIONS}/s1.json`])
})

test('真的換了對話：上一個沒復盤、有糾正的對話要問', async ($, on) => {
  const w = setup(on, { sessionId: 's2' })
  w.writes[`${SESSIONS}/s1.json`] = snapshot('s1')
  await startAndFinishTurn($, on)
  expect(w.contexts.at(-1)).toContain('上一個對話（1 輪，糾正 1 次）')
})

// ── 恢復：雲端的新容器把已套用的規則補回 ~/.claude/CLAUDE.md ──
const applied = JSON.stringify({
  events: [
    correction('ev1', 'a'),
    { ...correction('ap1', ''), kind: 'apply', file: '~/.claude/CLAUDE.md', quote: '- 標題一律用中文' },
  ],
  unsynced: [],
})
const USER_MD = '/home/u/.claude/CLAUDE.md'

test('雲端：開對話時把已套用的規則補回 CLAUDE.md', async ($, on) => {
  const w = setup(on, { ledger: applied, isCloud: true })
  await startAndFinishTurn($, on)
  expect(w.writes[USER_MD]).toBe('- 標題一律用中文\n')
})

test('本機：缺的規則補在檔尾，寫之前先備份；已經有的（格式不同也算）不補', async ($, on) => {
  const w = setup(on, { ledger: applied })
  w.writes[USER_MD] = '# 我的規則\n\n- 回覆用繁中\n'
  await startAndFinishTurn($, on)
  expect(w.writes[USER_MD]).toBe('# 我的規則\n\n- 回覆用繁中\n- 標題一律用中文\n')
  const backups = Object.keys(w.writes).filter(p => p.startsWith(`${USER_MD}.bak-`))
  expect(backups.map(p => w.writes[p])).toEqual(['# 我的規則\n\n- 回覆用繁中\n'])
})

test('本機：規則已經在（手動改成沒有「- 」、加了句號），不寫檔也不備份', async ($, on) => {
  const w = setup(on, { ledger: applied })
  w.writes[USER_MD] = '標題一律用中文。\n'
  await startAndFinishTurn($, on)
  expect(w.writes[USER_MD]).toBe('標題一律用中文。\n')
  expect(Object.keys(w.writes).some(p => p.includes('.bak-'))).toBe(false)
})

// ── Notion 同步 ──
const DB = 'https://app.notion.com/p/e0ec8fd62e61450a84be3fe7d28206f5'
const FETCHED = '<data-source url="{{collection://3df503d3-10f1-4a72-b655-a9819a0045e0}}"> <view url="{{view://912435fe-d7ff-4466-ac5f-e7253b65d22b}}">'
const remoteRow = {
  事件ID: 'ev_remote', 類型: '糾正', 規則ID: 'e1', 規則: '標題用中文', 原話: '雲端那句', 專案: '/proj', 對話: 's9',
  來源: '雲端', 檔案: '', 'date:時間:start': '2026-10-16T08:00:00.000Z',
}

const notionWorld = (on: On, isUp = true) => {
  const created: Record<string, unknown>[] = []
  const text = (t: string) => ({ value: { content: [{ type: 'text', text: t }], isError: false } as never })
  on('mcp.call', ($, e) => {
    if (!isUp || e.server !== 'Notion') return { value: { content: [{ type: 'text', text: 'not connected' }], isError: true } as never }
    if (e.tool === 'notion-fetch') return text(FETCHED)
    if (e.tool === 'notion-query-data-sources') return text(JSON.stringify({ results: [remoteRow], has_more: false }))
    if (e.tool === 'notion-create-pages') {
      created.push(...((e.args as { pages: { properties: Record<string, unknown> }[] }).pages.map(p => p.properties)))
      return text('{"pages":[]}')
    }
    return text('{}')
  })
  return created
}

const runFupan = async ($: Engine, args: string) =>
  ((await $.command.run({ command: 'fupan', args } as never)) as { text?: string }).text ?? ''

test('/fupan notion <網址>：拉下 Notion 的事件合併、推上本機還沒推的事件', async ($, on) => {
  const w = setup(on, { ledger: JSON.stringify({ events: [correction('ev_local', '本機那句')], unsynced: ['ev_local'] }) })
  const created = notionWorld(on)
  expect(await runFupan($, `notion ${DB}`)).toContain(
    '已同步：Notion 上有 1 個事件，推上 1 個新事件。\n帳本：2 個事件（糾正 2、套用 0、略過 0），歸成 1 條規則（已套用 0、累積中 1、已略過 0）。\n（fupan ',
  )
  expect(created.map(p => p['事件ID'])).toEqual(['ev_local'])
  const ledger = JSON.parse(w.writes['/home/u/.claude/retro/ledger.json']!)
  expect(ledger.events.map((e: { id: string }) => e.id).sort()).toEqual(['ev_local', 'ev_remote'])
  expect(ledger.unsynced).toEqual([])
  expect(ledger.entries[0].count).toBe(2)
  // 設定存檔，下次不用再找
  expect(JSON.parse(w.writes['/home/u/.claude/retro/notion.json']!).server).toBe('Notion')
})

test('連不上 Notion：事件留在本機，回覆說明', async ($, on) => {
  const w = setup(on, { ledger: JSON.stringify({ events: [correction('ev_local', '本機那句')], unsynced: ['ev_local'] }) })
  notionWorld(on, false)
  expect(await runFupan($, `notion ${DB}`)).toContain('連不上 Notion')
  expect(w.writes['/home/u/.claude/retro/ledger.json']).toBe(undefined) // 帳本沒動
})

test('連接器名稱是一串 ID：從目前的工具找到它；連不上時回報真正的原因', async ($, on) => {
  const w = setup(on)
  on('session.usage', () => ({
    value: { context: { breakdown: { mcpTools: [{ name: 'mcp__0ecba4d4__notion-fetch', serverName: '0ecba4d4', tokens: 1 }] } } } as never,
  }))
  const tried: string[] = []
  on('mcp.call', ($, e) => {
    tried.push(e.server)
    return { value: { content: [{ type: 'text', text: 'permission denied' }], isError: true } as never }
  })
  const text = await runFupan($, `notion ${DB}`)
  expect(tried[0]).toBe('0ecba4d4')
  expect(text).toContain('原因：notion-fetch 失敗（0ecba4d4：permission denied')
  expect(w.writes['/home/u/.claude/retro/notion.json']).toBe(undefined)
})

test('沒設定 Notion：/fupan 同步 說怎麼設定', async ($, on) => {
  setup(on)
  notionWorld(on)
  expect(await runFupan($, '同步')).toContain('還沒設定 Notion')
})

test('/fupan 復盤前先跟 Notion 拉一次，再交給模型', async ($, on) => {
  const w = setup(on)
  w.writes['/home/u/.claude/retro/notion.json'] = JSON.stringify({
    database: DB, dataSourceId: '3df503d3-10f1-4a72-b655-a9819a0045e0',
    viewUrl: 'https://www.notion.so/e0ec8fd62e61450a84be3fe7d28206f5?v=912435fed7ff4466ac5fe7253b65d22b', server: 'Notion',
  })
  const order: string[] = []
  on('mcp.call', ($, e) => {
    order.push(e.tool)
    const body = e.tool === 'notion-query-data-sources' ? JSON.stringify({ results: [remoteRow], has_more: false }) : '{}'
    return { value: { content: [{ type: 'text', text: body }], isError: false } as never }
  })
  on('model.fork', () => {
    order.push('fork')
    return { value: { isAnswered: true, text: '[]' } as never }
  })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } as never }))
  await runFupan($, '')
  expect(order.indexOf('notion-query-data-sources')).toBeGreaterThan(-1)
  expect(order.indexOf('notion-query-data-sources')).toBeLessThan(order.indexOf('fork'))
  // 拉下來的事件已合併進帳本
  expect(JSON.parse(w.writes['/home/u/.claude/retro/ledger.json']!).events[0].id).toBe('ev_remote')
})

test('雲端：/fupan 同步 用 Notion 上真實格式的套用事件，把規則補回 ~/.claude/CLAUDE.md', async ($, on) => {
  const w = setup(on, { isCloud: true })
  w.writes['/home/u/.claude/retro/notion.json'] = JSON.stringify({
    database: DB, dataSourceId: '3df503d3-10f1-4a72-b655-a9819a0045e0',
    viewUrl: 'https://www.notion.so/e0ec8fd62e61450a84be3fe7d28206f5?v=912435fed7ff4466ac5fe7253b65d22b', server: 'Notion',
  })
  // 從 Notion 實際讀回來的兩列（檔案欄被轉成 Markdown）
  const rows = [
    { 事件ID: 'ev_1', 類型: '糾正', 規則ID: 'r_zh', 規則: '回覆一律用繁體中文', 原話: '又用英文<br><br>講過了', 檔案: '', 'date:時間:start': '2026-10-16T08:13:00.000Z' },
    { 事件ID: 'ap_1', 類型: '套用', 規則ID: 'r_zh', 規則: '回覆一律用繁體中文', 原話: '- 回覆一律用繁體中文，標題也用中文，不用英文標題。',
      檔案: '\\~/.claude/[CLAUDE.md](http://CLAUDE.md)', 'date:時間:start': '2026-10-16T08:35:00.000Z' },
  ]
  on('mcp.call', ($, e) => {
    const body = e.tool === 'notion-query-data-sources' ? JSON.stringify({ results: rows, has_more: false }) : '{}'
    return { value: { content: [{ type: 'text', text: body }], isError: false } as never }
  })
  on('ui.invalidate', () => ({ value: undefined }) as never)
  const reply = await runFupan($, '同步')
  expect(reply).toContain('雲端・套用到 ~/.claude/CLAUDE.md 的規則 1 條：本來就在 0 條，這次補回 1 條')
  expect(w.writes['/home/u/.claude/CLAUDE.md']).toBe('- 回覆一律用繁體中文，標題也用中文，不用英文標題。\n')
})

test('帳本裡留著舊版讀錯的路徑：同步時以 Notion 上的為準，照樣補回', async ($, on) => {
  // 舊版從 Notion 讀回來、沒還原的格式，已經存在本機帳本
  const stale = {
    id: 'ap_1', at: 2, kind: 'apply', entryId: 'r_zh', rule: '回覆一律用繁體中文', sessionId: 's0', project: '/proj',
    quote: '- 回覆一律用繁體中文。', file: '\\~/.claude/[CLAUDE.md](http://CLAUDE.md)', source: '雲端',
  }
  const w = setup(on, { isCloud: true, ledger: JSON.stringify({ events: [correction('ev_1', 'a'), stale], unsynced: [] }) })
  w.writes['/home/u/.claude/retro/notion.json'] = JSON.stringify({
    database: DB, dataSourceId: '3df503d3-10f1-4a72-b655-a9819a0045e0',
    viewUrl: 'https://www.notion.so/e0ec8fd62e61450a84be3fe7d28206f5?v=912435fed7ff4466ac5fe7253b65d22b', server: 'Notion',
  })
  const rows = [{ 事件ID: 'ap_1', 類型: '套用', 規則ID: 'r_zh', 規則: '回覆一律用繁體中文', 原話: '- 回覆一律用繁體中文。',
    檔案: '\\~/.claude/[CLAUDE.md](http://CLAUDE.md)', 'date:時間:start': '2026-10-16T08:35:00.000Z' }]
  on('mcp.call', ($, e) => {
    const body = e.tool === 'notion-query-data-sources' ? JSON.stringify({ results: rows, has_more: false }) : '{}'
    return { value: { content: [{ type: 'text', text: body }], isError: false } as never }
  })
  on('ui.invalidate', () => ({ value: undefined }) as never)
  expect(await runFupan($, '同步')).toContain('這次補回 1 條')
  expect(w.writes['/home/u/.claude/CLAUDE.md']).toBe('- 回覆一律用繁體中文。\n')
})
