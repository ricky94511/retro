import { expect, test } from 'claude-code/testing'
import { buildPrompt, parseSuggestions } from '../hooks/lib/suggest'

const good = (id: string, kind = '改 skill') => ({
  id, kind, title: `建議 ${id}`, entryId: 'e1', count: 3, quotes: ['又來了'],
  change: { file: '/h/.claude/skills/x/SKILL.md', oldText: '舊', newText: '新' },
})

test('最多 5 條，格式不對的丟掉', () => {
  const raw = [good('s1'), good('s2'), { id: 'bad', kind: '亂來', title: 't', entryId: 'e', change: { file: 'f' } }, good('s3'), good('s4'), good('s5'), good('s6')]
  const out = parseSuggestions(`結果：${JSON.stringify(raw)}`)
  expect(out.length).toBe(5)
  expect(out.map(s => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5'])
})

test('刪 skill、新 skill 全文的格式也認', () => {
  const del = { id: 'd', kind: '刪 skill', title: '刪', entryId: 'e1', change: { file: '/h/.claude/skills/y/SKILL.md' } }
  const add = { id: 'n', kind: '新 skill', title: '新', entryId: 'e1', change: { file: '/h/.claude/skills/z/SKILL.md', fullText: '---' } }
  const out = parseSuggestions(JSON.stringify([del, add]))
  expect(out[0]!.change).toEqual({ file: '/h/.claude/skills/y/SKILL.md', deleteSkill: true })
  expect(out[1]!.change).toEqual({ file: '/h/.claude/skills/z/SKILL.md', fullText: '---' })
})

test('回覆不是 JSON 陣列 → 沒有建議', () => {
  expect(parseSuggestions('抱歉，沒有建議')).toEqual([])
  expect(parseSuggestions('[1, 2')).toEqual([])
})

test('提示詞帶帳本原話、CLAUDE.md、設定（已遮蔽）', () => {
  const p = buildPrompt({
    due: [{ entry: { id: 'e1', rule: '標題用繁中', count: 3, quotes: ['又用英文'], status: { kind: 'accumulating' } }, reason: 'new' }],
    claudeMd: [{ path: '/h/.claude/CLAUDE.md', text: '規則 A' }],
    memory: '',
    skills: [{ name: 'x', uses30: 2, path: '/h/.claude/skills/x/SKILL.md' }],
    settings: [{ path: '/h/.claude/settings.json', text: '{"token": "***"}' }],
  })
  expect(p).toContain('又用英文')
  expect(p).toContain('規則 A')
  expect(p).toContain('x：2 次')
  expect(p).toContain('"token": "***"')
})
