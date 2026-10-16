import { expect, test } from 'claude-code/testing'
import { applyChange, backupName, diffLines, isValidJson, isWritableMarkdown, replaceOnce, trashDir } from '../hooks/lib/apply'

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

test('原文空白＝加在檔尾；檔案不存在就新建；有原文時照舊只換唯一一處', () => {
  expect(applyChange(undefined, '', '- 規則')).toEqual({ ok: true, text: '- 規則' })
  expect(applyChange('# 舊\n\n', '', '- 規則')).toEqual({ ok: true, text: '# 舊\n\n- 規則' })
  expect(applyChange(undefined, '舊', '新')).toEqual({ ok: false, reason: 'missing' })
  expect(applyChange('a 舊 b', '舊', '新')).toEqual({ ok: true, text: 'a 新 b' })
})

test('加在檔尾：去掉開頭多的換行；前後都是列點就接在下一行', () => {
  expect(applyChange('# 格式\n\n- 一\n', '', '\n- 二\n')).toEqual({ ok: true, text: '# 格式\n\n- 一\n- 二\n' })
  expect(applyChange('# 格式\n\n說明文字', '', '- 二')).toEqual({ ok: true, text: '# 格式\n\n說明文字\n\n- 二' })
})
