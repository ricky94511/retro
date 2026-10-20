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

1. 輸入 `/fupan`（或對話結束後按〔復盤〕）。模型會看這段對話與帳本，提出最多 5 條建議：加規則、新 skill、改 skill、刪 skill、改設定。建議依「結構優先」挑層級：能用 hook 擋下的先改設定，做法類的改 skill，要靠判斷的才加規則；已經有規則卻還一再被糾正的，優先改成 hook。
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
| `/fupan 同步` | 立刻跟 Notion 同步一次 |
| `/fupan notion <網址>` | 設定 Notion 的復盤帳本資料庫 |
| `/fupan 預覽 N` | 看第 N 條的前後差異 |
| `/fupan 套用 N` | 套用第 N 條（改設定要先預覽） |
| `/fupan 略過 N` | 略過第 N 條 |

`preview`／`apply`／`skip` 也可以。處理過的建議留在原位，編號不會變。

在終端機裡，建議也會出現在「復盤」面板，每條有〔預覽改動〕〔套用〕〔略過〕按鈕；Claude App 的雲端對話畫不出面板，以對話框為準。每次復盤的結果與面板是否畫出，記在 `~/.claude/retro/last-review.json`。

## 同步到 Notion（本機與雲端共用帳本）

帳本可以同步到你 Notion 裡的「復盤帳本」資料庫，本機與每個雲端 session 讀寫同一份，糾正次數一起累積。

- **怎麼連**：透過已經連上的 Notion 連接器，不需要另外的金鑰。連接器的名稱各環境不同（雲端叫 `Notion`、本機 CLI 叫 `claude.ai Notion`、桌面 app 是一串 ID），外掛會從目前連上的工具裡找有 `notion-fetch` 的那一個。連不上時，`/fupan 同步` 的回覆會附上真正的錯誤原因。
- **資料庫**：一列一個事件（糾正、套用、略過），欄位是 摘要、事件ID、類型、規則ID、規則、原話、專案、對話、來源（本機／雲端）、檔案、次數、時間。請不要改欄位名稱。
- **設定**（擇一）：
  - 在 Claude Code 裡執行 `/fupan notion <資料庫網址>`，會存到 `~/.claude/retro/notion.json`，同一台電腦之後都會用。
  - 雲端 session 每次都是新的容器：在 Setup script 寫入 `~/.claude/retro/notion.json`（見上方「安裝」的雲端段落）。
  - 也可以設環境變數 `FUPAN_NOTION_DB=<資料庫網址>`（要讓 Claude Code 讀得到，例如寫進 `~/.claude/settings.json` 的 `env`）。
- **什麼時候同步**：開對話時、以及每次復盤前，拉一次 Notion 的事件合併進來；每記一個新事件就在背景推上去。推不上去（沒連 Notion、離線）就先存在本機，下次再補推。`/fupan 同步` 可以立刻同步一次並看結果。
- **怎麼合併**：帳本只記事件，每個事件有自己的 ID；合併時依 ID 去重，再重算每條規則的次數與狀態，所以同一件事不會被算兩次。
- **雲端補回規則**：雲端容器每次都是新的，上次套用進 `~/.claude/CLAUDE.md` 的規則會跟著舊容器消失。所以雲端 session 開對話時，同步完 Notion 會把帳本裡「已套用到 `~/.claude/CLAUDE.md`」的規則補回檔尾（已經有的不重複補），並讓這個對話的第一則訊息就帶上補回後的 CLAUDE.md（最多等 15 秒）。補的文字是套用時記在「原話」欄的內容；舊的套用事件沒記，就用規則本身。本機不補，因為檔案本來就在，而且你可能手動改過。專案的 CLAUDE.md 與 skill 不補，請把專案的改動 commit 進 repo。
- **限制**：兩個地方可能同時把同一種糾正記成兩條不同的規則（還沒同步到對方時）。復盤時模型會看到兩條，可以建議合併，但不會自動合併。

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

**雲端（claude.ai/code）**：在雲端環境的 Setup script **最後面**加上這段（若前面已有設定 `CLAUDE_CODE_PLUGIN_DIRS` 的段落，要放在它之後）。Setup script 裡 export 的變數傳不到 Claude Code，所以寫進 `~/.claude/settings.json`；外掛放在 `/home/user/plugins/retro`，避免更新時蓋掉你正在開發的 repo：

```bash
if [ -d /home/user/plugins/retro/.git ]; then
  git -C /home/user/plugins/retro fetch -q --depth 1 origin main && git -C /home/user/plugins/retro reset -q --hard origin/main
else
  git clone -q --depth 1 https://github.com/ricky94511/retro /home/user/plugins/retro
fi

python3 - <<'EOF'
import json, pathlib
home = pathlib.Path.home()
p = home / ".claude/settings.json"
d = json.loads(p.read_text()) if p.exists() else {}
env = d.setdefault("env", {})
dirs = [x for x in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(":") if x]
if "/home/user/plugins/retro" not in dirs:
    dirs.append("/home/user/plugins/retro")
env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(dirs)
# Setup script 不一定每個 session 都重跑：開對話時先把 fupan 更新到最新版
cmd = "git -C /home/user/plugins/retro pull -q --ff-only origin main 2>/dev/null || true"
starts = d.setdefault("hooks", {}).setdefault("SessionStart", [])
if not any(h.get("command") == cmd for s in starts for h in s.get("hooks", [])):
    starts.append({"hooks": [{"type": "command", "command": cmd}]})
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(d, indent=2))
# 要同步到 Notion 才需要：換成你的「復盤帳本」資料庫網址
n = home / ".claude/retro/notion.json"
n.parent.mkdir(parents=True, exist_ok=True)
n.write_text(json.dumps({"database": "<復盤帳本資料庫的網址>"}))
EOF
```

雲端 session 的容器結束後，`~/.claude/retro/` 裡的帳本與快照也會消失；要跨 session 累積，請設定 Notion 同步。

**Cowork 上傳**：在 Mac 上執行 `bash scripts/pack.sh`，會產生 `~/Downloads/fupan.zip`（不含金鑰），再到 Cowork 上傳。

## 已知限制

- 雲端 session（claude.ai/code、Claude App）沒有接上畫面：已驗證 toast、ui.log、狀態列、面板都看不到，只有指令回覆和提問對話框看得到。所以外掛先看有沒有畫面，沒有就改用提問對話框與回答最後的通知；`/fupan 測試顯示` 可以檢查目前環境。
- 雲端的提醒在回答結束後才跳（偵測在背景跑，不拖慢送出）；偵測比回答慢時，會等到下一輪結束。對話框打不開時，才退回請 Claude 在下一次回答最後加一行（Claude 可能漏掉）。
- 對話快照只在本機（或容器）的 `~/.claude/retro/sessions/`，不會同步到 Notion。
- 一般 claude.ai 聊天的個人偏好與 Skill 還沒做（第 3 階段）。
- 找 JEV 的方式：在 `CLAUDE_CODE_PLUGIN_DIRS` 與 `~/.claude` 底下找 `scripts/jev.py`，找不到就當沒裝。

## 開發

```bash
claude plugin validate .
claude plugin test .
```

型別檔 `types/index.d.ts` 宣告 `$.state` 的值；引擎載入外掛後會在 `.claude-plugin/types/` 產生 API 型別，`tsconfig.json` 會沿用。
