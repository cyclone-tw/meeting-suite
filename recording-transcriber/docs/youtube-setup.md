# 讓字幕工作室上傳到你的 YouTube 頻道

字幕工作室用你**自己的** Google Cloud 專案授權上傳，repo 裡沒有任何人的帳號或金鑰。fork 之後照這份做一次（約 15 分鐘），之後每支影片按「上傳 YouTube」就好。

Google Cloud 主控台的選單可能顯示中文或英文，下面兩種都寫。

## 1. 建專案、啟用 YouTube API

1. 打開 [Google Cloud Console](https://console.cloud.google.com/)，用要上傳的那個 Google 帳號登入（品牌頻道也是用擁有它的帳號）。
2. 上方的專案選單 →「新增專案」（New project），名稱隨意，例如 `subtitle-studio`。
3. 選單 →「API 和服務」（APIs & Services）→「程式庫」（Library），搜尋 **YouTube Data API v3**，按「啟用」（Enable）。

## 2. 設定 OAuth 同意畫面，並改成正式版

1. 選單 → **Google Auth Platform** →「品牌」（Branding）。看到「尚未設定」就按「開始」（Get Started）。
2. 應用程式名稱填 `Subtitle Studio`（自己看得懂就好），使用者支援電子郵件選自己。
3. 目標對象（Audience）選 **外部（External）**。
4. 聯絡資訊填自己的信箱，同意政策，按「建立」（Create）。
5. 到「目標對象」（Audience）按 **「發布應用程式」（Publish app）**，狀態變成「正式版」（In production）。

> **一定要做第 5 步。** 停在「測試中」（Testing）的話，Google 給的授權 7 天就會過期，每週都要重新連結一次。

不需要送 Google 驗證。自己用的時候，登入時會看到「Google 尚未驗證這個應用程式」，按「進階」→「前往 Subtitle Studio（不安全）」就好。未驗證的專案最多給 100 個不同帳號授權，個人或小團隊用不到。

## 3. 建立 OAuth 用戶端、下載 JSON

1. Google Auth Platform →「用戶端」（Clients）→「建立用戶端」（Create client）。
2. 應用程式類型選 **「電腦版應用程式」（Desktop app）**，名稱隨意。
   - 不要選「網頁應用程式」：工作室會拒絕這種 JSON。
3. 建立後按下載，存成 JSON 檔（檔名像 `client_secret_….json`）。

這個檔案裡有 client secret。電腦版應用程式的 secret 不算真正的機密（Google 的說法），但還是不要放進 git 或分享出去。

## 4. 在字幕工作室連結頻道

1. 打開字幕工作室，按右上角「設定」。
2. 按「選 OAuth 用戶端 JSON 檔…」，選剛剛下載的檔案。
3. 按「連結 YouTube 頻道」，瀏覽器會打開 Google 的授權頁：
   - 選帳號；有品牌頻道的話，選要上傳的那個頻道。
   - 看到未驗證的警告，照上面的方法繼續。
   - 允許「查看、編輯及永久刪除你的 YouTube 影片…」。上傳 CC 字幕需要這個權限。
4. 看到「連結好了」就可以關掉那個分頁，設定裡會出現頻道。

要連第二個頻道，就再按一次「連結」，選另一個帳號或品牌頻道。每個頻道可以按「預設值…」設定預先選好的選項：誰看得到、字幕方式、播放清單、分類、語言、標籤、兒童影片、通知訂閱者。

## 上傳

編輯畫面右上角按「上傳 YouTube」：

- **字幕**：
  - 「CC 字幕」是上傳不燒字幕的影片，再把字幕檔掛上去。觀眾可以開關，YouTube 也能用字幕幫影片被搜尋到。
  - 「燒在畫面上」是上傳燒好字幕的影片。預設也另外掛 CC 字幕，可以取消勾選。
  - 上傳時沒掛到 CC 字幕（取消勾選或失敗），之後再打開「上傳 YouTube」會看到「補上 CC 字幕」。
- **需要的影片沒有或過期**：會先自動輸出再上傳。例如剪輯改過、或燒好之後又改過字。
- **說明欄**：預先帶入「YouTube 說明欄」分頁的內容，章節時間已經照剪輯換算。
- **排程公開**：上傳時先是私人，到時間 YouTube 自動公開。
- **上傳中**：可以關掉視窗繼續改字。上傳中斷會從斷掉的地方接著傳。

## 額度與限制（官方文件，2026-10 查證）

- 上傳影片每天最多 100 次，每個 Google Cloud 專案分開計算。
- 掛 CC 字幕每次用 400 點，每天預設 10,000 點。
- 額度在美國太平洋時間午夜重置，大約是台灣下午 3、4 點。
- 未驗證的 API 專案上傳的影片，不會被限制成私人。

## 憑證放在哪裡、怎麼移除

- **client secret 和每個頻道的授權**：放在這台 Mac 的鑰匙圈，服務名稱 `cyclone-subtitle-studio-youtube`。
- **頻道清單與預設值**：放在 `~/.local/state/cyclone-subtitle-studio/youtube.json`，裡面沒有機密。
- **移除單一頻道**：「設定」→ 頻道的「移除」，會一併向 Google 取消授權。
- **全部移除**：「設定」→「全部移除」。
- **從 Google 那邊取消**：到 [Google 帳戶的第三方存取權](https://myaccount.google.com/connections)移除 Subtitle Studio。
- **兩台電腦**：各自連結一次，因為授權存在各自的鑰匙圈裡。可以用同一個 JSON 檔。

## 不開工作室，直接用指令上傳（#159）

做好的影片（例如 agent 剪好的 demo）不需要字幕時，可以不開網頁直接傳：

```bash
pnpm run youtube-upload ~/Movies/demo.mp4 --title "示範影片" --desc-file 說明.md
pnpm run youtube-upload --channels      # 列出已連結的頻道
```

- 頻道與授權沿用工作室「設定」裡連結的（同一把鑰匙圈），指令不改設定檔、不印 token。
- **預設私人、不通知訂閱者。** 要公開一定要明確寫 `--privacy public`（或 `unlisted`）；`--notify` 才通知訂閱者。
- 原檔直接上傳，不重新編碼，不帶字幕；要 CC 字幕、燒字幕或粗剪，用工作室。
- 其他選項：`--channel <id 或名稱>`、`--playlist <id>`、`--tags a,b`、`--category <id>`、`--language zh-TW`、`--kids`、`--json`（輸出給程式讀）。
- 出口碼：成功 0、上傳失敗 1、用法錯誤 2。

## 常見問題

| 看到的訊息 | 怎麼辦 |
| --- | --- |
| 「授權過期或被取消了」 | 「設定」→ 再按一次「連結」，選同一個頻道。如果每 7 天就發生，代表同意畫面還在「測試中」，回到第 2 步發布。 |
| 「這是『網頁應用程式』的用戶端」 | 回到第 3 步，另外建一個「電腦版應用程式」。 |
| 「沒有拿到管理 YouTube 的權限」 | 連結時要勾選 YouTube 那一項權限。 |
| 「今天的 YouTube API 額度用完了」 | 等台灣下午 3、4 點重置。 |
| 「這個 Google 帳號還沒有 YouTube 頻道」 | 先到 YouTube 用這個帳號建立頻道。 |
| 瀏覽器顯示 `redirect_uri_mismatch` | 用戶端類型不是「電腦版應用程式」，回到第 3 步。 |
