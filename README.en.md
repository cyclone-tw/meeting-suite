# meeting-suite

[繁體中文](README.md) | English

Turn meetings and videos into transcripts, subtitles, summaries and mind maps on your own Mac. Two tools:

| Folder | What it is | How you use it |
| --- | --- | --- |
| `meeting-scribe/` | **Cyclone Scribe**: live meeting transcription. Records in the browser with captions as people speak; AI writes paragraph highlights and a live summary, then a summary, minutes and a mind map after the meeting | Web page (locally `http://127.0.0.1:18095/`) |
| `recording-transcriber/` | **字幕工作室 (Subtitle Studio)**: subtitles for videos, trimming, burned-in captions, YouTube descriptions and upload; plus a command-line transcriber for recordings | Web page (locally `http://127.0.0.1:8766/`) and commands |

The interface is in Traditional Chinese (Taiwan); button names below are given in Chinese with a translation. The two tools sit side by side: the Subtitle Studio's post-meeting summary and mind map use the code and UI components in `meeting-scribe/`.

## Requirements

| Item | Used for | Required |
| --- | --- | --- |
| macOS 13 or later, Homebrew | Everything | Yes |
| Node.js 24 or later, pnpm 11 | Subtitle Studio and CLI | Yes |
| Python 3.9 or later | Meeting app (standard library only) | Yes |
| ffmpeg | Audio extraction, thumbnails, waveforms, trimming, imports | Yes |
| Claude Code (signed in, Pro plan or above) | Proofreading, highlights, summaries, mind maps | Yes |
| Soniox API key | Cloud speech recognition (default engine of both tools) | When using Soniox |
| ffmpeg-full | Burning subtitles into video (needs libass) | When burning subtitles |
| yt-dlp | Downloading YouTube videos and captions | When using YouTube |
| mlx-whisper (Apple silicon) | Local recognition; audio never leaves the Mac | Optional |
| Tailscale | Reaching the meeting app from a phone or another computer | Optional |

## Install

```bash
brew install node pnpm python ffmpeg ffmpeg-full yt-dlp
curl -fsSL https://claude.ai/install.sh | bash      # or: brew install --cask claude-code
claude                                              # first run opens the browser to sign in; type /exit afterwards
git clone https://github.com/cyclone-tw/meeting-suite.git ~/meeting-suite
cd ~/meeting-suite/recording-transcriber && pnpm install --frozen-lockfile
```

Optional local recognition:

```bash
brew install pipx && pipx install mlx-whisper
```

## Keys and authorisation

Keys never go into the repo, a chat or an issue.

