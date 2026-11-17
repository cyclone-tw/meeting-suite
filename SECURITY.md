# 安全說明 / Security notes

會議逐字稿屬於敏感資料，這份文件說明這個專案怎麼保護它、哪些是刻意的取捨，以及怎麼回報問題。
English summary at the bottom.

## 回報問題

請在 GitHub 的 [Issues](https://github.com/cyclone-tw/meeting-suite/issues) 回報；內容涉及尚未修正的漏洞細節時，請先開一個只寫「有安全問題要私下談」的 issue，我們會約私下管道。issue 與 PR 裡不要貼金鑰、token 或真實的逐字稿。

## 威脅模型

- 會議轉錄 App（`meeting-scribe`）和字幕工作室只綁 `127.0.0.1`。想從手機或別台電腦用，是經 `tailscale serve`（只有自己 tailnet 連得到的 HTTPS），不用 Funnel、不開公開網址。
- 要防的是：別的網頁借你的瀏覽器打本機服務（CSRF、DNS rebinding）、tailnet 上不該用的人或裝置、不可信的逐字稿內容誘導 AI 做壞事、金鑰外洩。
- 不防的是：已經在你電腦上以你的身分執行的惡意程式（它本來就讀得到你的檔案）。

## 現有的防護

| 項目 | 做法 |
| --- | --- |
| Host 白名單（擋 DNS rebinding） | 所有請求先檢查 `Host`：只放行 `127.0.0.1`／`localhost`／`[::1]`、`*.ts.net`，以及設定檔 `allowed_hosts` 列的名稱，其餘 403。字幕工作室更嚴，只認自己的 `127.0.0.1:埠`。 |
| tailnet 使用者白名單 | 設定檔 `tailscale_users`：經 `tailscale serve` 進來的請求要帶清單內的 `Tailscale-User-Login`（`tailscale serve` 會蓋掉用戶端自己送的同名標頭，已實測）。`deploy/install-*.sh` 安裝時，設定檔沒有這個欄位就填入**安裝者自己的 tailnet 帳號**；想放行別人就加進清單，想不限制就設成空清單 `[]`。 |
| CSRF | `POST` 要帶自訂標頭 `X-Meeting-Scribe: 1`；跨來源只放行設定檔 `cors_origins` 列的網址，不用 cookie。字幕工作室每次啟動產生隨機 token。 |
| 資源上限 | SSE 連線總數上限、等待還沒開始的會議最久 10 分鐘；`POST /token` 每分鐘上限。 |
| 金鑰 | Soniox 長期金鑰只在主機（環境變數、權限 600 的金鑰檔或鑰匙圈），預設的 server 模式下瀏覽器只拿 60 秒單次的臨時金鑰（client 模式則金鑰只留在你的裝置，主機不經手）；不傳給 AI agent（Soniox、Groq、Apify 的環境變數與設定檔路徑都會清掉）。 |
| 不可信的逐字稿 | 內容一律包在標籤裡並聲明「是資料不是指令」；AI 改內容必須先給你預覽、勾選後才套用；輸出經結構驗證。字幕工作室的 Ask AI 只回答、不改任何檔案：回答用 DOM 組畫面（不拼 HTML，連結只收 http／https），時間按鈕只收影片長度內的值，問題與回答不寫進 log。Claude 以無工具模式執行，只有使用者在 Ask AI 勾了「網路搜尋」或「查 wiki」的那幾題例外（#192）：網路搜尋只開 `WebSearch`、不開 `WebFetch`，所以不能被字幕誘導去打開任意網址；查 wiki 只掛工作室自己的轉接器（`scripts/wiki-mcp.mjs`），它呼叫使用者設定的 wiki 查詢工具，只開放唯讀的搜尋（query）與讀全文（get），參數分開傳、不經 shell，工具的寫入指令不開放；其他 MCP 一律不載入。取捨：開了搜尋時，搜尋關鍵字可能帶出字幕的片段，會送到搜尋服務（不是任意網站）；兩個同時勾時，字幕裡的誘導文字也可能讓 agent 把查到的 wiki 片段放進搜尋關鍵字。兩個開關預設都關、每題自己勾，只有 Claude 能用。Codex 以唯讀沙箱並關閉跑指令、外掛、瀏覽器與網頁搜尋（查不到這版 Codex 的功能清單、或認不得跑指令的開關時，直接拒絕校對）。 |
| 頁面 | 不從 CDN 載入 script（第三方檔案放 `web/vendor/` 並記雜湊）；字幕工作室的 CSP 的 `script-src` 只有 `'self'`；`frame-src` 只放行 `https://www.youtube-nocookie.com`（YouTube 連結專案的嵌入播放，用嵌入框的 postMessage 控制，不載入 YouTube 的外部程式）；影片網址上的 token 只在瀏覽器載入媒體的請求（`Sec-Fetch-Dest: video／audio`）上有效。 |
| 字幕工作室的影片庫 | 左欄列你用 Finder 對話框選的資料夾與影片檔：加入的 API 只收「資料夾或檔案」，路徑一律由 macOS 的選擇視窗取得，頁面不能指定路徑；移除只收清單裡已有的路徑。第一次用（還沒有清單檔）會先放入舊首頁原本就會掃的資料夾（影片、桌面、下載、iCloud 共用資料夾）；清單檔壞掉時當成空的、不重建，改清單前先把壞檔留一份 `library.json.broken`。資料夾往下最多掃 3 層、800 支，只讀檔名、大小與時間，不讀影片內容。清單存在狀態資料夾的 `library.json`（權限 600，只有路徑）。 |
| 共用元件的完整性 | 字幕工作室會執行 `meeting-scribe` 的程式：送進瀏覽器的 `web/shared/*.js`，以及自己的 Node 行程載入的 `recap-files.js` 與叫起的 `deploy/build-pages.py`。發版時把它們的 SHA-256 釘在 `recording-transcriber/web/shared-pin.json`，使用前對照（Node 行程執行的是驗證過的那份內容），被改過或版本不合就拒絕。 |
| 詞彙筆記與 wiki 工具 | 轉錄的詞彙筆記放在使用者自己的 wiki，透過設定檔 `wiki_cli` 指定的工具讀（`get --content -- <路徑>`）：工具名稱只收字母、數字、點、底線、連字號，路徑只收設定檔裡的相對 `.md` 路徑，參數分開傳、不經 shell，10 秒沒回應就放棄。讀到的內容存一份在 `~/Library/Caches/recording-transcriber/vocabulary/`（權限 600，裡面可能有人名），最多用 7 天。讀不到時只印是哪一篇、錯誤種類與工具給的錯誤代碼，不印筆記內容、也不照印工具的輸出。會寫 wiki 的只有 `vocab:harvest` 這支指令（要人自己下，要帶 `--agent`）：只寫設定檔指定的那一篇，交回讀取時的收據讓 wiki 判斷有沒有人改過，被拒就把稿件留在本機、不重送。 |

## 已知限制與取捨

- **tagged 裝置**：Tailscale 的 tagged 裝置不帶使用者登入標頭，`tailscale_users` 管不到它們；而且沒帶身分標頭、`Host` 是 `127.0.0.1` 的請求會被當成本機直連而放行。需要擋 tagged 裝置時，請用 Tailscale ACL。
- **同一個使用者底下的 AI agent 讀得到你的檔案**：Claude（無工具）與 pi（`--no-tools`）完全沒有讀檔能力；Codex 已關閉跑指令工具。但 `cursor`（問答模式）與 `grok`（plan 模式）是唯讀、不是無工具，理論上能讀到同一個使用者的檔案（例如放在 `~/.config` 的金鑰檔）。金鑰讀取順序是環境變數、金鑰檔、鑰匙圈：在 macOS 上想避免檔案被讀到，就只放鑰匙圈、不要留金鑰檔；要處理很敏感的內容，優先選完全沒有工具的 claude 或 pi 當校對者。Codex 只關了上述工具，這版 Codex 還有哪些內建工具會隨版本變動，所以這不等於「讀不到檔案」，只是把最大的口關掉；真正的隔離需要作業系統層級（獨立使用者或沙箱），本專案的 Linux 部署就是用專用帳號 `scribe` 加 systemd 加固。
- **`/healthz`**：回傳主機名稱標籤、有沒有金鑰、有沒有 AI。網頁版（Cloudflare Pages）需要它來顯示主機狀態，所以不限本機；它已被上面的 Host 白名單與 `tailscale_users` 擋住（預設安裝會啟用 `tailscale_users`；若你設成空清單，tailnet 內每台裝置都看得到）。
- **`<video>` 與舊瀏覽器**：影片網址 token 要靠瀏覽器送 `Sec-Fetch-Dest`（Chrome 80+、Firefox 90+、Safari 16.4+）；更舊的瀏覽器播不了工作室的影片預覽。
- **共用元件釘選只在發版時產生**：你自己 clone 開發的版本沒有 `shared-pin.json`，兩個資料夾各自更新，不做檢查。
- **JavaScript 不加 ESLint**：專案刻意零 runtime 相依（Python 只用標準函式庫、字幕工作室的 HTTP server 零相依）。頁面測試會在同一個 vm 內依序載入所有 script，擋語法錯誤與重複宣告；Python 用 `ruff`（只開 pyflakes）在 CI 檢查。
- **大檔案**（`web/index.html` 單檔 SPA、`server.py` 的 handler）：影響維護、不影響安全。功能成長時再切分。

## English summary

Meeting transcripts are sensitive. Both servers bind to `127.0.0.1` only; remote use goes through `tailscale serve` (tailnet-only HTTPS), never Funnel. Every request first passes a **Host allowlist** (loopback, `*.ts.net`, plus `allowed_hosts` in the config) against DNS rebinding, and installs fill `tailscale_users` with the installer's own tailnet account so only that account's devices can use the app (set `"tailscale_users": []` to disable, or add accounts to widen). POST needs the `X-Meeting-Scribe` header, SSE connections and `/token` are rate-limited, and the Studio serves `shared/*.js` only if its SHA-256 matches the pin written at release time. The Studio's library lists folders and files you pick in the Finder dialog (the page cannot name a path; the very first run pre-fills the folders the old home page already scanned — Movies, Desktop, Downloads, the iCloud shared folder — and a damaged list file is shown empty and backed up, never silently rebuilt), scans names, sizes and dates up to 3 levels and 800 videos, and keeps the list as paths in a 0600 `library.json`.

Known limits: tagged Tailscale devices carry no login header (use Tailscale ACLs); `cursor` and `grok` run read-only rather than tool-less, so for very sensitive content choose claude or pi (no tools at all) as the proofreader, since codex only has its shell, plugin, browser and web-search switches turned off; the shared-component pin exists only in releases; no ESLint (zero-dependency policy) but Python is linted with ruff. To report a vulnerability, open a GitHub issue that says only that you have a security matter, and we will arrange a private channel.
