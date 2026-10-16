import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Band, Review, Suggestion } from '../types'

import { countSkillUses, absolute, memoryPath } from './lib/context'
import { isWritableMarkdown, isSettingsFile, replaceOnce, isValidJson, backupName, trashDir, diffLines } from './lib/apply'
import { isCandidate, hasKeyword, parseJevProbability, parseVerdict, VERDICT_PROMPT, JEV_THRESHOLD } from './lib/detect'
import { addCorrection, dueEntries, markApplied, markSkipped, parseLedger, type Due, type Ledger } from './lib/ledger'
import { quote, redact, redactSettings } from './lib/redact'
import { clipTranscript, pendingAsk, shouldAsk, type Snapshot } from './lib/snapshot'
import { buildPrompt, parseSuggestions, type Context } from './lib/suggest'

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
  if (crossed) $.ui.toast(`復盤：「${rule}」已糾正 3 次，可以跑 /fupan`)
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
  await update($, review, () => ({ suggestions, previews: {}, note: text ? note : '模型沒有回覆，請再試一次。' }))
  void $.ui.open({ id: PANE, title: '復盤' })
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
  const before = (await readText($, path)) ?? ''
  const after = replaceOnce(before, c.oldText, c.newText)
  if (!after.ok) return [`（原文${after.reason === 'missing' ? '找不到' : '出現不只一次'}，不會改）`]
  return diffLines(before, after.text)
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
  if (current === undefined) return 'fill'
  const next = replaceOnce(current, c.oldText, c.newText)
  if (!next.ok) return `原文${next.reason === 'missing' ? '找不到' : '出現不只一次'}，沒有改`
  if (isSettingsFile(path, h, project)) {
    if (!isPreviewed) return '改設定前要先按「預覽改動」'
    await $.fs.write(backupName(path, new Date()), current)
    await $.fs.write(path, next.text)
    if (!isValidJson(next.text)) {
      await $.fs.write(path, current)
      return '改完不是合法 JSON，已還原'
    }
    return null
  }
  if (!isWritableMarkdown(path, h, project)) return 'fill'
  await $.fs.write(path, next.text)
  return null
}

const dropSuggestion = async ($: EngineInterface, s: Suggestion) => {
  await update($, review, r => (r ? { ...r, suggestions: r.suggestions.filter(x => x.id !== s.id) } : r))
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
  await dropSuggestion($, s)
}

const act = async ($: EngineInterface, s: Suggestion, isPreviewed: boolean) => {
  const problem = await applySuggestion($, s, isPreviewed)
  if (problem === 'fill') {
    // 做不到的：把完整指令填進輸入框，讓人看過再按 Enter 交給 Claude
    await $.prompt.fill({ text: `請幫我處理復盤建議「${s.title}」：${JSON.stringify(s.change)}`, mode: 'insert' })
    update($, review, r => (r ? { ...r, note: `「${s.title}」需要你自己確認，已填進輸入框。` } : r))
    return
  }
  if (problem) {
    await update($, review, r => (r ? { ...r, note: `「${s.title}」：${problem}` } : r))
    return
  }
  await finish($, s, 'applied', 'file' in s.change ? s.change.file : undefined)
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
    const dir = `${await retroDir($)}/sessions`
    const files = await $.fs.list(dir).catch(() => [])
    const snaps: Snapshot[] = []
    for (const f of files) {
      const snap = await loadSnapshot($, f.name.replace(/\.json$/, ''))
      if (snap) snaps.push(snap)
    }
    const old = pendingAsk(snaps, snapshotId)
    if (old) await update($, band, () => ({ snapshotId: old.sessionId, turns: old.turns, corrections: old.corrections }))
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    turns += 1
    transcript.push(`用戶：${e.text}`)
    if (isCandidate(e.text, e.origin)) {
      // 在背景跑，不拖慢送出
      void detect($, e.text).catch(() => undefined)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (done.text) transcript.push(`Claude：${done.text}`)
    await saveSnapshot($)
    return done
  })

  on('session.end', async ($, e, next) => {
    resumeId = e.resume.id
    const snap = await saveSnapshot($)
    if (shouldAsk(snap)) {
      await update($, band, () => ({ snapshotId: snap.sessionId, turns: snap.turns, corrections: snap.corrections }))
    }
    return next(e)
  })

  on('command.run', { command: 'fupan' }, async ($) => {
    void runReview($, 'fork')
    await $.ui.open({ id: PANE, title: '復盤' })
    return { text: '復盤中，結果在「復盤」面板。' }
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
        {r.suggestions.map(s => (
          <Box key={s.id} flexDirection="column">
            <Text>{s.kind}：{s.title}</Text>
            <Text dimColor>證據：{s.evidence.count} 次「{s.evidence.quotes.at(-1) ?? ''}」</Text>
            {(r.previews[s.id] ?? []).map((line, i) => <Text key={String(i)} dimColor>{line}</Text>)}
            <Box>
              <Button key="preview" label="預覽改動" onPress={() => showPreview($, s)} />
              <Button key="apply" label="套用" onPress={() => act($, s, s.id in r.previews)} />
              <Button key="skip" label="略過" onPress={() => finish($, s, 'skipped')} />
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
