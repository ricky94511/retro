import { expect, test } from 'claude-code/testing'
import { backupName, diffLines, isValidJson, isWritableMarkdown, replaceOnce, trashDir } from '../hooks/lib/apply'

const H = '/home/u'
const P = '/home/u/proj'

test('白名單：CLAUDE.md、skills 裡的 .md；其他一律不行', () => {
  expect(isWritableMarkdown(`${H}/.claude/CLAUDE.md`, H, P)).toBe(true)
  expect(isWritableMarkdown(`${P}/CLAUDE.local.md`, H, P)).toBe(true)
  expect(isWritableMarkdown(`${P}/.claude/CLAUDE.md`, H, P)).toBe(true)
  expect(isWritableMarkdown(`${H}/.claude/skills/x/SKILL.md`, H, P)).toBe(true)
  expect(isWritableMarkdown(`${H}/.ssh/config`, H, P)).toBe(false)
  expect(isWritableMarkdown(`${H}/.claude/skills/../../.bashrc`, H, P)).toBe(false)
  expect(isWritableMarkdown(`${H}/.claude/skills/x/run.sh`, H, P)).toBe(false)
})

test('原文只出現一次才替換；0 次或多次都不改', () => {
  expect(replaceOnce('a b c', 'b', 'B')).toEqual({ ok: true, text: 'a B c' })
  expect(replaceOnce('a b b', 'b', 'B')).toEqual({ ok: false, reason: 'ambiguous' })
  expect(replaceOnce('a', 'z', 'Z')).toEqual({ ok: false, reason: 'missing' })
})

test('設定改完必須是合法 JSON；備份檔名帶時間', () => {
  expect(isValidJson('{"a":1}')).toBe(true)
  expect(isValidJson('{"a":')).toBe(false)
  expect(backupName('/h/.claude/settings.json', new Date('2026-10-16T00:00:00Z'))).toBe(
    '/h/.claude/settings.json.bak-2026-10-16T00-00-00-000Z',
  )
})

test('垃圾桶：Mac 用系統垃圾桶，其他用 ~/.claude/retro/trash', () => {
  expect(trashDir('darwin', H)).toBe(`${H}/.Trash`)
  expect(trashDir('Linux', H)).toBe(`${H}/.claude/retro/trash`)
})

test('預覽差異只列改掉的行', () => {
  expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual(['- b', '+ B'])
})
