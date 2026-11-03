# 存到 Google Drive：由瀏覽器直接上傳

會議 App 預設把檔案寫進主機上 Google Drive 桌面版的資料夾（`drive_mode` 沒設就是 `local`，設定見根目錄 README）。主機上沒有 Google Drive 時（例如會議 App 放在 Linux 主機、網頁放 Cloudflare Pages、用手機開會），改用這份說明的 `browser` 模式：由瀏覽器登入 Google，直接把檔案傳到你的 Drive。

```text
瀏覽器
  ├─ 1. 跳出 Google 登入視窗，同意後拿到 1 小時有效的存取權杖（access token）
  ├─ 2. 向主機拿這場整理好的檔案
  └─ 3. 用權杖把檔案傳到 Google Drive（www.googleapis.com）
主機：只整理檔案內容，不碰 Google 帳號、不保存任何 Google 憑證、不寫任何 Drive 資料夾
```

- 權杖只放在這個分頁的記憶體與 sessionStorage（關掉分頁就沒了），不送到主機、不放 localStorage。
- 權限只要 `drive.file`：只看得到、改得到 Cyclone Scribe **自己建立的**資料夾和檔案，看不到你 Drive 裡的其他東西。

## 存在哪裡、存哪些檔

- 第一次存檔時在「我的雲端硬碟」建一個根資料夾，預設叫「會議紀錄（meeting-scribe）」（設定檔的 `drive_folder_name` 可以改）。之後可以改名、搬到「我的雲端硬碟」裡任何位置，都找得到；不要刪掉或搬進「共用雲端硬碟」，不然下次會再建一個新的。
- 每場會議一個資料夾「日期 時間 會議名稱」，同名加 (2)、(3)；時間用瀏覽器那台的當地時間。「設定」裡的「資料夾」可以再分子資料夾（例如 `114 上學期/IEP`）。
- 檔案：逐字稿、總結、會議紀錄、心智圖（.md、.svg、.opml）、表單 Word 檔、音檔，有產生的才存。

## 上傳失敗怎麼辦

- **權杖過期**（超過 1 小時，或很長的音檔傳到一半）：再按一次「存到 Drive」，登入視窗同意後從中斷的位置接著傳。
- **網路中斷**：自動等一下再問 Google 收到哪裡，從那裡接著傳；一直斷就停下來，再按一次會接著傳。
- **有幾個檔沒傳上去**：畫面列出是哪幾個、原因。再按一次只補傳沒成功的，用同一個資料夾。
- 全部傳完之前主機上的暫存不刪（保留 7 天）；換裝置後從「最近的會議」打開那場，再按「存到 Drive」接著存。
- 已經在 Drive 上的檔不會覆寫。

## 第一次用：允許彈出視窗

Google 登入在彈出視窗裡進行，被擋時畫面會說明：

- Chrome（電腦）：網址列右邊「已封鎖彈出式視窗」圖示 → 選「一律允許」→ 再按一次。
- iPhone Safari：設定 App →「Safari」→ 關掉「阻擋彈出式視窗」。請在 Safari 分頁裡開網頁，不要用「加入主畫面」的 App 模式。

## 在 Google 那邊要做的事（一次，約 20 分鐘）

Google Cloud Console 的選單可能是中文或英文，下面兩種都寫。

### 1. 建專案、啟用 Google Drive API

1. 打開 [Google Cloud Console](https://console.cloud.google.com/)，用你自己的 Google 帳號登入。
2. 上方「選取專案」→「新增專案」（New Project），名稱隨意，例如 `meeting-scribe`，建好後切換到它。
3. 「API 和服務」（APIs & Services）→「程式庫」（Library）→ 搜尋「Google Drive API」→「啟用」（Enable）。

### 2. OAuth 同意畫面（Google Auth Platform）

1. 「API 和服務」→「OAuth 同意畫面」，會帶到「Google 驗證平台」（Google Auth Platform）→「開始使用」（Get started）。
2. 應用程式名稱：例如 `Meeting Scribe`（登入視窗會顯示）；使用者支援電子郵件選自己。
3. 目標對象（Audience）：**外部**（External）。
4. 聯絡資訊填自己的信箱，同意政策 →「建立」。
5. 「品牌」（Branding）：應用程式首頁與隱私權政策填你自己的公開網址。可以用 `deploy/info-site/` 的範本（`deploy/deploy-info-site.sh` 部署到 Cloudflare Pages，改成你自己的內容）。**Logo 留空**：上傳 Logo 會觸發 Google 的品牌審核。
6. （建議）「資料存取權」（Data Access）→「新增或移除範圍」→ 只勾 `https://www.googleapis.com/auth/drive.file`。不要加完整的 `.../auth/drive`。
7. 「目標對象」→「發布應用程式」（Publish app），狀態變成「正式版」（In production）。停在「測試中」的話授權很快就過期。

只用 `drive.file`（非敏感權限）又沒有 Logo，不需要送 Google 驗證。

### 3. 建「網頁應用程式」用戶端

1. 「用戶端」（Clients）→「建立用戶端」（Create client）。
2. 應用程式類型：**網頁應用程式**（Web application），名稱隨意。
3. 已授權的 JavaScript 來源（Authorized JavaScript origins）：會議 App 網頁的網址，例如 `https://scribe.example.com`、`https://<主機>.<tailnet>.ts.net:9443`。
4. 已授權的重新導向 URI（Authorized redirect URIs）：每個網址都加一筆結尾 `/oauth/` 的（斜線要有），例如 `https://scribe.example.com/oauth/`。
5. 「建立」後只要「用戶端 ID」（長得像 `123456789012-xxxx.apps.googleusercontent.com`，是公開值）；用戶端密鑰用不到，不要貼到任何地方。

設定改完可能要等幾分鐘到幾小時才生效。

### 4. 學校或公司帳號（Google Workspace）登入被擋時

用戶端建在個人帳號底下，對學校或公司的 Workspace 來說是第三方 app。管理員限制過第三方 app 時，請管理員到 [管理控制台](https://admin.google.com/)：「安全性」→「存取權和資料控管」→「API 控制項」→「管理第三方應用程式存取權」→「設定新應用程式」→ 搜尋你的用戶端 ID → 存取權選「受信任」。

### 5. 把用戶端 ID 交給主機

在主機的 `~/.config/meeting-scribe/config.json` 加上：

```json
{
  "drive_mode": "browser",
  "google_client_id": "123456789012-xxxx.apps.googleusercontent.com"
}
```

- `drive_folder_name`：根資料夾的名字，可省略。
- 每個請求都重讀設定，改完不用重啟。
- browser 模式下主機不寫任何 Drive 資料夾，`drive_roots` 會被忽略。
- 網頁放 Cloudflare Pages 時，主機的 `cors_origins` 要列出 Pages 的網址，並重新部署網頁（`deploy/deploy-pages.sh`）。

## 驗收

1. 打開會議 App，錄一小段，按「存到 Drive」。
2. 登入視窗選要存的帳號 → 同意；視窗顯示「授權完成」後自己關掉。
3. 畫面顯示「已存到：Google Drive／會議紀錄（meeting-scribe）／…」，到 Drive 確認檔案都在。
