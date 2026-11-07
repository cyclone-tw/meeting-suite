#!/bin/bash
# 在 Mac 上安裝／更新 meeting-scribe 常駐服務。
# 用法：在那台 Mac 的 repo checkout 裡執行 `bash deploy/install-macmini.sh`
#
# - launchd user agent，開機自啟、掛掉自動重啟
# - server 只綁 127.0.0.1:${PORT}
# - tailscale serve（tailnet-only HTTPS）https://<mini>.ts.net:${HTTPS_PORT} → 127.0.0.1:${PORT}
set -euo pipefail

LABEL="dev.cyclone.meeting-scribe"
PORT="${MEETING_SCRIBE_PORT:-18095}"
HTTPS_PORT="${MEETING_SCRIBE_HTTPS_PORT:-9443}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG="${HOME}/Library/Logs/meeting-scribe.log"
DATA="${HOME}/meeting-scribe-data"
KEY_FILE="${HOME}/.config/meeting-scribe/soniox.key"
DOMAIN="gui/$(id -u)"
# 系統 /usr/bin/python3（3.9、LibreSSL 2.8）在部分網路上對 api.soniox.com 的 TLS 握手會逾時，
# 預設改用 Homebrew python3（OpenSSL 3），沒有才退回系統版。
PYTHON="${MEETING_SCRIBE_PYTHON:-}"
if [ -z "${PYTHON}" ]; then
  if [ -x /opt/homebrew/bin/python3 ]; then PYTHON=/opt/homebrew/bin/python3; else PYTHON=/usr/bin/python3; fi
fi

TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "${TS}" ] || TS="$(command -v tailscale || true)"
[ -n "${TS}" ] || { echo "找不到 tailscale CLI" >&2; exit 1; }

# 會議資料只放本機，權限 700
mkdir -p "${DATA}" "$(dirname "${LOG}")" "${HOME}/Library/LaunchAgents"
chmod 700 "${DATA}"

if [ ! -f "${KEY_FILE}" ]; then
  echo "警告：${KEY_FILE} 不存在（在有金鑰的那台 Mac 跑 deploy/put-soniox-key.sh <這台的 ssh 名稱> 放上來）" >&2
fi

# 「存到 Drive」允許的根目錄。只在設定檔不存在時建立：有給 MEETING_SCRIBE_DRIVE_ACCOUNT
# （Google 帳號，例如 you@example.com）就找那個帳號的「我的雲端硬碟／My Drive」，沒給就留空。
# 之後要加或改位置就直接編輯 config.json（不進 git）。
CONFIG="${HOME}/.config/meeting-scribe/config.json"
DRIVE_ACCOUNT="${MEETING_SCRIBE_DRIVE_ACCOUNT:-}"
if [ ! -f "${CONFIG}" ]; then
  mkdir -p "$(dirname "${CONFIG}")"
  (umask 077; "${PYTHON}" -I - "${CONFIG}" "${DRIVE_ACCOUNT}" <<'PYEOF'
import glob, json, os, sys
config, account = sys.argv[1], sys.argv[2]
roots = {}
# 排除 Drive for desktop 重建後留下的「(日期)」舊掛載點
found = [p for p in glob.glob(os.path.expanduser("~/Library/CloudStorage/GoogleDrive-" + glob.escape(account))) if "(" not in p] if account else []
mine = [os.path.join(found[0], n) for n in ("我的雲端硬碟", "My Drive")] if len(found) == 1 else []
mine = [p for p in mine if os.path.isdir(p)]
if mine:
    roots["drive"] = {"label": "Google Drive", "path": mine[0]}
with open(config, "w", encoding="utf-8") as fh:
    json.dump({"drive_roots": roots}, fh, ensure_ascii=False, indent=2)
print("Drive 根目錄：" + ("、".join(r["label"] for r in roots.values()) or "沒有偵測到，請手動編輯 " + config))
PYEOF
  )
fi
# 預設只放行安裝者自己的 tailnet 帳號（#209）：設定檔沒有 tailscale_users 才填；已有的（含空清單）不動
# 輸出先收進變數：tailscale 沒登入也好、helper 不讀完就結束也好，都不能在 pipefail 下讓安裝中止
TS_JSON="$("${TS}" status --self --json 2>/dev/null || true)"
printf '%s' "${TS_JSON}" | "${PYTHON}" -I "${REPO}/deploy/ensure-tailnet-users.py" "${CONFIG}"

