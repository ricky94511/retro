import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Band, Review, Suggestion } from '../types'

import { countSkillUses, absolute, memoryPath } from './lib/context'
import { isWritableMarkdown, isSettingsFile, applyChange, isValidJson, backupName, trashDir, diffLines } from './lib/apply'
import { isCandidate, hasKeyword, parseJevProbability, parseVerdict, VERDICT_PROMPT, JEV_THRESHOLD } from './lib/detect'
import { addCorrection, dueEntries, markApplied, markSkipped, parseLedger, type Due, type Ledger } from './lib/ledger'
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
let snapshotId = newId()
let resumeId: string | undefined
let transcript: string[] = []
let turns = 0
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
  return `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
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
      '--q', JSON.stringify({ q: { type: 'noul', instructions: '這句話是不是對以後的習慣糾正（只改這一次內容的不算）？' } }),
    ],
    { timeoutMs: 60_000 },
  )
  return exitCode === 0 ? parseJevProbability(stdout) : undefined
}

// 偵測：JEV 有裝就每句先問；沒裝先過關鍵字；過了再問 Haiku 是不是習慣糾正
const detect = async ($: EngineInterface, text: string) => {
  const p = await askJev($, text)
  if (p === undefined ? !hasKeyword(text) : p < JEV_THRESHOLD) return
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
  const { ledger: next, crossed } = addCorrection(
    ledger,
    {
      entryId: known ? verdict.entryId ?? undefined : undefined,
      rule,
      quote: quote(text),
      sessionId: snapshotId,
      project,
      at,
      eventId: `ev_${at.toString(36)}_${seq++}`,
    },
    newId,
  )
  await saveLedger($, next)
  corrections += 1
  if (crossed) {
    const entry = next.entries.find(e => e.count === 3 && (known ? e.id === verdict.entryId : e.rule === rule))
    await notify($, thresholdNotice(entry?.id ?? rule, entry?.rule ?? rule))
  }
}

// 每輪結束存一份；保留已復盤、已略過的狀態
const saveSnapshot = async ($: EngineInterface) => {
  const status = (await loadSnapshot($, snapshotId))?.status ?? 'open'
  const snap: Snapshot = {
    sessionId: snapshotId,
    project,
    turns,
    corrections,
    transcript: clipTranscript(transcript.join('\n\n')),
    resume: { id: resumeId ?? snapshotId },
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

// 套用／略過後回寫帳本；套用的條目記下寫在哪個檔案
const finish = async ($: EngineInterface, s: Suggestion, how: 'applied' | 'skipped', file?: string) => {
  const ledger = await loadLedger($)
  const next = how === 'applied'
    ? markApplied(ledger, s.evidence.entryId, file ?? '', s.evidence.quotes.at(-1) ?? null)
    : markSkipped(ledger, s.evidence.entryId)
  await saveLedger($, next)
  await markDone($, s, how)
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
    snapshotId = newId()
    resumeId = undefined
    transcript = []
    turns = 0
    corrections = 0
    await $.command.register({ name: 'fupan', description: '復盤這段對話：找出糾正，提議 CLAUDE.md／skill／設定的修改' })

    // 上一個沒復盤的對話：問一次
    const old = pendingAsk(await loadSnapshots($), snapshotId)
    if (old) await askAbout($, old)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    turns += 1
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
    if (done.text) transcript.push(`Claude：${done.text}`)
    await saveSnapshot($)
    // 回答結束後跳對話框（不等它，讓這一輪先結束）
    void askQueued($)
    return done
  })

  on('session.end', async ($, e, next) => {
    resumeId = e.resume.id
    const snap = await saveSnapshot($)
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
