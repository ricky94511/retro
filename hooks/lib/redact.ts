// 遮蔽：帳本、建議提示詞、設定檔內容送出前都要過這裡

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i
// 像金鑰的長字串：沒有空白、至少 32 字的英數與 _-
const KEY_LIKE = /\b[A-Za-z0-9_\-]{32,}\b/g
const ASSIGNED = /((?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z_]*\s*[:=]\s*)\S+/gi

export const MASK = '***'

// 文字裡的金鑰樣式換成 ***
export const redact = (text: string): string =>
  text.replace(ASSIGNED, `$1${MASK}`).replace(KEY_LIKE, MASK)

// 一句原話：遮蔽後截到 max 字
export const quote = (text: string, max = 200): string => {
  const clean = redact(text.trim())
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

// 設定檔：名稱像金鑰的值全換成 ***，像金鑰的字串也換
export const redactSettings = (value: unknown, key = ''): unknown => {
  if (Array.isArray(value)) return value.map(v => redactSettings(v, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactSettings(v, k)]),
    )
  }
  if (typeof value === 'string') {
    if (SECRET_NAME.test(key)) return MASK
    return redact(value)
  }
  return value
}
