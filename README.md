# meeting-suite

繁體中文 | [English](README.en.md)

在自己的 Mac 上把會議與影片變成逐字稿、字幕、總結與心智圖。兩個工具：

| 資料夾 | 是什麼 | 怎麼用 |
| --- | --- | --- |
| `meeting-scribe/` | **Cyclone Scribe**：即時會議轉錄。瀏覽器錄音，邊講邊出字幕；AI 整理段落重點、即時摘要，會後產生總結、會議紀錄、心智圖 | 網頁（本機 `http://127.0.0.1:18095/`） |
| `recording-transcriber/` | **字幕工作室**：影片上字幕、剪輯、燒字幕、YouTube 說明欄與上傳；另有錄音轉錄 CLI | 網頁（本機 `http://127.0.0.1:8766/`）與指令 |

介面與文件是繁體中文，用詞照台灣習慣。兩個工具放在同一層：字幕工作室的會後總結、心智圖直接用旁邊 `meeting-scribe/` 的程式與畫面元件。

## 需求

| 項目 | 用途 | 必要 |
| --- | --- | --- |
| macOS 13 以上、Homebrew | 全部 | 是 |
| Node.js 24 以上、pnpm 11 | 字幕工作室與 CLI | 是 |
| Python 3.9 以上 | 會議轉錄 App（只用標準函式庫） | 是 |
| ffmpeg | 抽音、縮圖、波形、剪接、匯入錄音 | 是 |
| Claude Code（已登入，Pro 以上方案） | 校對、整理、總結、心智圖 | 是 |
| Soniox API 金鑰 | 雲端辨識（兩個工具的預設引擎） | 用 Soniox 時 |
| ffmpeg-full | 把字幕燒進影片（需要 libass） | 燒字幕時 |
| yt-dlp | 下載 YouTube 影片與字幕 | 用 YouTube 時 |
| mlx-whisper（Apple 晶片） | 本機辨識，聲音不出這台 | 選用 |
| Tailscale | 讓手機、其他電腦連到會議 App | 選用 |

## 安裝

```bash
brew install node pnpm python ffmpeg ffmpeg-full yt-dlp
curl -fsSL https://claude.ai/install.sh | bash      # 或 brew install --cask claude-code
claude                                              # 第一次會開瀏覽器登入，登入後輸入 /exit 離開
git clone https://github.com/cyclone-tw/meeting-suite.git ~/meeting-suite
cd ~/meeting-suite/recording-transcriber && pnpm install --frozen-lockfile
```

選用的本機辨識：

```bash
brew install pipx && pipx install mlx-whisper
```

## 金鑰與授權

金鑰不寫進 repo、不放進對話或 issue。

