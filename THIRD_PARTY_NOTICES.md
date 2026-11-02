# 第三方授權與條款

本專案的程式碼採 MIT（見 [LICENSE](LICENSE)）。下面這些不是本專案的程式，各自依自己的授權或服務條款，不在 MIT 範圍內。

## 隨 repo 附上的檔案

| 檔案 | 來源 | 授權 |
| --- | --- | --- |
| `meeting-scribe/web/vendor/opencc-js-1.0.5-full.js` | [opencc-js](https://github.com/nk2028/opencc-js) 1.0.5 | MIT；詞典資料來自 [OpenCC](https://github.com/BYVoid/OpenCC)，Apache-2.0 |
| `meeting-scribe/web/vendor/azure-speech-sdk-1.52.0.bundle-min.js` | npm `microsoft-cognitiveservices-speech-sdk` 1.52.0 | MIT |

來源網址與雜湊值見 `meeting-scribe/web/vendor/README.md`。

## pnpm 安裝的套件（`recording-transcriber/`）

| 套件 | 授權 |
| --- | --- |
| [@huggingface/transformers](https://github.com/huggingface/transformers.js) | Apache-2.0 |
| [openai](https://github.com/openai/openai-node)（呼叫 Groq 的相容 API） | Apache-2.0 |
| [opencc-js](https://github.com/nk2028/opencc-js) | MIT（詞典 Apache-2.0） |
| [wavefile](https://github.com/rochars/wavefile) | MIT |

間接相依套件的授權以 `pnpm-lock.yaml` 鎖定的版本為準（`pnpm licenses list` 可列出）。

## 使用者自己安裝的工具

| 工具 | 授權 |
| --- | --- |
| [FFmpeg](https://ffmpeg.org/legal.html)（`ffmpeg`、`ffmpeg-full`） | LGPL-2.1 以上；含 GPL 元件的組建（例如 `ffmpeg-full`）整體是 GPL |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense |
| [mlx-whisper](https://github.com/ml-explore/mlx-examples) | MIT |
| [Claude Code](https://code.claude.com/) | Anthropic 的商業條款 |
| [Codex CLI](https://github.com/openai/codex)（選用備援） | Apache-2.0；使用時另依 OpenAI 條款 |
| [Tailscale](https://tailscale.com/)（選用） | 用戶端程式依 Tailscale 條款，部分元件 BSD-3-Clause |
| [Craig](https://craig.chat/)（Discord 錄音，選用） | 依 Craig 的服務條款 |

## 辨識模型（執行時下載）

| 模型 | 用在哪裡 | 授權 |
| --- | --- | --- |
| [mlx-community/whisper-large-v3-mlx](https://huggingface.co/mlx-community/whisper-large-v3-mlx)（由 OpenAI Whisper 轉換） | 本機辨識（mlx-whisper） | MIT |
| [Xenova/whisper-small](https://huggingface.co/Xenova/whisper-small)（ONNX 版 Whisper） | 沒有 mlx-whisper 時的本機備援（transformers.js） | Apache-2.0；原始 Whisper 權重 MIT |

## 雲端服務（各依其服務條款與隱私政策）

| 服務 | 用在哪裡 |
| --- | --- |
| [Soniox](https://soniox.com/) | 即時與錄音辨識（預設） |
| [Microsoft Azure AI Speech](https://azure.microsoft.com/products/ai-services/ai-speech) | 會議 App 選用辨識引擎 |
| [Anthropic Claude](https://www.anthropic.com/legal)（經 Claude Code） | 校對、段落重點、總結、會議紀錄、心智圖、AI 修正 |
| [OpenAI](https://openai.com/policies)（經 Codex，選用） | Claude 不能用時的備援 |
| [Groq](https://groq.com/)（選用） | 雲端 Whisper 備援 |
| [Apify](https://apify.com/)（選用） | 抓沒有字幕的 YouTube 影片 |
| [YouTube Data API](https://developers.google.com/youtube/terms/api-services-terms-of-service)（選用） | 上傳影片與字幕 |
| [Google Drive API](https://developers.google.com/terms)（選用） | 會議 App 在瀏覽器把結果存進自己的 Drive |
| [Cloudflare Pages](https://www.cloudflare.com/terms/)（選用） | 會議 App 網頁的另一種部署方式 |
