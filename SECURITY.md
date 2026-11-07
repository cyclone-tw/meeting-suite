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
| 不可信的逐字稿 | 內容一律包在標籤裡並聲明「是資料不是指令」；AI 改內容必須先給你預覽、勾選後才套用；輸出經結構驗證。Claude 以無工具模式執行；Codex 以唯讀沙箱並關閉跑指令、外掛、瀏覽器與網頁搜尋（查不到這版 Codex 的功能清單、或認不得跑指令的開關時，直接拒絕校對）。 |
| 頁面 | 不從 CDN 載入 script（第三方檔案放 `web/vendor/` 並記雜湊）；字幕工作室的 CSP 的 `script-src` 只有 `'self'`；影片網址上的 token 只在瀏覽器載入媒體的請求（`Sec-Fetch-Dest: video／audio`）上有效。 |
| 共用元件的完整性 | 字幕工作室會執行 `meeting-scribe` 的程式：送進瀏覽器的 `web/shared/*.js`，以及自己的 Node 行程載入的 `recap-files.js` 與叫起的 `deploy/build-pages.py`。發版時把它們的 SHA-256 釘在 `recording-transcriber/web/shared-pin.json`，使用前對照（Node 行程執行的是驗證過的那份內容），被改過或版本不合就拒絕。 |

## 已知限制與取捨

- **tagged 裝置**：Tailscale 的 tagged 裝置不帶使用者登入標頭，`tailscale_users` 管不到它們；而且沒帶身分標頭、`Host` 是 `127.0.0.1` 的請求會被當成本機直連而放行。需要擋 tagged 裝置時，請用 Tailscale ACL。
- **同一個使用者底下的 AI agent 讀得到你的檔案**：Claude（無工具）與 pi（`--no-tools`）完全沒有讀檔能力；Codex 已關閉跑指令工具。但 `cursor`（問答模式）與 `grok`（plan 模式）是唯讀、不是無工具，理論上能讀到同一個使用者的檔案（例如放在 `~/.config` 的金鑰檔）。金鑰讀取順序是環境變數、金鑰檔、鑰匙圈：在 macOS 上想避免檔案被讀到，就只放鑰匙圈、不要留金鑰檔；要處理很敏感的內容，優先選完全沒有工具的 claude 或 pi 當校對者。Codex 只關了上述工具，這版 Codex 還有哪些內建工具會隨版本變動，所以這不等於「讀不到檔案」，只是把最大的口關掉；真正的隔離需要作業系統層級（獨立使用者或沙箱），本專案的 Linux 部署就是用專用帳號 `scribe` 加 systemd 加固。
- **`/healthz`**：回傳主機名稱標籤、有沒有金鑰、有沒有 AI。網頁版（Cloudflare Pages）需要它來顯示主機狀態，所以不限本機；它已被上面的 Host 白名單與 `tailscale_users` 擋住（預設安裝會啟用 `tailscale_users`；若你設成空清單，tailnet 內每台裝置都看得到）。
- **`<video>` 與舊瀏覽器**：影片網址 token 要靠瀏覽器送 `Sec-Fetch-Dest`（Chrome 80+、Firefox 90+、Safari 16.4+）；更舊的瀏覽器播不了工作室的影片預覽。
- **共用元件釘選只在發版時產生**：你自己 clone 開發的版本沒有 `shared-pin.json`，兩個資料夾各自更新，不做檢查。
- **JavaScript 不加 ESLint**：專案刻意零 runtime 相依（Python 只用標準函式庫、字幕工作室的 HTTP server 零相依）。頁面測試會在同一個 vm 內依序載入所有 script，擋語法錯誤與重複宣告；Python 用 `ruff`（只開 pyflakes）在 CI 檢查。
- **大檔案**（`web/index.html` 單檔 SPA、`server.py` 的 handler）：影響維護、不影響安全。功能成長時再切分。

## English summary

Meeting transcripts are sensitive. Both servers bind to `127.0.0.1` only; remote use goes through `tailscale serve` (tailnet-only HTTPS), never Funnel. Every request first passes a **Host allowlist** (loopback, `*.ts.net`, plus `allowed_hosts` in the config) against DNS rebinding, and installs fill `tailscale_users` with the installer's own tailnet account so only that account's devices can use the app (set `"tailscale_users": []` to disable, or add accounts to widen). POST needs the `X-Meeting-Scribe` header, SSE connections and `/token` are rate-limited, and the Studio serves `shared/*.js` only if its SHA-256 matches the pin written at release time.

Known limits: tagged Tailscale devices carry no login header (use Tailscale ACLs); `cursor` and `grok` run read-only rather than tool-less, so for very sensitive content choose claude or pi (no tools at all) as the proofreader, since codex only has its shell, plugin, browser and web-search switches turned off; the shared-component pin exists only in releases; no ESLint (zero-dependency policy) but Python is linted with ruff. To report a vulnerability, open a GitHub issue that says only that you have a security matter, and we will arrange a private channel.
