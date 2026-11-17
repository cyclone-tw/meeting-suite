# 更新紀錄

版本規則：別人升級後要動手才能繼續用（設定、存檔格式、拿掉功能、最低版本）升大版號；新功能升小版號；修正與文件升修補號。0.x 期間大版號降為小版號。

## v0.7.0（2026-11-17）

### 新功能

- read the vocabulary notes from the wiki tool, not local files (#197)
- read the wiki for Ask AI through the wiki CLI instead of a local QMD index
- let Ask AI search the web and the user's wiki on request
- open straight into the three-column workspace with a library sidebar
- YouTube link projects without uploader captions — audio-only Soniox or auto captions
- YouTube link projects — embed playback with author captions, no video download; source icons
- import videos from Facebook and X links; fix isPlain for imports without captions
- timestamped Markdown study notes under the player
- Ask AI tab — ask about the video, clickable timestamps, templates
- three resizable columns, project list, chapter band on the timeline
- color-code Markdown headings and bold text in MdView
- export menu — transcript TXT, subtitles SRT/VTT, full record as Markdown, Word and PDF
- Ask AI tab — ask about the meeting transcript with clickable time citations

### 修正

- keep the Drive row below the Extend tab in short windows
- never overwrite a damaged library list that could not be backed up
- batch the #184/#185 review nits
- review follow-ups for the learning layout
- make students-sync optional so the public export can leave it out (cyclone-tw/recording-transcriber#199)
- stop timing-sensitive flakes in local-engine and import-transcript-big
- review nits from Ask AI and export

## v0.6.2（2026-11-07）

- servers do not reverse-resolve the bind address

## v0.6.1（2026-11-07）

- Studio home no longer breaks when codex features cannot be listed

## v0.6.0（2026-11-07）

- codex isolation, media token, shared-component pin, CI hardening, SECURITY.md
- tailnet identity on by default at install, SSE wakeups, ruff, free e2e ports

## v0.5.1（2026-11-07）

- harden agent env, Studio CSP and remote harvest; guard test list
- Host allowlist, tailnet identity, SSE and token limits

## v0.5.0（2026-11-04）

- youtube-upload command to publish a finished video without the studio
- 'no subtitles' source goes straight to YouTube upload

## v0.4.0（2026-11-03）

- zh/en UI switch
- AI output language setting
- shared components follow the UI language
- server messages follow the UI language

- consistent English wording for lines and trims
- i18n follow-ups from the #153 review
- extension file names follow the meeting language; i18n nits

## v0.3.0（2026-11-03）

- start from an existing SRT/VTT subtitle file
- zh/en UI language switch for the meeting app

- speaker labels never become shared corrections

## v0.2.1（2026-11-03）

- English README for the public meeting-suite

## v0.2.0（2026-11-03）

- redo a finished meeting with its meeting context

- public README explains saving to Google Drive; generic browser-upload guide
- public README explains YouTube upload (OAuth, not an API key)

## v0.1.0（2026-11-03）

第一個公開版本。