# 有會議正在錄音就不重啟：重啟會切斷本機辨識與 AI 整理（#60）。舊版服務沒有 recording_idle_s 就不擋。
# 放在寫 plist 之前：放棄部署時什麼都不改（#63）。
# MEETING_SCRIBE_FORCE_RESTART=1 才硬重啟。
RECORDING_QUIET_S="${MEETING_SCRIBE_RECORDING_QUIET_S:-90}"
WAIT_TRIES="${MEETING_SCRIBE_WAIT_TRIES:-80}"   # 每 WAIT_STEP 秒問一次，預設最多等 20 分鐘
WAIT_STEP="${MEETING_SCRIBE_WAIT_STEP:-15}"
if [ "${MEETING_SCRIBE_FORCE_RESTART:-0}" != "1" ]; then
  case "${WAIT_TRIES}${WAIT_STEP}${RECORDING_QUIET_S}" in *[!0-9]*|"") echo "MEETING_SCRIBE_WAIT_TRIES／WAIT_STEP／RECORDING_QUIET_S 要是非負整數" >&2; exit 1;; esac
  # 用 while 計數：BSD seq 在 WAIT_TRIES=0 時會倒數輸出 1 0。WAIT_TRIES=0 表示只看一次、不等
  i=0
  while :; do
    i=$(( i + 1 ))
    idle="$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null \
      | /usr/bin/python3 -I -c 'import json,sys; v=json.load(sys.stdin).get("recording_idle_s"); print("" if v is None else v)' 2>/dev/null || true)"
    if [ -z "${idle}" ] || [ "${idle}" -ge "${RECORDING_QUIET_S}" ]; then break; fi
    if [ "${i}" -ge "${WAIT_TRIES}" ]; then
      echo "還有會議在錄音（${idle} 秒前還有活動），等了 $(( WAIT_TRIES * WAIT_STEP / 60 )) 分鐘仍沒結束，這次不重啟。錄完再跑一次，或設 MEETING_SCRIBE_FORCE_RESTART=1 硬重啟。" >&2
      exit 1
    fi
    echo "有會議正在錄音（${idle} 秒前還有活動），等它結束再重啟…（${i}/${WAIT_TRIES}）"
    sleep "${WAIT_STEP}"
  done
fi

cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PYTHON}</string>
    <string>-I</string>
    <string>${REPO}/server.py</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${HOME}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>MEETING_SCRIBE_PORT</key><string>${PORT}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
EOF
/usr/bin/plutil -lint "${PLIST}" >/dev/null

# 先卸載舊版，等它真的卸載完再載入（bootout 是非同步的）
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}" || true
  for _ in $(seq 1 20); do
    launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || break
    sleep 0.5
  done
fi
# 紀錄檔只有路徑、狀態碼與音量數字；超過 5 MB 就在重啟前換檔，保留上一份（服務停著，不會寫到一半）
LOG_MAX_BYTES="${MEETING_SCRIBE_LOG_MAX_BYTES:-5242880}"
if [ -f "${LOG}" ] && [ "$(stat -f %z "${LOG}")" -gt "${LOG_MAX_BYTES}" ]; then
  mv -f "${LOG}" "${LOG}.1"
  echo "紀錄檔超過 $(( LOG_MAX_BYTES / 1048576 )) MB，舊的移到 ${LOG}.1"
fi
launchctl bootstrap "${DOMAIN}" "${PLIST}"

"${TS}" serve --bg --https="${HTTPS_PORT}" "http://127.0.0.1:${PORT}" >/dev/null

health=""
for _ in $(seq 1 20); do
  if health="$(curl -fsS "http://127.0.0.1:${PORT}/healthz" 2>/dev/null)"; then break; fi
  health=""
  sleep 0.5
done
[ -n "${health}" ] || { echo "服務沒有起來，看 ${LOG}" >&2; exit 1; }
echo "healthz: ${health}"
echo "python: ${PYTHON}"
# 實打一次 /token，確認真的連得到 Soniox（只看有沒有拿到臨時金鑰，不印金鑰）
if curl -fsS -m 30 -H "X-Meeting-Scribe: 1" -X POST "http://127.0.0.1:${PORT}/token" | grep -q '"api_key"'; then
  echo "token: OK"
else
  echo "token: 失敗，看 ${LOG}" >&2
  exit 1
fi
DNS="$("${TS}" status --self --json | /usr/bin/python3 -I -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
echo "網址：https://${DNS}:${HTTPS_PORT}/"
