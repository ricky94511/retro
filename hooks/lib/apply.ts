// 套用：只能改 CLAUDE.md、skills 裡的 .md 與設定檔；要替換的原文必須只出現一次

export const CLAUDE_NAMES = ['CLAUDE.md', 'CLAUDE.local.md']

// 白名單：~/.claude/CLAUDE.md、專案 CLAUDE.md、CLAUDE.local.md、.claude/CLAUDE.md、~/.claude/skills/**/*.md
export const isWritableMarkdown = (path: string, home: string, project: string): boolean => {
  const inside = (dir: string) => path.startsWith(`${dir}/`)
  const isClaude = CLAUDE_NAMES.some(n => path === `${home}/.claude/${n}` || path === `${project}/${n}` || path === `${project}/.claude/${n}`)
  const isSkill = inside(`${home}/.claude/skills`) && path.endsWith('.md') && !path.includes('/../')
  return isClaude || isSkill
}

export const isSettingsFile = (path: string, home: string, project: string): boolean =>
  [`${home}/.claude/settings.json`, `${project}/.claude/settings.json`, `${project}/.claude/settings.local.json`].includes(path)

export type Replaced = { ok: true; text: string } | { ok: false; reason: 'missing' | 'ambiguous' }

// 原文必須只出現一次才替換
export const replaceOnce = (text: string, oldText: string, newText: string): Replaced => {
  if (oldText.length === 0) return { ok: false, reason: 'missing' }
  const first = text.indexOf(oldText)
  if (first === -1) return { ok: false, reason: 'missing' }
  if (text.indexOf(oldText, first + oldText.length) !== -1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, text: text.slice(0, first) + newText + text.slice(first + oldText.length) }
}

// 設定檔改完必須是合法 JSON，否則還原
export const isValidJson = (text: string): boolean => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

// 備份檔名：settings.json.bak-<時間>
export const backupName = (path: string, now: Date): string => {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return `${path}.bak-${stamp}`
}

// 垃圾桶：Mac 用系統垃圾桶，其他環境用 ~/.claude/retro/trash/
export const trashDir = (platform: string, home: string): string | null =>
  platform === 'darwin' ? `${home}/.Trash` : `${home}/.claude/retro/trash`

// 預覽：前後差異（逐行）
export const diffLines = (before: string, after: string): string[] => {
  const a = before.split('\n')
  const b = after.split('\n')
  const out: string[] = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue
    if (a[i] !== undefined) out.push(`- ${a[i]}`)
    if (b[i] !== undefined) out.push(`+ ${b[i]}`)
  }
  return out
}
