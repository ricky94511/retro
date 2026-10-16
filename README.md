# fupan（復盤）

把你反覆糾正 Claude 的事，變成 CLAUDE.md 規則、skill 或設定的修改。

## 怎麼運作

- **自動（每句）**：你送出訊息時，背景判斷這是不是「習慣糾正」（不是只改這一次）。斜線指令與機器送的訊息不判斷。
  - 有裝 [JEV](../jev)：每句先問 JEV 是非題，信心 ≥ 0.6 才往下。
  - 沒裝 JEV：先用關鍵字篩（不要、別再、又、我說過、每次、never、always…）。
  - 通過後問一次 Haiku，對應到帳本的哪一條（或新增一條），改寫成一句規則。
  - 帳本在 `~/.claude/retro/ledger.json`。同一條累積到 3 次會提醒：終端機跳 toast；沒有畫面的雲端 session 在那一輪回答結束後跳提問對話框「「…」已經糾正 3 次了，要現在復盤嗎？〔復盤〕〔之後再說〕」。
- **對話結束後（會問你）**：每輪結束存快照到 `~/.claude/retro/sessions/`。對話結束或 `/clear` 後問一次要不要復盤（少於 5 輪且沒有糾正就不問）：終端機在輸入框上方顯示〔復盤〕〔不用〕；雲端 session 在下一輪回答結束後跳對話框〔復盤〕〔不用〕〔之後再說〕。之後想復盤也可以用 `/fupan 上一個`。
- **手動**：輸入 `/fupan` 復盤目前對話。

**產生建議與套用都要你觸發，不會自動改任何檔案。**

## 使用方式

1. 輸入 `/fupan`（或對話結束後按〔復盤〕）。模型會看這段對話與帳本，提出最多 5 條建議：加規則、新 skill、改 skill、刪 skill、改設定。
2. 跳出提問對話框，逐條問你怎麼處理（Claude App 也看得到）：

   ```
   復盤 1/2：【加規則】回覆的標題一律用繁體中文，不用英文標題
   證據：3 次，「我說過標題要用中文」
   檔案：~/.claude/CLAUDE.md

   要怎麼處理？    〔預覽改動〕〔套用〕〔略過〕
   ```

   改設定一定要先預覽，所以只有〔預覽改動〕〔略過〕。
3. 選〔預覽改動〕後，問題裡會附上前後差異（最多 30 行），只剩〔套用〕〔略過〕。
4. 全部問完，`/fupan` 回一行一行的結果，例如「已套用「…」（~/.claude/CLAUDE.md）」。帳本同步更新：套用的記下寫在哪個檔案，略過的記下略過時的次數。

關掉對話框就停在那一條，剩下的列成編號清單，之後用文字指令處理：

| 指令 | 做什麼 |
|---|---|
| `/fupan 上一個` | 復盤上一個還沒復盤的對話（用它的快照，交給 sonnet） |
| `/fupan 不用` | 上一個對話不復盤 |
| `/fupan 預覽 N` | 看第 N 條的前後差異 |
| `/fupan 套用 N` | 套用第 N 條（改設定要先預覽） |
| `/fupan 略過 N` | 略過第 N 條 |

`preview`／`apply`／`skip` 也可以。處理過的建議留在原位，編號不會變。

在終端機裡，建議也會出現在「復盤」面板，每條有〔預覽改動〕〔套用〕〔略過〕按鈕；Claude App 的雲端對話畫不出面板，以對話框為準。每次復盤的結果與面板是否畫出，記在 `~/.claude/retro/last-review.json`。

## 套用的限制

- 只會直接改：`~/.claude/CLAUDE.md`、專案 `CLAUDE.md`／`CLAUDE.local.md`／`.claude/CLAUDE.md`、`~/.claude/skills/**/*.md`。
- 要替換的原文必須在檔案裡只出現一次，否則不改；原文空白表示加在檔尾（CLAUDE.md 不存在就新建）。
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

- 雲端 session（claude.ai/code、Claude App）沒有接上畫面：已驗證 toast、ui.log、狀態列、面板都看不到，只有指令回覆和提問對話框看得到。所以外掛先看有沒有畫面，沒有就改用提問對話框與回答最後的通知；`/fupan 測試顯示` 可以檢查目前環境。
- 雲端的提醒在回答結束後才跳（偵測在背景跑，不拖慢送出）；偵測比回答慢時，會等到下一輪結束。對話框打不開時，才退回請 Claude 在下一次回答最後加一行（Claude 可能漏掉）。
- 帳本與快照只在本機（或容器）的 `~/.claude/retro/`，不會同步（第 2 階段會接 Notion）。
- 一般 claude.ai 聊天的個人偏好與 Skill 還沒做（第 3 階段）。
- 找 JEV 的方式：在 `CLAUDE_CODE_PLUGIN_DIRS` 與 `~/.claude` 底下找 `scripts/jev.py`，找不到就當沒裝。

## 開發

```bash
claude plugin validate .
claude plugin test .
```

型別檔 `types/index.d.ts` 宣告 `$.state` 的值；引擎載入外掛後會在 `.claude-plugin/types/` 產生 API 型別，`tsconfig.json` 會沿用。
