import { expect, test } from 'claude-code/testing'
import { absolute, countSkillUses, memoryPath } from '../hooks/lib/context'

const NOW = Date.parse('2026-10-16T00:00:00Z')
const line = (ts: string, skill: string) =>
  JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } })

test('skill 用量：只算近 30 天的 Skill 工具呼叫', () => {
  const text = [
    line('2026-10-10T00:00:00Z', 'jev-judge'),
    line('2026-10-01T00:00:00Z', 'jev-judge'),
    line('2026-08-01T00:00:00Z', 'jev-judge'),
    line('2026-10-11T00:00:00Z', 'pdf'),
    '不是 json {',
  ].join('\n')
  expect(countSkillUses(text, NOW)).toEqual({ 'jev-judge': 2, pdf: 1 })
})

test('專案 memory 路徑：/ 換成 -', () => {
  expect(memoryPath('/home/u', '/home/u/proj')).toBe('/home/u/.claude/projects/-home-u-proj/memory/MEMORY.md')
})

test('~ 路徑換成家目錄', () => {
  expect(absolute('~/.claude/CLAUDE.md', '/home/u')).toBe('/home/u/.claude/CLAUDE.md')
  expect(absolute('/x/y', '/home/u')).toBe('/x/y')
})
