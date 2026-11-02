#!/bin/bash
# 在鑰匙圈有金鑰的 Mac 執行：把 Soniox 金鑰放到另一台主機的 ~/.config/meeting-scribe/soniox.key（權限 600）。
# 金鑰只經過變數、pipe 與 SSH，不印出、不落本機的檔案。
# 讀不到金鑰就停下，不碰對方現有的金鑰；寫入先寫暫存檔再換名，失敗不會留下空檔。
# 用法：bash deploy/put-soniox-key.sh <ssh-host>
set -euo pipefail
HOST="${1:?用法：bash deploy/put-soniox-key.sh <ssh-host>}"
KEY="$(security find-generic-password -s soniox-api-key -w 2>/dev/null || true)"
[ -n "${KEY}" ] || { echo "鑰匙圈讀不到 soniox-api-key，未變更 ${HOST}" >&2; exit 1; }
printf '%s' "${KEY}" | ssh "${HOST}" '
  set -e
  umask 077
  d=~/.config/meeting-scribe
  mkdir -p "$d"
  cat > "$d/soniox.key.new"
  [ -s "$d/soniox.key.new" ] || { rm -f "$d/soniox.key.new"; echo "收到空內容，未變更" >&2; exit 1; }
  chmod 600 "$d/soniox.key.new"
  mv "$d/soniox.key.new" "$d/soniox.key"
  echo "已寫入，長度 $(wc -c < "$d/soniox.key" | tr -d " ") bytes"'
unset KEY
