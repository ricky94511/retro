import { expect, test } from 'claude-code/testing'
import { addCorrection, emptyLedger, markApplied, markSkipped, type Ledger } from '../hooks/lib/ledger'
import { restorable, restoreText } from '../hooks/lib/restore'

let n = 0
const fix = (l: Ledger, rule: string) =>
  addCorrection(l, { rule, quote: 'q', sessionId: 's', project: '/p', at: ++n, eventId: `ev${n}` }, () => `r${++n}`).ledger
const idOf = (l: Ledger, rule: string) => l.entries.find(e => e.rule === rule)!.id

test('只補套用到 ~/.claude/CLAUDE.md 的規則；套用時記下的文字優先，舊事件用規則本身', () => {
  let l = emptyLedger()
  for (const r of ['回覆用繁中', '比對要涵蓋變體', '專案規則', '略過的', '還在累積']) l = fix(l, r)
  l = markApplied(l, idOf(l, '回覆用繁中'), '~/.claude/CLAUDE.md', { at: ++n, text: '- 回覆一律用繁體中文' })
  l = markApplied(l, idOf(l, '比對要涵蓋變體'), '/h/.claude/CLAUDE.md', { at: ++n })
  l = markApplied(l, idOf(l, '專案規則'), '/p/CLAUDE.md', { at: ++n, text: '- 專案的' })
  l = markSkipped(l, idOf(l, '略過的'), { at: ++n })
  expect(restorable(l, '/h').map(r => r.text)).toEqual(['- 回覆一律用繁體中文', '- 比對要涵蓋變體'])
})

test('套用後又略過：以最後的狀態為準，不補', () => {
  let l = fix(emptyLedger(), '規則')
  l = markApplied(l, idOf(l, '規則'), '~/.claude/CLAUDE.md', { at: ++n, text: '- 規則' })
  l = markSkipped(l, idOf(l, '規則'), { at: ++n })
  expect(restorable(l, '/h')).toEqual([])
})

test('檔案不存在就新建；已經有的不重複補；都有了不寫檔', () => {
  const rules = [{ entryId: 'a', text: '- 一' }, { entryId: 'b', text: '- 二' }]
  expect(restoreText(undefined, rules)).toBe('- 一\n- 二\n')
  expect(restoreText('# 我的規則\n\n- 一\n', rules)).toBe('# 我的規則\n\n- 一\n- 二\n')
  expect(restoreText('- 一\n- 二\n', rules)).toBeNull()
  expect(restoreText(undefined, [])).toBeNull()
})
