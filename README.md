# fupan（復盤）

把你反覆糾正 Claude 的事，變成 CLAUDE.md 規則、skill 或設定的修改。

## 怎麼運作

- **自動（每句）**：你送出訊息時，背景判斷這是不是「習慣糾正」（不是只改這一次）。斜線指令與機器送的訊息不判斷。
  - 有裝 [JEV](../jev)：每句先問 JEV 是非題，信心 ≥ 0.6 才往下。
  - 沒裝 JEV：先用關鍵字篩（不要、別再、又、我說過、每次、never、always…）。
  - 通過後問一次 Haiku，對應到帳本的哪一條（或新增一條），改寫成一句規則。
  - 帳本在 `~/.claude/retro/ledger.json`。同一條累積到 3 次，終端機跳提醒。
- **對話結束後（會問你）**：每輪結束存快照到 `~/.claude/retro/sessions/`。對話結束或 `/clear` 後，輸入框上方問「要不要復盤剛才的對話？」，有〔復盤〕〔不用〕。少於 5 輪且沒有糾正就不問。
- **手動**：輸入 `/fupan` 復盤目前對話。

**產生建議與套用都要你觸發。** 復盤最多提 5 條建議（加規則、新 skill、改 skill、刪 skill、改設定），在「復盤」面板逐條按〔預覽改動〕〔套用〕〔略過〕。

看不到面板時（例如 Claude App 的雲端對話），同樣的事用指令做，結果直接回在對話裡：

| 指令 | 做什麼 |
|---|---|
| `/fupan` | 復盤這段對話，列出編號的建議 |
| `/fupan 預覽 N` | 看第 N 條的前後差異（改設定一定要先預覽） |
| `/fupan 套用 N` | 套用第 N 條 |
| `/fupan 略過 N` | 略過第 N 條 |

`preview`／`apply`／`skip` 也可以。處理過的建議留在原位，編號不會變。每次復盤的結果與面板是否畫出，記在 `~/.claude/retro/last-review.json`。

## 套用的限制

- 只會直接改：`~/.claude/CLAUDE.md`、專案 `CLAUDE.md`／`CLAUDE.local.md`／`.claude/CLAUDE.md`、`~/.claude/skills/**/*.md`。
- 要替換的原文必須在檔案裡只出現一次，否則不改。
- 改設定（`settings.json`）：必須先按過〔預覽改動〕；改前備份成 `settings.json.bak-<時間>`；改完不是合法 JSON 就還原。送給模型的設定檔會把金鑰遮成 `***`。
- 刪 skill：Mac 移到系統垃圾桶，其他環境移到 `~/.claude/retro/trash/`。
- 做不到的（白名單外的檔案等）：把完整指令填進輸入框，你看過再按 Enter 交給 Claude。

## 安裝

**本機（Claude Code CLI）**：clone 這個 repo，開發或試用時：

```bash
export CLAUDE_CODE_PLUGIN_DIRS="$HOME/retro"
claude
```

或在 Claude Code 裡 `/plugin marketplace add ricky94511/retro` 再 `/plugin install fupan@retro`。

**雲端（claude.ai/code）**：在環境的 Setup script 裡 clone 這個 repo，並讓 session 載入它（參考上面的 `CLAUDE_CODE_PLUGIN_DIRS`）。雲端 session 的檔案在容器裡，容器結束就沒了，帳本也一樣。

**Cowork 上傳**：在 Mac 上執行 `bash scripts/pack.sh`，會產生 `~/Downloads/fupan.zip`（不含金鑰），再到 Cowork 上傳。

## 已知限制

- Claude App 的雲端對話裡，外掛的 toast 與 ui.log 看不到；面板也畫不出來（已驗證：`$.ui.open` 回 `no-surface: no surface is attached`），輸入框上方的按鈕應該也一樣。在 App 裡請用 `/fupan` 的文字指令；面板與按鈕只在終端機有（第 2 階段處理）。
- 帳本與快照只在本機（或容器）的 `~/.claude/retro/`，不會同步（第 2 階段會接 Notion）。
- 一般 claude.ai 聊天的個人偏好與 Skill 還沒做（第 3 階段）。
- 找 JEV 的方式：在 `CLAUDE_CODE_PLUGIN_DIRS` 與 `~/.claude` 底下找 `scripts/jev.py`，找不到就當沒裝。

## 開發

```bash
claude plugin validate .
claude plugin test .
```

型別檔 `types/index.d.ts` 宣告 `$.state` 的值；引擎載入外掛後會在 `.claude-plugin/types/` 產生 API 型別，`tsconfig.json` 會沿用。
