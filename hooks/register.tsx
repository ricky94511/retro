import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Band, Review, Suggestion } from '../types'

import { countSkillUses, absolute, memoryPath } from './lib/context'
import { isWritableMarkdown, isSettingsFile, applyChange, isValidJson, backupName, trashDir, diffLines } from './lib/apply'
import { isCandidate, passesFilter, parseJevProbability, parseVerdict, VERDICT_PROMPT, JEV_QUESTION } from './lib/detect'
import { addCorrection, dueEntries, markApplied, markSkipped, markSynced, mergeEvents, parseLedger, type Due, type Event, type Ledger, type Source } from './lib/ledger'
import { restorable, restoreText } from './lib/restore'
import { PUSH_BATCH, SERVERS, fromNotion, parseDatabase, parsePage, resultJson, toNotion, type NotionConfig } from './lib/sync'
import { quote, redact, redactSettings } from './lib/redact'
import { clipTranscript, latestUnreviewed, pendingAsk, shouldAsk, type Snapshot } from './lib/snapshot'
import { DONE_OPTIONS, dialogFor, enqueue, noticeContext, previousNotice, reactionFor, thresholdNotice, type Notice } from './lib/notice'
import { buildPrompt, parseSuggestions, type Context } from './lib/suggest'
import { formatReview, parseFupanArgs, HELP, firstChoices, afterPreviewChoices, questionHead, previewQuestion, PREVIEW, APPLY, SKIP } from './lib/format'

// 復盤：偵測糾正 → 帳本 → 提議 CLAUDE.md／skill／設定的修改，面板逐條預覽、套用

const PANE = 'fupan'
const band = atom({ plugin: 'fupan', key: 'band' } as const, null as Band | null)
const review = atom({ plugin: 'fupan', key: 'review' } as const, null as Review | null)

// 這個 session 的狀態（重載外掛會重置，快照檔案留著）
let home: string | undefined
let project = ''
// 快照用引擎的 session id（逐字稿檔名，也是 --resume 用的）：熱重載不會變，/clear 之後才換
let snapshotId = ''
let transcript: string[] = []
let corrections = 0
let seq = 0
let jevPath: string | null | undefined
// 沒有畫面時排隊的提醒：回答結束後跳對話框問；對話框打不開的，下一次送訊息時請 Claude 加在回答最後
let notices: Notice[] = []
let answerNotices: Notice[] = []
let isAsking = false

const hasSurface = async ($: EngineInterface) => (await $.session.surfaces()).length > 0

// 有畫面就 toast；沒有（雲端 session）就排進回答最後的通知
const notify = async ($: EngineInterface, n: Notice) => {
  if (await hasSurface($)) $.ui.toast(n.line)
  else notices = enqueue(notices, n)
}

function newId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

const sh = async ($: EngineInterface, script: string) => {
  const { stdout } = await $.process.run(['sh', '-c', script], { timeoutMs: 20_000 })
  return stdout.trim()
}

const homeDir = async ($: EngineInterface) => {
  home ??= await sh($, 'printf %s "$HOME"')
  return home
}