| Item | Where to get it | Where it goes |
| --- | --- | --- |
| Soniox | Create an API key at [console.soniox.com](https://console.soniox.com/) | `security add-generic-password -s soniox-api-key -a "$USER" -w` (prompts for the key; both tools read it). Or `~/.config/meeting-scribe/soniox.key` (mode 600), or the `SONIOX_API_KEY` environment variable |
| Claude Code | The `claude` sign-in above | Kept by Claude Code |
| YouTube upload (optional) | An OAuth client (desktop app) in your own Google Cloud project; see "Upload to YouTube" below | macOS Keychain (linked in the Subtitle Studio settings) |
| Groq (optional, cloud Whisper fallback) | [console.groq.com](https://console.groq.com/) | `GROQ_API_KEY`, or the Keychain service `groq-api-key` |
| Apify (optional, YouTube videos without captions) | [apify.com](https://apify.com/) | `APIFY_TOKEN` |

## Check the install

```bash
cd ~/meeting-suite/recording-transcriber
node scripts/transcript-job.mjs ping        # one JSON line: whether ffmpeg, ffmpeg_full, mlx_whisper, claude and yt_dlp are available
pnpm test
cd ../meeting-scribe && python3 -m unittest discover -s tests
```

## Use

### Meeting app

```bash
cd ~/meeting-suite/meeting-scribe
python3 -I server.py          # http://127.0.0.1:18095/, Ctrl-C to stop
```

- Before starting, write a meeting note under 「新的會議」 (New meeting), for example "the host opens, four teachers share in turn, Q&A at the end". The AI uses it to tell who is speaking and whether it is the host or a speaker.
- If names, speakers or terms were misheard, press 「AI 修正」 (AI corrections) above the timeline, say in one sentence what to change, tick the suggested replacements, and the whole meeting is updated.
- After the meeting, 「會議說明」 (Meeting note) → 「依說明重整這場」 (Redo with this note) reprocesses the whole meeting with an updated note.
- To start at login and reach it from a phone: `bash deploy/install-macmini.sh` (a launchd service plus an HTTPS address that only your tailnet can reach, via `tailscale serve`).
- Meeting drafts are kept in `~/.local/share/meeting-scribe/drafts/`; they are deleted after saving to Drive, or after 7 days if never saved.

### Subtitle Studio

```bash
cd ~/meeting-suite/recording-transcriber
pnpm run studio:start         # runs in the background at http://127.0.0.1:8766/ (stop: pnpm run studio:stop)
pnpm run studio:app           # optional: builds ~/Applications/字幕工作室.app; drag it to the Dock
```

Pick a video → preview and trim → recognition and AI proofreading → edit subtitles, AI cut suggestions, shorts → burn subtitles or upload to YouTube. It only listens on 127.0.0.1 and uses a new token on every start.

### Upload to YouTube (optional)

The Subtitle Studio can upload the video, subtitles and description to your channel. Google requires OAuth for uploads; an API key alone is not enough. You use your own Google Cloud project; the repo contains nobody's account. First-time setup takes about 15 minutes; full steps (in Chinese) are in [`recording-transcriber/docs/youtube-setup.md`](recording-transcriber/docs/youtube-setup.md):

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3**.
2. In Google Auth Platform, set up the consent screen with audience "External", then press "Publish app" to move it to production (in testing, authorisation expires after 7 days).
3. Create an OAuth client of type **Desktop app** and download `client_secret_….json`.
4. In the Subtitle Studio, 「設定」 (Settings) → choose that JSON file → 「連結 YouTube 頻道」 (Link YouTube channel), and authorise in the browser. You can link several channels, each with its own defaults (visibility, playlist, category…).

Then press 「上傳 YouTube」 (Upload to YouTube) in the editor: attach CC subtitles or upload the burned-in version, use the AI-written description (chapter times already adjusted for cuts), schedule publishing; interrupted uploads resume. The Studio keeps only the client secret and channel authorisations, in the macOS Keychain, and writes no other files; you can delete the downloaded JSON after importing it. Each Google Cloud project can upload at most 100 videos a day.

### Save to Google Drive (optional)

Four ways, all into your own account:

**Meeting app: with Google Drive for desktop (recommended)**

1. Install [Google Drive for desktop](https://www.google.com/drive/download/) and sign in. Google Drive appears in the Finder sidebar; the actual folder is `~/Library/CloudStorage/GoogleDrive-<your account>/My Drive` (`我的雲端硬碟` in a Chinese system).
2. Add it to `~/.config/meeting-scribe/config.json` (you can list several, for example a personal and a school account):

   ```json
   {
     "drive_roots": {
       "mine": { "label": "My Drive", "path": "~/Library/CloudStorage/GoogleDrive-you@example.com/My Drive" }
     }
   }
   ```

   When installing the service with `deploy/install-macmini.sh`, `MEETING_SCRIBE_DRIVE_ACCOUNT=you@example.com` writes this for you (only if the config file does not exist yet).
3. In the meeting app, 「設定」 (Settings) → 「存到 Drive 的預設」 (Drive defaults): location, folder (default 「會議紀錄」) and whether to include the audio. After the meeting press 「存到 Drive」 (Save to Drive): one folder per meeting, "date time title", with the transcript, summary, minutes, mind map (.md, .svg, .opml), form Word file and audio, whichever exist. The draft on the host is deleted once saved.

**Meeting app: hosted on another machine, saving from a phone**: when the host has no Google Drive, the browser signs in to Google and uploads the files directly (only the `drive.file` scope, so it cannot see your other files). You need your own Google OAuth client; steps (in Chinese) are in [`meeting-scribe/docs/drive-browser.md`](meeting-scribe/docs/drive-browser.md).

**Subtitle Studio: a copy of the post-meeting summary**: when a summary, mind map or extension result is generated, a copy is written in the background to "<folder>/<date time title>" in Drive. Add to `~/.config/recording-transcriber/asr-profile.json`:

```json
{ "studio_drive": { "account_suffix": "@example.com", "folder": "My Drive/Meeting notes", "label": "My Drive" } }
```

`account_suffix` is the end of the Google account, used to find the right Drive in `~/Library/CloudStorage`; `folder` is a folder inside that Drive (it must exist). Without this setting nothing is saved and the Drive row is hidden.

**Transcription CLI: archive**: `pnpm run archive <package> --dest <path>` copies a transcript package to Drive (or iCloud Drive), checks every file's size and sha256, and only then deletes the local copy. Destinations are under `archive` in `asr-profile.json` (`drive_mount`, `drive_prefix`, `icloud_prefix`); see [`asr-profile.example.json`](recording-transcriber/config/asr-profile.example.json).

### Commands

```bash
pnpm run transcript -- "recording or video" --engine mlx     # local Whisper into a transcript package (SRT, VTT, Markdown)
pnpm run subtitle "video.mp4" --burn                         # subtitles in one step, burned into the video
pnpm run speakers "video.mp4" ~/Downloads/craig-….zip --name account=Name   # label speakers from Discord tracks
```

### Discord meetings: record per-speaker tracks with Craig

[Craig](https://craig.chat/) is a Discord recording bot that records each person on a separate track; the Subtitle Studio uses those tracks to tell who said each line.

1. At [craig.chat](https://craig.chat/), press "Add to Discord" and add Craig to your server (it needs Send Messages, Connect and Change Nickname).
2. In the voice channel, type `/join` to start recording and `/stop` to end. Record the screen and mixed audio at the same time, for example with OBS.
3. Craig sends a download link by direct message (or type `/recordings`). On the download page choose a multi-track format such as AAC or FLAC; you get `craig-….zip` (an `info.txt` plus one audio file per person). Put it in Downloads or next to the video. Free recordings are kept for 7 days and can be up to 6 hours long.
4. When you open that recording in the Subtitle Studio, 「有沒有 Discord 分軌」 (Discord tracks) finds the zip whose recording time matches; enter the name each account should show in the subtitles and start. A line gets 「【Name】」 when the speaker changes, and voices missing from the video (for example a microphone OBS did not capture) are filled in from the tracks.

## Personal settings (not in git)

| File | What goes in it | Example |
| --- | --- | --- |
| `~/.config/recording-transcriber/asr-profile.json` | Correction list, vocabulary note locations, meeting app URL, shared iCloud folder, remote Mac, Drive copy and archive destinations. Features stay off until set | [`recording-transcriber/config/asr-profile.example.json`](recording-transcriber/config/asr-profile.example.json) |
| `~/.config/meeting-scribe/config.json` | The meeting app's Drive folders (`drive_roots`) or browser upload (`drive_mode`, `google_client_id`), vocabulary notes (`vocabulary_files`), extension packs (`packs`), host name (`host_label`) and more | Pack format in [`meeting-scribe/docs/packs.md`](meeting-scribe/docs/packs.md) |
| `~/.config/meeting-scribe/deploy.env` | Hosts and Cloudflare account for deploying the meeting app to other machines (read by `deploy/deploy-all.sh`) | See the top of `meeting-scribe/deploy/deploy-all.sh` |

## Licence and notices

- The code is under the [MIT License](LICENSE), © 2026 Cyclone; you may use, modify and redistribute it.
- The names "Cyclone Scribe" and 「字幕工作室」 and Cyclone's dragon avatar are not covered by the licence (see [NOTICE](NOTICE)). If you publish a modified version, use your own name and icon so it is not mistaken for an official Cyclone release.
- The code was written by Cyclone together with AI coding assistants.
- Data and privacy:
  - Recordings, videos, transcripts and meeting drafts stay on your own computer (or a host you deploy yourself); saving to Google Drive, iCloud or YouTube happens only when you press the button, into your own account.
  - Steps that send data to cloud services: Soniox (recognition, default), Microsoft Azure Speech (optional recognition), Anthropic Claude (proofreading and summaries through Claude Code; Codex is an optional fallback), Groq and Apify (optional), Google (YouTube upload, Drive). With local mlx-whisper the audio stays on the Mac, but the AI steps still send the text to Claude.
  - Each service's own terms govern how it handles data; who you record, where you save and which services you use are your decision and responsibility.
- Provided as is, without support or warranty; check AI-generated content yourself.
- Third-party packages, models and services have their own licences and terms, outside the MIT licence; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
