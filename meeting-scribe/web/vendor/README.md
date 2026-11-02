# 第三方檔案

| 檔案 | 來源 | 授權 | SHA-256（base64） |
| --- | --- | --- | --- |
| `opencc-js-1.0.5-full.js` | https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/full.js | MIT（opencc-js），詞典資料來自 OpenCC（Apache-2.0） | `oub59f+nO+trUsaWNRn8U6gTt7MLHySjY0p5J+j1gVY=` |
| `azure-speech-sdk-1.52.0.bundle-min.js` | npm `microsoft-cognitiveservices-speech-sdk@1.52.0` 的 `distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle-min.js`（tarball sha512 `JhNNz/Cg8cx92TrX9IYNYVPgarrFZZSaPFjTkZgaQJMBZpgfCaNMjnpuYpr4NHT5h0QnS38IrUgmNbGrO6/xUQ==`，與 npm registry 公布的 integrity 相符） | MIT | `PkbvyIZFDxlA/U2lyvNaNiqEYplTVuMbI8PGrFi6Ou4=` |

放在 repo 由 server 自己提供，不從公開 CDN 載入：頁面會顯示會議逐字稿，不讓第三方 script 有機會讀取內容或呼叫 `/token`。
更新時重新下載、比對 jsDelivr 公布的雜湊值、改檔名版本號。檔名一定要換：server 對 `/vendor/*` 回一年的 `immutable` 快取（#102），同檔名換內容瀏覽器不會重抓。

Azure Speech SDK 只在選 Azure 引擎時才載入（#105），內容未改動：檔尾的 `sourceMappingURL` 指向沒放進來的 `.map`，只有開發者工具會去抓。
更新 Azure SDK：用 `pnpm view microsoft-cognitiveservices-speech-sdk@<版本> dist.tarball dist.integrity` 取得 tarball 與 integrity，下載後比對 sha512，再取出同一個檔案、換檔名版本號。