const readText = async ($: EngineInterface, path: string) => {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

const writeJson = ($: EngineInterface, path: string, value: unknown) => $.fs.write(path, JSON.stringify(value, null, 2))

const retroDir = async ($: EngineInterface) => `${await homeDir($)}/.claude/retro`

const loadLedger = async ($: EngineInterface): Promise<Ledger> =>
  parseLedger(await readText($, `${await retroDir($)}/ledger.json`))

const saveLedger = async ($: EngineInterface, ledger: Ledger) =>
  writeJson($, `${await retroDir($)}/ledger.json`, ledger)

// 帳本的「讀→改→寫」一次只跑一個：偵測、套用、Notion 同步可能同時發生
let ledgerQueue: Promise<unknown> = Promise.resolve()
const updateLedger = ($: EngineInterface, change: (l: Ledger) => Ledger): Promise<Ledger> => {
  const run = ledgerQueue.then(async () => {
    const next = change(await loadLedger($))
    await saveLedger($, next)
    return next
  })
  ledgerQueue = run.catch(() => undefined)
  return run
}

// 本機還是雲端：雲端 session 有 CLAUDE_CODE_REMOTE_SDK_URL
let source: Source | undefined
const sourceOf = async ($: EngineInterface): Promise<Source> => {
  source ??= (await sh($, 'printf %s "${CLAUDE_CODE_REMOTE_SDK_URL:-}"')) ? '雲端' : '本機'
  return source
}

const snapshotPath = async ($: EngineInterface, id: string) => `${await retroDir($)}/sessions/${id}.json`

const loadSnapshot = async ($: EngineInterface, id: string): Promise<Snapshot | undefined> => {
  const text = await readText($, await snapshotPath($, id))
  return text ? (JSON.parse(text) as Snapshot) : undefined
}

// JEV 的 jev.py 找不到就當沒裝：先看 CLAUDE_CODE_PLUGIN_DIRS 與 ~/.claude 底下
const findJev = async ($: EngineInterface): Promise<string | null> => {
  if (jevPath === undefined) {
    const found = await sh(
      $,
      'find "$HOME/.claude" $(printf %s "${CLAUDE_CODE_PLUGIN_DIRS:-}" | tr ":" " ") -maxdepth 8 -name jev.py -path "*scripts*" 2>/dev/null | head -1',
    )
    jevPath = found || null
  }
  return jevPath
}

const askJev = async ($: EngineInterface, text: string): Promise<number | undefined> => {
  const jev = await findJev($)
  if (!jev) return undefined
  const { stdout, exitCode } = await $.process.run(
    [
      'python3', jev, '--project', project, 'ask',
      '--state', JSON.stringify({ x: text }),
      '--q', JSON.stringify({ q: { type: 'noul', instructions: JEV_QUESTION } }),
    ],
    { timeoutMs: 60_000 },
  )
  return exitCode === 0 ? parseJevProbability(stdout) : undefined
}

// 偵測：JEV 有裝就每句先問；沒裝先過關鍵字；過了再問 Haiku 是不是習慣糾正
const detect = async ($: EngineInterface, text: string) => {
  const p = await askJev($, text)
  if (!passesFilter(p, text)) return
  const ledger = await loadLedger($)
  const prompt = VERDICT_PROMPT(
    ledger.entries.map(e => ({ id: e.id, rule: e.rule })),
    text,
  )
  const answer = await $.model.complete({ model: 'haiku', prompt, maxTokens: 300, timeoutMs: 20_000 })
  if (!answer.isAnswered) return
  const verdict = parseVerdict(answer.text)
  if (!verdict?.isHabit) return

  const known = verdict.entryId !== null && ledger.entries.some(e => e.id === verdict.entryId)
  const rule = verdict.rule || redact(text).slice(0, 80)
  const at = Date.now()
  const from = await sourceOf($)
  let crossed = false
  const next = await updateLedger($, l => {
    const r = addCorrection(
      l,
      {
        entryId: known ? verdict.entryId ?? undefined : undefined,
        rule,
        quote: quote(text),
        sessionId: snapshotId,
        project,
        at,
        eventId: `ev_${at.toString(36)}_${seq++}_${Math.random().toString(36).slice(2, 6)}`,
        source: from,
      },
      newId,
    )
    crossed = r.crossed
    return r.ledger
  })
  corrections += 1
  void push($)
  if (crossed) {
    const entry = next.entries.find(e => e.count === 3 && (known ? e.id === verdict.entryId : e.rule === rule))
    await notify($, thresholdNotice(entry?.id ?? rule, entry?.rule ?? rule))
  }
}

// 對上目前的 session：熱重載後接回同一份快照的逐字稿與糾正次數，換了 session（/clear）就重新開始
const syncSession = async ($: EngineInterface) => {
  const id = await $.session.id()
  if (id === snapshotId) return
  snapshotId = id
  const saved = await loadSnapshot($, id)
  transcript = saved?.transcript ? [saved.transcript] : []
  corrections = saved?.corrections ?? 0
}

// 每輪結束存一份；保留已復盤、已略過的狀態
const saveSnapshot = async ($: EngineInterface) => {
  const status = (await loadSnapshot($, snapshotId))?.status ?? 'open'
  const snap: Snapshot = {
    sessionId: snapshotId,
    project,
    turns: await $.session.turns(),
    corrections,
    transcript: clipTranscript(transcript.join('\n\n')),
    resume: { id: snapshotId },
    status,
    at: Date.now(),
  }
  await $.fs.write(await snapshotPath($, snapshotId), JSON.stringify(snap, null, 2))
  return snap
}

const contextFor = async ($: EngineInterface, due: Due[]): Promise<Context> => {
  const h = await homeDir($)
  const claudeFiles = [`${h}/.claude/CLAUDE.md`, `${project}/CLAUDE.md`, `${project}/CLAUDE.local.md`, `${project}/.claude/CLAUDE.md`]
  const claudeMd = (
    await Promise.all(claudeFiles.map(async path => ({ path, text: await readText($, path) })))
  ).flatMap(f => (f.text === undefined ? [] : [{ path: f.path, text: f.text }]))

  const memory = (await readText($, memoryPath(h, project))) ?? ''

  const skillDirs = await $.fs.list(`${h}/.claude/skills`).catch(() => [])
  const usage = countSkillUses(
    await sh($, 'find "$HOME/.claude/projects" -name "*.jsonl" -mtime -30 -exec cat {} + 2>/dev/null'),
    Date.now(),
  )
  const skills = skillDirs
    .filter(d => d.kind === 'dir')
    .map(d => ({ name: d.name, uses30: usage[d.name] ?? 0, path: `${h}/.claude/skills/${d.name}/SKILL.md` }))

  const settings = []
  for (const path of [`${h}/.claude/settings.json`, `${project}/.claude/settings.json`, `${project}/.claude/settings.local.json`]) {
    const text = await readText($, path)
    if (text === undefined) continue
    try {
      settings.push({ path, text: JSON.stringify(redactSettings(JSON.parse(text)), null, 2) })
    } catch {
      settings.push({ path, text: redact(text) })
    }
  }
  return { due, claudeMd, memory, skills, settings }
}

const runReview = async ($: EngineInterface, source: 'fork' | Snapshot) => {
  // 復盤前先跟 Notion 同步一次，用最新的帳本（沒設定或連不上就用本機的）
  await sync($)
  const due = dueEntries(await loadLedger($))
  const ctx = await contextFor($, due)
  const note = due.length === 0 ? '帳本沒有要處理的條目；建議只看這段對話裡的糾正。' : null
  const prompt = buildPrompt(ctx) + (due.length === 0 ? '\n（沒有帳本條目，請直接從對話裡找糾正）\n' : '')

  let text: string | null = null
  if (source === 'fork') {
    const r = await $.model.fork({ prompt })
    text = r.isAnswered ? r.text : null
  } else {
    const r = await $.model.complete({ model: 'sonnet', prompt: `${prompt}\n\n## 對話\n${source.transcript}`, maxTokens: 4000, timeoutMs: 180_000 })
    text = r.isAnswered ? r.text : null
    await withSnapshotStatus($, source.sessionId, 'reviewed')
  }
  const suggestions = text ? parseSuggestions(text) : []
  const result: Review = { suggestions, previews: {}, done: {}, note: text ? note : '模型沒有回覆，請再試一次。' }
  await update($, review, () => result)
  const opened = await $.ui.open({ id: PANE, title: '復盤' })
  // 留一份紀錄：App 看不到面板時可以查是沒跑完還是沒畫出來
  await writeJson($, `${await retroDir($)}/last-review.json`, { at: Date.now(), source: source === 'fork' ? 'fork' : 'snapshot', pane: opened, review: result, raw: text })
  return result
}

const withSnapshotStatus = async ($: EngineInterface, id: string, status: Snapshot['status']) => {
  const snap = await loadSnapshot($, id)
  if (snap) await $.fs.write(await snapshotPath($, id), JSON.stringify({ ...snap, status }, null, 2))
}

// 預覽：算出改動前後差異；改設定也在這裡確認替換得進去
const previewOf = async ($: EngineInterface, s: Suggestion): Promise<string[]> => {
  const c = s.change
  if ('deleteSkill' in c) return [`- 移到垃圾桶：${c.file}`]
  if ('fullText' in c) return c.fullText.split('\n').map((l: string) => `+ ${l}`)
  const path = absolute(c.file, await homeDir($))
  const before = await readText($, path)
  const after = applyChange(before, c.oldText, c.newText)
  if (!after.ok) return [`（原文${after.reason === 'missing' ? '找不到' : '出現不只一次'}，不會改）`]
  return diffLines(before ?? '', after.text)
}

const applySuggestion = async ($: EngineInterface, s: Suggestion, isPreviewed: boolean): Promise<string | null> => {
  const h = await homeDir($)
  const c = s.change
  if ('deleteSkill' in c) {
    const dir = absolute(c.file, h).replace(/\/SKILL\.md$/, '')
    const trash = trashDir(await sh($, 'uname -s'), h)
    if (!trash || !dir.startsWith(`${h}/.claude/skills/`)) return 'fill'
    await sh($, `mkdir -p "${trash}" && mv "${dir}" "${trash}/" 2>/dev/null; echo done`)
    return null
  }
  if ('fullText' in c) {
    const path = absolute(c.file, h)
    if (!isWritableMarkdown(path, h, project) || (await readText($, path)) !== undefined) return 'fill'
    await $.fs.write(path, c.fullText)
    return null
  }
  const path = absolute(c.file, h)
  const current = await readText($, path)
  const isSettings = isSettingsFile(path, h, project)
  if (!isSettings && !isWritableMarkdown(path, h, project)) return 'fill'
  if (isSettings && (current === undefined || c.oldText === '')) return 'fill'
  const next = applyChange(current, c.oldText, c.newText)
  if (!next.ok) return `原文${next.reason === 'missing' ? '找不到' : '出現不只一次'}，沒有改`
  if (isSettings && current !== undefined) {
    if (!isPreviewed) return '改設定前要先按「預覽改動」'
    await $.fs.write(backupName(path, new Date()), current)
    await $.fs.write(path, next.text)
    if (!isValidJson(next.text)) {
      await $.fs.write(path, current)
      return '改完不是合法 JSON，已還原'
    }
    return null
  }
  await $.fs.write(path, next.text)
  return null
}

const markDone = async ($: EngineInterface, s: Suggestion, how: 'applied' | 'skipped') => {
  await update($, review, r => (r ? { ...r, done: { ...r.done, [s.id]: how } } : r))
}

const showPreview = async ($: EngineInterface, s: Suggestion) => {
  const lines = await previewOf($, s)
  await update($, review, r => (r ? { ...r, previews: { ...r.previews, [s.id]: lines } } : r))
}

// ── Notion 同步 ──
// 資料庫網址：環境變數 FUPAN_NOTION_DB，或 /fupan notion <網址> 存在 ~/.claude/retro/notion.json
type Notion = NotionConfig & { server: string }
let notion: Notion | null | undefined
let syncQueue: Promise<unknown> = Promise.resolve()

const notionPath = async ($: EngineInterface) => `${await retroDir($)}/notion.json`

const callNotion = async ($: EngineInterface, servers: readonly string[], tool: string, args: Record<string, unknown>) => {
  for (const server of servers) {
    try {
      const r = await $.mcp.call(server, tool, args)
      if (!r.isError) return { server, content: r.content as { type: string; text?: string }[] }
    } catch {
      // 這個名稱沒連上，試下一個
    }
  }
  return null
}

// 找出資料庫的 data source 與 view；結果存檔，下次不用再問
const loadNotion = async ($: EngineInterface, given?: string): Promise<Notion | null> => {
  if (notion !== undefined && !given) return notion
  const savedText = await readText($, await notionPath($))
  let saved: Partial<Notion> = {}
  try {
    saved = savedText ? (JSON.parse(savedText) as Partial<Notion>) : {}
  } catch {
    saved = {}
  }
  const database = given || (await sh($, 'printf %s "${FUPAN_NOTION_DB:-}"')) || saved.database
  if (!database) return (notion = null)
  if (saved.database === database && saved.dataSourceId && saved.viewUrl && saved.server) return (notion = saved as Notion)
  const r = await callNotion($, SERVERS, 'notion-fetch', { id: database })
  const block = r?.content.find(c => c.type === 'text')?.text ?? ''
  const cfg = r ? parseDatabase(database, block) : null
  if (!r || !cfg) return (notion = null)
  notion = { ...cfg, server: r.server }
  await writeJson($, await notionPath($), notion)
  return notion
}

// 拉：把 Notion 上的事件合併進本機帳本
const pull = async ($: EngineInterface, cfg: Notion): Promise<number | null> => {
  const events: Event[] = []
  let cursor: string | null = null
  for (let page = 0; page < 50; page++) {
    const data: Record<string, unknown> = { mode: 'view', view_url: cfg.viewUrl, page_size: 100 }
    if (cursor) data.start_cursor = cursor
    const r = await callNotion($, [cfg.server], 'notion-query-data-sources', { data })
    if (!r) return null
    const { rows, next } = parsePage(resultJson(r.content))
    events.push(...rows.map(fromNotion).filter((e): e is Event => e !== null))
    if (!next) break
    cursor = next
  }
  await updateLedger($, l => mergeEvents(l, events))
  return events.length
}

// 推：把還沒上 Notion 的事件建成新的列
const pushNow = async ($: EngineInterface, cfg: Notion): Promise<number> => {
  const ledger = await loadLedger($)
  const waiting = ledger.events.filter(e => ledger.unsynced.includes(e.id))
  let pushed = 0
  for (let i = 0; i < waiting.length; i += PUSH_BATCH) {
    const batch = waiting.slice(i, i + PUSH_BATCH)
    const r = await callNotion($, [cfg.server], 'notion-create-pages', {
      parent: { data_source_id: cfg.dataSourceId },
      pages: batch.map(e => ({ properties: toNotion(e) })),
      allow_async: false,
    })
    if (!r) break // 推不上去就留著，下次再補
    await updateLedger($, l => markSynced(l, batch.map(e => e.id)))
    pushed += batch.length
  }
  return pushed
}

// 同步一次只跑一個；沒設定 Notion 就什麼都不做
const queueSync = <T,>(job: () => Promise<T>): Promise<T> => {
  const run = syncQueue.then(job)
  syncQueue = run.catch(() => undefined)
  return run
}

const push = ($: EngineInterface) =>
  queueSync(async () => {
    const cfg = await loadNotion($)
    return cfg ? pushNow($, cfg) : 0
  }).catch(() => 0)

type SyncResult = { status: 'off' } | { status: 'failed' } | { status: 'ok'; pulled: number; pushed: number }

const sync = ($: EngineInterface, given?: string): Promise<SyncResult> =>
  queueSync(async (): Promise<SyncResult> => {
    const cfg = await loadNotion($, given)
    if (!cfg) return given ? { status: 'failed' } : { status: 'off' }
    const pulled = await pull($, cfg)
    if (pulled === null) return { status: 'failed' }
    return { status: 'ok', pulled, pushed: await pushNow($, cfg) }
  }).catch((): SyncResult => ({ status: 'failed' }))

const syncText = (r: SyncResult): string =>
  r.status === 'off'
    ? '還沒設定 Notion。用 /fupan notion <復盤帳本資料庫的網址> 設定，或設環境變數 FUPAN_NOTION_DB。'
    : r.status === 'failed'
      ? '連不上 Notion 的「復盤帳本」：確認 Notion 連接器有連上、網址正確。事件先存在本機，下次再補推。'
      : `已同步：Notion 上有 ${r.pulled} 個事件，推上 ${r.pushed} 個新事件。`

// ── 恢復 ──
// 雲端容器每次都是新的：開對話時同步完 Notion，把已套用的規則補回 ~/.claude/CLAUDE.md。
// 本機的檔案本來就在，而且你可能手動改過，不補。
let restoring: Promise<string | null> = Promise.resolve(null)

const restore = async ($: EngineInterface): Promise<string | null> => {
  if ((await sourceOf($)) !== '雲端') return null
  const h = await homeDir($)
  const path = `${h}/.claude/CLAUDE.md`
  const next = restoreText(await readText($, path), restorable(await loadLedger($), h))
  if (next === null) return null
  await $.fs.write(path, next)
  // 引擎可能已經讀過 CLAUDE.md：請它重問 prompt.context，下一輪就帶上補回的內容
  $.ui.invalidate('prompt.context')
  return next
}

// 套用／略過後回寫帳本；套用的條目記下寫在哪個檔案
const finish = async ($: EngineInterface, s: Suggestion, how: 'applied' | 'skipped', file?: string) => {
  // 套用記下寫進去的文字：雲端換了容器時，靠它把規則補回 CLAUDE.md
  const text = 'newText' in s.change ? s.change.newText.trim() : ''
  const m = { sessionId: snapshotId, project, source: await sourceOf($), text }
  await updateLedger($, l => (how === 'applied' ? markApplied(l, s.evidence.entryId, file ?? '', m) : markSkipped(l, s.evidence.entryId, m)))
  await markDone($, s, how)
  void push($)
}

const act = async ($: EngineInterface, s: Suggestion, isPreviewed: boolean): Promise<string> => {
  const problem = await applySuggestion($, s, isPreviewed)
  let message: string
  if (problem === 'fill') {
    // 做不到的：把完整指令填進輸入框，讓人看過再按 Enter 交給 Claude
    await $.prompt.fill({ text: `請幫我處理復盤建議「${s.title}」：${JSON.stringify(s.change)}`, mode: 'insert' })
    message = `「${s.title}」不能直接改，已把指令填進輸入框，看過再按 Enter。`
  } else if (problem) {
    message = `「${s.title}」：${problem}`
  } else {
    await finish($, s, 'applied', s.change.file)
    message = `已套用「${s.title}」（${s.change.file}）。`
  }
  await update($, review, r => (r ? { ...r, note: message } : r))
  return message
}

// 用選的（Claude 自己的提問對話框，App 也看得到）：先三個選項，預覽後只剩套用或略過
const decide = async ($: EngineInterface, s: Suggestion, i: number, total: number): Promise<string> => {
  const head = questionHead(s, i, total)
  let choice = await $.ui.ask(`${head}\n\n要怎麼處理？`, { header: '復盤', options: firstChoices(s.kind) })
  let isPreviewed = false
  if (choice === PREVIEW) {
    await showPreview($, s)
    isPreviewed = true
    const lines = (await read($, review))?.previews[s.id] ?? []
    choice = await $.ui.ask(previewQuestion(head, lines), { header: '復盤', options: afterPreviewChoices() })
  }
  if (choice === APPLY) return act($, s, isPreviewed)
  if (choice === SKIP) {
    await finish($, s, 'skipped')
    return `已略過「${s.title}」。`
  }
  return `「${s.title}」先保留（你的回覆：${choice}）。`
}

const decideAll = async ($: EngineInterface, r: Review): Promise<string> => {
  const open = r.suggestions.filter(s => !r.done[s.id])
  const results: string[] = []
  for (const [k, s] of open.entries()) {
    try {
      results.push(await decide($, s, k + 1, open.length))
    } catch {
      // 關掉對話框，或這裡不能問：剩下的留著，用文字指令處理
      results.push('（停在這裡，剩下的可以用 /fupan 套用 N、/fupan 略過 N 處理）')
      return [...results, '', formatReview((await read($, review)) ?? r)].join('\n')
    }
  }
  return results.join('\n')
}

// 回答結束後，把排隊的提醒一則一則用對話框問；打不開的退回回答最後的通知
const askQueued = async ($: EngineInterface) => {
  if (isAsking) return
  isAsking = true
  try {
    while (notices.length > 0) {
      const n = notices[0]!
      notices = notices.slice(1)
      const { question, options } = dialogFor(n)
      let answer: string
      try {
        answer = await $.ui.ask(question, { header: '復盤', options })
      } catch {
        answerNotices = enqueue(answerNotices, n)
        continue
      }
      if (n.kind === 'previous') await withSnapshotStatus($, n.snapshotId, 'asked')
      await react($, n, answer)
    }
  } finally {
    isAsking = false
  }
}

const react = async ($: EngineInterface, n: Notice, answer: string) => {
  const reaction = reactionFor(n, answer)
  if (reaction === 'later') return
  if (n.kind === 'previous' && reaction === 'dismiss-previous') {
    await withSnapshotStatus($, n.snapshotId, 'dismissed')
    return
  }
  const source = n.kind === 'previous' ? await loadSnapshot($, n.snapshotId) : 'fork'
  if (!source) return
  const r = await runReview($, source)
  const summary = r.suggestions.length === 0 ? formatReview(r) : await decideAll($, r)
  await $.ui.ask(`復盤完成：\n${summary}`, { header: '復盤', options: DONE_OPTIONS }).catch(() => undefined)
}

const askAbout = async ($: EngineInterface, snap: Pick<Snapshot, 'sessionId' | 'turns' | 'corrections'>) => {
  if (await hasSurface($)) {
    await update($, band, () => ({ snapshotId: snap.sessionId, turns: snap.turns, corrections: snap.corrections }))
  } else {
    notices = enqueue(notices, previousNotice(snap.sessionId, snap.turns, snap.corrections))
  }
}

const loadSnapshots = async ($: EngineInterface): Promise<Snapshot[]> => {
  const files = await $.fs.list(`${await retroDir($)}/sessions`).catch(() => [])
  const snaps: Snapshot[] = []
  for (const f of files) {
    const snap = await loadSnapshot($, f.name.replace(/\.json$/, ''))
    if (snap) snaps.push(snap)
  }
  return snaps
}

const dismissBand = async ($: EngineInterface, b: Band) => {
  await withSnapshotStatus($, b.snapshotId, 'dismissed')
  await update($, band, () => null)
}

const startBandReview = async ($: EngineInterface, b: Band) => {
  await update($, band, () => null)
  const snap = await loadSnapshot($, b.snapshotId)
  if (snap) await runReview($, snap)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    project = e.cwd
    await syncSession($)
    restoring = sync($).then(() => restore($)).catch(() => null)
    await $.command.register({ name: 'fupan', description: '復盤這段對話：找出糾正，提議 CLAUDE.md／skill／設定的修改' })

    // 上一個沒復盤的對話：問一次
    const old = pendingAsk(await loadSnapshots($), snapshotId)
    if (old) await askAbout($, old)
    return next(e)
  })

  // 第一則訊息帶的 CLAUDE.md：等補回完成（最多 15 秒），內容跟檔案不一樣就換成檔案的
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    if ((await sourceOf($)) !== '雲端') return r
    await Promise.race([restoring, $.clock.sleep(15_000)])
    const files = r.instructionFiles ?? e.instructionFiles
    if (!files) return r // 上游改寫過 claudeMd，背後的檔案不明，不動
    const path = `${await homeDir($)}/.claude/CLAUDE.md`
    const content = await readText($, path)
    if (!content || files.find(f => f.path === path)?.content === content) return r
    return { ...r, instructionFiles: [{ path, kind: 'user', content }, ...files.filter(f => f.path !== path)] }
  })

  on('prompt.submit', async ($, e, next) => {
    await syncSession($)
    transcript.push(`用戶：${e.text}`)
    if (!isCandidate(e.text, e.origin)) return next(e)
    // 在背景跑，不拖慢送出
    void detect($, e.text).catch(() => undefined)
    // 排隊的通知交給這一輪的回答；上一個對話的通知送出後標成已問過
    const ctx = noticeContext(answerNotices)
    if (!ctx) return next(e)
    const sent = answerNotices
    answerNotices = []
    for (const n of sent) {
      if (n.kind === 'previous') await withSnapshotStatus($, n.snapshotId, 'asked')
    }
    return next({ ...e, context: [...(e.context ?? []), ctx] })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await syncSession($)
    if (done.text) transcript.push(`Claude：${done.text}`)
    await saveSnapshot($)
    // 回答結束後跳對話框（不等它，讓這一輪先結束）
    void askQueued($)
    return done
  })

  on('session.end', async ($, e, next) => {
    snapshotId = e.sessionId
    const snap = await saveSnapshot($)
    // /clear 之後沒有 session.start：下一個事件再對上新的 session
    snapshotId = ''
    transcript = []
    corrections = 0
    if (shouldAsk(snap)) await askAbout($, snap)
    return next(e)
  })

  on('command.run', { command: 'fupan' }, async ($, e) => {
    const args = parseFupanArgs(e.args)
    if (args.action === 'help') return { text: HELP }
    if (args.action === 'probe') {
      // 三種提示各發一次，看這個環境哪些看得到
      $.ui.toast('復盤測試：這是 toast')
      $.ui.log('復盤測試：這是 ui.log')
      $.ui.status('復盤測試：這是狀態列')
      const surfaces = await $.session.surfaces()
      return { text: `已發出 toast、ui.log、狀態列各一則（畫面：${surfaces.length ? surfaces.join('、') : '沒有'}）。看到哪幾則？` }
    }
    if (args.action === 'sync' || args.action === 'notion') {
      const r = await sync($, args.action === 'notion' ? args.url : undefined)
      // 雲端：同步完順便把已套用的規則補回 ~/.claude/CLAUDE.md
      const restored = r.status === 'ok' ? await restore($).catch(() => null) : null
      return { text: syncText(r) + (restored ? '\n已把套用過的規則補回 ~/.claude/CLAUDE.md。' : '') }
    }
    if (args.action === 'previous' || args.action === 'dismiss') {
      const old = latestUnreviewed(await loadSnapshots($), snapshotId)
      if (!old) return { text: '沒有還沒復盤的上一個對話。' }
      await update($, band, () => null)
      if (args.action === 'dismiss') {
        await withSnapshotStatus($, old.sessionId, 'dismissed')
        return { text: '好，上一個對話不復盤了。' }
      }
      const r = await runReview($, old)
      if (r.suggestions.length === 0) return { text: formatReview(r) }
      return { text: await decideAll($, r) }
    }
    if (args.action === 'run') {
      // $ 呼叫的時間不算進 hook 的預算，可以等復盤跑完再回覆（App 看不到面板，回覆一定看得到）
      const r = await runReview($, 'fork')
      if (r.suggestions.length === 0) return { text: formatReview(r) }
      return { text: await decideAll($, r) }
    }
    if (!('n' in args)) return { text: HELP }
    const r = await read($, review)
    const s = r?.suggestions[args.n - 1]
    if (!r || !s) return { text: `沒有第 ${args.n} 條建議。先跑 /fupan。` }
    if (r.done[s.id]) return { text: `第 ${args.n} 條已經${r.done[s.id] === 'applied' ? '套用' : '略過'}過了。` }
    if (args.action === 'preview') {
      await showPreview($, s)
      const lines = (await read($, review))?.previews[s.id] ?? []
      return { text: [`第 ${args.n} 條「${s.title}」的改動（${s.change.file}）：`, ...lines].join('\n') }
    }
    if (args.action === 'skip') {
      await finish($, s, 'skipped')
      return { text: `已略過「${s.title}」，帳本記下略過時的次數。` }
    }
    return { text: await act($, s, s.id in r.previews) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, band)
    if (!b) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>要不要復盤剛才的對話？（{b.turns} 輪，糾正 {b.corrections} 次）</Text>
        <Button key="review" label="復盤" onPress={() => startBandReview($, b)} />
        <Button key="no" label="不用" onPress={() => { void withSnapshotStatus($, b.snapshotId, 'dismissed'); return update($, band, () => null) }} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const r = await read($, review)
    if (!r) return <Box><Text dimColor>還沒有復盤結果。輸入 /fupan 開始。</Text></Box>
    return (
      <Box flexDirection="column">
        {r.note && <Text dimColor>{r.note}</Text>}
        {r.suggestions.length === 0 && <Text dimColor>沒有建議。</Text>}
        {r.suggestions.filter(s => !r.done[s.id]).map(s => (
          <Box key={s.id} flexDirection="column">
            <Text>{s.kind}：{s.title}</Text>
            <Text dimColor>證據：{s.evidence.count} 次「{s.evidence.quotes.at(-1) ?? ''}」</Text>
            {(r.previews[s.id] ?? []).map((line, i) => <Text key={String(i)} dimColor>{line}</Text>)}
            <Box>
              <Button key="preview" label="預覽改動" onPress={() => showPreview($, s)} />
              <Button key="apply" label="套用" onPress={() => { void act($, s, s.id in r.previews) }} />
              <Button key="skip" label="略過" onPress={() => finish($, s, 'skipped')} />
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
