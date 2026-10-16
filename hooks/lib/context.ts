// 收集建議需要的背景：skill 近 30 天用量（從對話紀錄的 Skill 工具呼叫算）

export const DAYS = 30

// 對話紀錄的 jsonl 文字 → 每個 skill 近 `days` 天的呼叫次數
export const countSkillUses = (jsonl: string, now: number, days = DAYS): Record<string, number> => {
  const since = now - days * 24 * 60 * 60 * 1000
  const counts: Record<string, number> = {}
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"Skill"')) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const r = row as { timestamp?: string; message?: { content?: unknown } }
    const at = r.timestamp ? Date.parse(r.timestamp) : NaN
    if (Number.isNaN(at) || at < since) continue
    const content = Array.isArray(r.message?.content) ? r.message.content : []
    for (const block of content as { type?: string; name?: string; input?: { skill?: unknown } }[]) {
      if (block.type !== 'tool_use' || block.name !== 'Skill') continue
      const name = block.input?.skill
      if (typeof name === 'string') counts[name] = (counts[name] ?? 0) + 1
    }
  }
  return counts
}

// 專案的 memory 資料夾名（Claude Code 把路徑的 / 換成 -）
export const memoryPath = (home: string, project: string): string =>
  `${home}/.claude/projects/${project.replace(/\//g, '-')}/memory/MEMORY.md`

// 把 ~ 換成家目錄，讓模型給的路徑也能對上白名單
export const absolute = (path: string, home: string): string =>
  path.startsWith('~/') ? `${home}/${path.slice(2)}` : path
