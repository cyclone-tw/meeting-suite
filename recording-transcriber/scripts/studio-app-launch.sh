#!/bin/bash
# 「字幕工作室.app」呼叫的啟動腳本（recording-transcriber#3）。
# App 是用 do shell script 跑的，PATH 幾乎是空的，所以自己找 node：
# 做 App 時記下的那個 → Homebrew → nvm 裡最新的一版。
set -u

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node=""
for c in "${CYCLONE_NODE_HINT:-}" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$c" ] && [ -x "$c" ]; then node="$c"; break; fi
done
if [ -z "$node" ]; then
  for c in $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V -r); do
    if [ -x "$c" ]; then node="$c"; break; fi
  done
fi
if [ -z "$node" ]; then
  echo "找不到 node，請 agent 協助安裝或重新執行 pnpm run studio:app" >&2
  exit 1
fi
export PATH="$(dirname "$node"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$node" "$dir/studio-ctl.mjs" "${@:-start}"