| 項目 | 去哪裡申請 | 放哪裡 |
| --- | --- | --- |
| Soniox | [console.soniox.com](https://console.soniox.com/) 建立 API key | `security add-generic-password -s soniox-api-key -a "$USER" -w`（會提示貼上；兩個工具都讀這一份）。也可以放 `~/.config/meeting-scribe/soniox.key`（權限 600）或環境變數 `SONIOX_API_KEY` |
| Claude Code | 上面的 `claude` 登入 | Claude Code 自己保管 |
| YouTube 上傳（選用） | 自己的 Google Cloud 專案建 OAuth 用戶端（電腦版應用程式），見下面「上傳 YouTube」 | macOS 鑰匙圈（在字幕工作室「設定」裡連結） |
| Groq（選用，雲端 Whisper 備援） | [console.groq.com](https://console.groq.com/) | 環境變數 `GROQ_API_KEY`，或鑰匙圈服務 `groq-api-key` |
| Apify（選用，抓沒有字幕的 YouTube） | [apify.com](https://apify.com/) | 環境變數 `APIFY_TOKEN` |

## 確認裝好了

```bash
cd ~/meeting-suite/recording-transcriber
node scripts/transcript-job.mjs ping        # 一行 JSON：ffmpeg、ffmpeg_full、mlx_whisper、claude、yt_dlp 是否可用
pnpm test
cd ../meeting-scribe && python3 -m unittest discover -s tests
```

## 使用

### 會議轉錄 App

```bash
cd ~/meeting-suite/meeting-scribe
python3 -I server.py          # 網址 http://127.0.0.1:18095/，Ctrl-C 停止
```

- 開始前在「新的會議」寫會議說明（例如「主持人開場，四位老師輪流分享，最後 Q&A」），AI 依它判斷誰在講、是主持還是分享。
- 名字、講者、專有名詞聽錯了，按時間軸上的「AI 修正」，用一句話說要改什麼，勾選後整場一起換。
- 會議結束後改了說明，「會議說明」→「依說明重整這場」用新的說明把整場重新整理一次。
- 開機自動啟動、手機也要連：`bash deploy/install-macmini.sh`（launchd 常駐，並用 `tailscale serve` 開只有自己 tailnet 連得到的 HTTPS 網址）。
- 會議暫存在 `~/.local/share/meeting-scribe/drafts/`，存到 Drive 後刪除，沒存的保留 7 天。

### 字幕工作室

```bash
cd ~/meeting-suite/recording-transcriber
pnpm run studio:start         # 在背景啟動，網址 http://127.0.0.1:8766/（關掉：pnpm run studio:stop）
pnpm run studio:app           # 選用：做一個 ~/Applications/字幕工作室.app，拖到 Dock 點一下就開
```

選影片 → 預覽剪頭尾 → 辨識與 AI 校對 → 編輯字幕、AI 剪輯建議、短影音 → 燒字幕或上傳 YouTube。只綁 127.0.0.1，每次啟動換一個 token。

### 上傳 YouTube（選用）

字幕工作室可以直接把影片、字幕和說明欄上傳到你的頻道。Google 規定上傳要用 OAuth 授權，不能只填 API key；用的是你自己的 Google Cloud 專案，repo 裡沒有任何人的帳號。第一次設定約 15 分鐘，完整步驟見 [`recording-transcriber/docs/youtube-setup.md`](recording-transcriber/docs/youtube-setup.md)：

1. [Google Cloud Console](https://console.cloud.google.com/) 建一個專案，啟用 **YouTube Data API v3**。
2. Google Auth Platform 設定同意畫面，目標對象選「外部」，再按「發布應用程式」改成正式版（停在測試中的話，授權 7 天就過期）。
3. 建立 OAuth 用戶端，類型選 **電腦版應用程式**，下載 `client_secret_….json`。
4. 字幕工作室「設定」→ 選這個 JSON 檔 →「連結 YouTube 頻道」，在瀏覽器授權。可以連好幾個頻道，各自設預設值（公開範圍、播放清單、分類…）。

之後在編輯畫面按「上傳 YouTube」：可以掛 CC 字幕或上傳燒好字幕的版本、帶入 AI 寫好的說明欄（章節時間已照剪輯換算）、排程公開；上傳中斷會接著傳。工作室只把 client secret 與頻道授權存進 macOS 鑰匙圈，不另存檔案；匯入後可以刪掉下載的 JSON。每個 Google Cloud 專案每天最多上傳 100 支影片。

### 存到 Google Drive（選用）

下面四種存法都存到你自己的帳號：

**會議 App：用 Google Drive 桌面版（建議）**

1. 安裝 [Google Drive 桌面版](https://www.google.com/drive/download/)並登入，Finder 側邊欄會出現 Google Drive；實際位置是 `~/Library/CloudStorage/GoogleDrive-<你的帳號>/我的雲端硬碟`（英文介面是 `My Drive`）。
2. 寫進 `~/.config/meeting-scribe/config.json`（可以列好幾個，例如個人與學校帳號）：

   ```json
   {
     "drive_roots": {
       "mine": { "label": "我的 Drive", "path": "~/Library/CloudStorage/GoogleDrive-you@example.com/我的雲端硬碟" }
     }
   }
   ```

   用 `deploy/install-macmini.sh` 安裝常駐服務時，加上 `MEETING_SCRIBE_DRIVE_ACCOUNT=you@example.com` 會自動寫好這一段（設定檔還不存在時才寫）。
3. 會議 App「設定」→「存到 Drive 的預設」選位置、資料夾（預設「會議紀錄」）、要不要一併存音檔。開完會按「存到 Drive」，每場一個資料夾「日期 時間 會議名稱」，裡面是逐字稿、總結、會議紀錄、心智圖（.md、.svg、.opml）、表單 Word 檔與音檔，有產生的才存。存好後主機上的暫存自動刪除。

**會議 App：網頁放在別台主機、用手機存**：主機上沒有 Google Drive 時，改由瀏覽器登入 Google、直接把檔案傳到 Drive（只申請 `drive.file`，看不到你 Drive 裡的其他檔案）。要自己建一個 Google OAuth 用戶端，步驟見 [`meeting-scribe/docs/drive-browser.md`](meeting-scribe/docs/drive-browser.md)。

**字幕工作室：會後總結自動存一份**：產生會後總結、心智圖、延伸結果時，在背景複製一份到 Drive 的「<資料夾>/<日期 時分 名稱>」。寫進 `~/.config/recording-transcriber/asr-profile.json`：

```json
{ "studio_drive": { "account_suffix": "@example.com", "folder": "我的雲端硬碟/會議紀錄", "label": "我的 Drive" } }
```

`account_suffix` 是 Google 帳號的結尾，用來在 `~/Library/CloudStorage` 裡找對的那個 Drive；`folder` 是那個 Drive 底下的資料夾（要先存在）。沒設就不存，畫面也不顯示 Drive 那一行。

**轉錄 CLI：歸檔**：`pnpm run archive <轉錄包> --dest <路徑>` 把轉錄包複製到 Drive（或 iCloud Drive），逐檔比對大小與 sha256 後才刪本機那份；目的地在 `asr-profile.json` 的 `archive`（`drive_mount`、`drive_prefix`、`icloud_prefix`），格式見 [`asr-profile.example.json`](recording-transcriber/config/asr-profile.example.json)。

### 指令

```bash
pnpm run transcript -- "錄音或影片" --engine mlx       # 本機 Whisper 轉錄成逐字稿包（SRT、VTT、Markdown）
pnpm run subtitle "影片.mp4" --burn                    # 一步上字幕並燒進影片
pnpm run speakers "影片.mp4" ~/Downloads/craig-….zip --name 帳號=名字   # 用 Discord 分軌標講者
```

### Discord 線上會議：用 Craig 錄分軌、標出講者

[Craig](https://craig.chat/) 是 Discord 的錄音機器人，每個人錄成一軌，字幕工作室靠這些分軌判斷每句是誰講的。

1. 到 [craig.chat](https://craig.chat/) 按「Add to Discord」，把 Craig 加進伺服器（需要傳訊息、連線、改暱稱權限）。
2. 進語音頻道，打 `/join` 開始錄；結束打 `/stop`。同時用 OBS 等錄下畫面與混音。
3. Craig 會私訊下載連結（沒收到就打 `/recordings`）。下載頁選「每人一軌」（multi-track）的格式，例如 AAC 或 FLAC，會得到 `craig-….zip`（裡面是 `info.txt` 與每人一個音檔）；放在「下載」或影片旁邊。免費版錄音保留 7 天、單次最長 6 小時。
4. 字幕工作室選這支錄影時，「有沒有 Discord 分軌」會自動找到錄音時間對得上的 zip；填好每個帳號在字幕上的名字就開始。字幕在換人講話時加「【名字】」，影片裡沒錄到的聲音（例如 OBS 沒收到某人麥克風）會從分軌補回來。

## 個人設定（不進 git）

| 檔案 | 放什麼 | 範例 |
| --- | --- | --- |
| `~/.config/recording-transcriber/asr-profile.json` | 錯字對照、詞彙筆記位置、會議 App 網址、iCloud 共用資料夾、遠端 Mac、Drive 存檔與歸檔位置。沒設的功能就關著 | [`recording-transcriber/config/asr-profile.example.json`](recording-transcriber/config/asr-profile.example.json) |
| `~/.config/meeting-scribe/config.json` | 會議 App 的「存到 Drive」根目錄（`drive_roots`）或瀏覽器存檔（`drive_mode`、`google_client_id`）、詞彙筆記（`vocabulary_files`）、擴充包（`packs`）、主機名稱（`host_label`）等 | 擴充包格式見 [`meeting-scribe/docs/packs.md`](meeting-scribe/docs/packs.md) |
| `~/.config/meeting-scribe/deploy.env` | 把會議 App 部署到別台主機時的主機與 Cloudflare 帳號（`deploy/deploy-all.sh` 讀） | 見 `meeting-scribe/deploy/deploy-all.sh` 開頭 |

## 授權與聲明

- 程式碼採 [MIT 授權](LICENSE)，© 2026 Cyclone，可以自由使用、修改與再散布。
- 「Cyclone Scribe」「字幕工作室」的名稱與 Cyclone 的龍頭像不在授權範圍內（見 [NOTICE](NOTICE)）。修改後再發布請改名、換圖示，不要讓人以為是 Cyclone 的官方版本。
- 程式是 Cyclone 和 AI 程式助理一起完成的。
- 資料與隱私：
  - 錄音、影片、逐字稿與會議暫存都放在你自己的電腦（或你自己部署的主機）；存到 Google Drive、iCloud、YouTube 都是你按下才做，存到你自己的帳號。
  - 會送到雲端服務的步驟：Soniox（辨識，預設）、Microsoft Azure Speech（選用辨識）、Anthropic Claude（經 Claude Code 校對與整理；Codex 是選用備援）、Groq 與 Apify（選用）、Google（YouTube 上傳、Drive）。用本機 mlx-whisper 時聲音不出這台，但 AI 整理仍會把文字送到 Claude。
  - 各服務如何處理資料以它們的條款為準；錄誰、存哪裡、送到哪個服務，由使用者自行判斷並負責。
- 以現況提供，不保證支援、不保證正確；AI 產出的內容請自行核對。
- 第三方套件、模型與服務各有自己的授權與條款，不在 MIT 範圍內，見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
