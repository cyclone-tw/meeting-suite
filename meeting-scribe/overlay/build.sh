#!/bin/bash
# 編譯並安裝「會議字幕」小程式（#32）到 ~/Applications，只需要 Xcode Command Line Tools。
# 用法：overlay/build.sh [安裝位置，預設 ~/Applications/MeetingCaption.app]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
app="${1:-$HOME/Applications/MeetingCaption.app}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

mkdir -p "${work}/MeetingCaption.app/Contents/MacOS"
swiftc -O -swift-version 5 -o "${work}/MeetingCaption.app/Contents/MacOS/MeetingCaption" "${here}/MeetingCaption.swift"
cp "${here}/Info.plist" "${work}/MeetingCaption.app/Contents/Info.plist"

# 執行中的舊版要先結束，才換得掉
osascript -e 'tell application id "dev.cyclone.meeting-caption" to quit' >/dev/null 2>&1 || true
mkdir -p "$(dirname "${app}")"
ditto "${work}/MeetingCaption.app" "${app}"
codesign --force --sign - "${app}"
# 讓系統認得 meetingcaption:// 網址
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "${app}"
echo "已安裝：${app}"
