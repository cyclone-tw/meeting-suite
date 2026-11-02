#!/bin/bash
# 在 Linux 主機上安裝／更新 meeting-scribe 常駐服務（#108）。
# 用法：root 把 repo clone 到 /opt/meeting-scribe（root 擁有、scribe 讀得到，服務帳號不需要 GitHub 憑證），
#       在 checkout 裡執行 `sudo bash deploy/install-linux.sh`。
# 步驟與要手動做的登入見 docs/deploy-linux.md。重複執行沒關係。
#
# - 專用帳號 scribe（不存在就建立，不能登入 shell）
# - systemd unit（deploy/meeting-scribe.service.in）：User=scribe、加固，開機自啟、掛掉自動重啟
# - server 只綁 127.0.0.1:${PORT}；tailscale serve（tailnet-only HTTPS）https://<host>.ts.net:${HTTPS_PORT}
# - /etc/meeting-scribe/env（root 600）放 CLAUDE_CODE_OAUTH_TOKEN；本腳本只檢查有沒有設，不印內容
# - MEETING_SCRIBE_PULL_DIRS（空白分隔的 git checkout 路徑）有設時，才安裝／更新每 15 分鐘 pull 一次的
#   meeting-scribe-wiki-pull.timer（學生資料、擴充包，#120）；沒設就不動現有的 timer
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "請用 sudo 執行" >&2; exit 1; }
SERVICE_USER="${MEETING_SCRIBE_USER:-scribe}"
PORT="${MEETING_SCRIBE_PORT:-18095}"
HTTPS_PORT="${MEETING_SCRIBE_HTTPS_PORT:-9443}"
PYTHON="${MEETING_SCRIBE_PYTHON:-/usr/bin/python3}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
UNIT=/etc/systemd/system/meeting-scribe.service
ENV_DIR=/etc/meeting-scribe
ENV_FILE="${ENV_DIR}/env"
case "${PORT}${HTTPS_PORT}" in *[!0-9]*|"") echo "MEETING_SCRIBE_PORT／HTTPS_PORT 要是數字" >&2; exit 1;; esac
"${PYTHON}" -c 'import sys; sys.exit(sys.version_info < (3, 9))' || { echo "${PYTHON} 要 3.9 以上" >&2; exit 1; }
command -v tailscale >/dev/null || { echo "找不到 tailscale" >&2; exit 1; }

# 自動 pull 的資料夾：先檢查完再動手。只收絕對路徑、英數與 . _ - /（要寫進 unit 的 ExecStart），而且要是 git checkout
PULL_DIRS=()
if [ -n "${MEETING_SCRIBE_PULL_DIRS:-}" ]; then
  # 空白、tab、換行都當分隔；不展開萬用字元
  IFS=$' \t\n' read -r -d '' -a PULL_DIRS <<< "${MEETING_SCRIBE_PULL_DIRS}" || true
  for d in "${PULL_DIRS[@]}"; do
    case "${d}" in /*) ;; *) echo "MEETING_SCRIBE_PULL_DIRS 要是絕對路徑：${d}" >&2; exit 1;; esac
    case "${d}" in *[!A-Za-z0-9._/-]*|*/../*|*/..) echo "MEETING_SCRIBE_PULL_DIRS 只能有英數與 . _ - /：${d}" >&2; exit 1;; esac
    [ "$(git -C "${d}" rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] || { echo "${d} 不是 git checkout（或擁有者不是 root，git 不信任）" >&2; exit 1; }
  done
fi

# 專用帳號：家目錄放 repo、設定、暫存與 Claude／Codex 的登入
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
  echo "建立帳號 ${SERVICE_USER}"
fi
HOME_DIR="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
as_user() { sudo -u "${SERVICE_USER}" -H env PATH="${HOME_DIR}/.local/bin:${HOME_DIR}/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin" "$@"; }
as_user test -r "${REPO}/server.py" || { echo "${SERVICE_USER} 讀不到 ${REPO}/server.py（repo 的資料夾要讓所有人可讀）" >&2; exit 1; }

# 服務要寫的地方先建好（unit 的 ReadWritePaths 指到不存在的路徑會起不來），權限 700／600
as_user mkdir -p "${HOME_DIR}/.config/meeting-scribe" "${HOME_DIR}/.local/share/meeting-scribe" "${HOME_DIR}/.claude" "${HOME_DIR}/.codex"
as_user chmod 700 "${HOME_DIR}/.config/meeting-scribe" "${HOME_DIR}/.local/share/meeting-scribe" "${HOME_DIR}/.claude" "${HOME_DIR}/.codex"
[ -e "${HOME_DIR}/.claude.json" ] || as_user sh -c "umask 077; : > '${HOME_DIR}/.claude.json'"

# 設定檔不存在才建：Linux 沒有 Drive 掛載與本機 Whisper；AI 整理開 Codex 備援、同時最多 2 場
CONFIG="${HOME_DIR}/.config/meeting-scribe/config.json"
if [ ! -f "${CONFIG}" ]; then
  as_user sh -c "umask 077; printf '%s\n' '{\"agent_fallback\": \"codex\", \"max_concurrent_agents\": 2}' > '${CONFIG}'"
  echo "建立 ${CONFIG}"
fi

# 環境檔：root 600。沒有就建一份只有說明的空檔
install -d -m 700 -o root -g root "${ENV_DIR}"
if [ ! -f "${ENV_FILE}" ]; then
  (umask 077; printf '%s\n' "# CLAUDE_CODE_OAUTH_TOKEN=（在 MacBook 跑 claude setup-token 產生，見 docs/deploy-linux.md）" > "${ENV_FILE}")
fi
chown root:root "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=.' "${ENV_FILE}"; then claude_token="有"; else claude_token="沒有"; fi

# Claude／Codex 裝了沒；Codex 要關掉的功能名稱這版認不認得（不認得 codex 會直接報錯）
if as_user sh -c 'command -v claude' >/dev/null; then claude_bin="有"; else claude_bin="沒有"; fi
codex_state="沒有安裝"
if as_user sh -c 'command -v codex' >/dev/null; then
  codex_state="$(as_user codex login status 2>&1 | head -1 || true)"
  wanted="$("${PYTHON}" -I - "${REPO}/server.py" "${CONFIG}" <<'PYEOF'
import ast, json, sys
names = None
try:
    names = json.load(open(sys.argv[2], encoding="utf-8")).get("codex_disable")
except (OSError, ValueError, AttributeError):
    pass
if not isinstance(names, list):
    tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
    names = next(ast.literal_eval(n.value) for n in tree.body
                 if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "DEFAULT_CODEX_DISABLE")
print("\n".join(names))
PYEOF
)"
  known="$(as_user codex features list 2>/dev/null | awk '{print $1}' || true)"
  missing=""
  for f in ${wanted}; do
    printf '%s\n' "${known}" | grep -qx "${f}" || missing="${missing} ${f}"
  done
  if [ -n "${missing}" ]; then
    echo "警告：這版 Codex 不認得要關掉的功能：${missing}。在 ${CONFIG} 設 codex_disable（見 docs/deploy-linux.md）" >&2
  fi
fi

# 學生資料／擴充包自動更新（#120）：有設 MEETING_SCRIBE_PULL_DIRS 才寫 unit；內容一樣時重寫也沒差
PULL_UNIT=/etc/systemd/system/meeting-scribe-wiki-pull.service
PULL_TIMER=/etc/systemd/system/meeting-scribe-wiki-pull.timer
if [ "${#PULL_DIRS[@]}" -gt 0 ]; then
  pull_tmp="$(mktemp)"
  trap 'rm -f "${pull_tmp}"' EXIT
  sed -e "s|@DIRS@|${PULL_DIRS[*]}|g" "${REPO}/deploy/meeting-scribe-wiki-pull.service.in" > "${pull_tmp}"
  grep -q '@[A-Z]*@' "${pull_tmp}" && { rm -f "${pull_tmp}"; echo "pull unit 還有沒換掉的 @…@" >&2; exit 1; }
  install -m 644 -o root -g root "${pull_tmp}" "${PULL_UNIT}"
  rm -f "${pull_tmp}"
  install -m 644 -o root -g root "${REPO}/deploy/meeting-scribe-wiki-pull.timer.in" "${PULL_TIMER}"
  systemd-analyze verify "${PULL_UNIT}" "${PULL_TIMER}" 2>&1 | grep -v '^$' || true
  systemctl daemon-reload
  systemctl enable meeting-scribe-wiki-pull.timer >/dev/null 2>&1
  systemctl restart meeting-scribe-wiki-pull.timer
  pull_state="每 15 分鐘 pull：${PULL_DIRS[*]}"
elif [ -f "${PULL_TIMER}" ]; then
  pull_state="沒設 MEETING_SCRIBE_PULL_DIRS，保留現有的 timer（沒有更新）"
else
  pull_state="沒設 MEETING_SCRIBE_PULL_DIRS，沒有安裝"
fi

# 有會議正在錄音就不重啟（同 install-macmini.sh，#60）；MEETING_SCRIBE_FORCE_RESTART=1 才硬重啟
RECORDING_QUIET_S="${MEETING_SCRIBE_RECORDING_QUIET_S:-90}"
WAIT_TRIES="${MEETING_SCRIBE_WAIT_TRIES:-80}"
WAIT_STEP="${MEETING_SCRIBE_WAIT_STEP:-15}"
if [ "${MEETING_SCRIBE_FORCE_RESTART:-0}" != "1" ]; then
  case "${WAIT_TRIES}${WAIT_STEP}${RECORDING_QUIET_S}" in *[!0-9]*|"") echo "MEETING_SCRIBE_WAIT_TRIES／WAIT_STEP／RECORDING_QUIET_S 要是非負整數" >&2; exit 1;; esac
  i=0
  while :; do
    i=$(( i + 1 ))
    idle="$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null \
      | "${PYTHON}" -I -c 'import json,sys; v=json.load(sys.stdin).get("recording_idle_s"); print("" if v is None else v)' 2>/dev/null || true)"
    if [ -z "${idle}" ] || [ "${idle}" -ge "${RECORDING_QUIET_S}" ]; then break; fi
    if [ "${i}" -ge "${WAIT_TRIES}" ]; then
      echo "還有會議在錄音（${idle} 秒前還有活動），這次不重啟。錄完再跑一次，或設 MEETING_SCRIBE_FORCE_RESTART=1。" >&2
      exit 1
    fi
    echo "有會議正在錄音（${idle} 秒前還有活動），等它結束再重啟…（${i}/${WAIT_TRIES}）"
    sleep "${WAIT_STEP}"
  done
fi

# 寫 unit：範本的 @…@ 換成這台的值；路徑不能有會弄壞 unit 的字元
for v in "${REPO}" "${HOME_DIR}" "${PYTHON}"; do
  case "${v}" in *[[:space:]@\|\\\$%\&]*) echo "路徑不能有空白或 @ | \\ \$ % &：${v}" >&2; exit 1;; esac
done
tmp="$(mktemp)"
trap 'rm -f "${tmp}" "${pull_tmp:-}"' EXIT
sed -e "s|@USER@|${SERVICE_USER}|g" -e "s|@HOME@|${HOME_DIR}|g" -e "s|@REPO@|${REPO}|g" \
    -e "s|@PYTHON@|${PYTHON}|g" -e "s|@PORT@|${PORT}|g" "${REPO}/deploy/meeting-scribe.service.in" > "${tmp}"
grep -q '@[A-Z]*@' "${tmp}" && { echo "unit 還有沒換掉的 @…@" >&2; exit 1; }
install -m 644 -o root -g root "${tmp}" "${UNIT}"
systemd-analyze verify "${UNIT}" 2>&1 | grep -v '^$' || true
systemctl daemon-reload
systemctl enable meeting-scribe.service >/dev/null 2>&1
systemctl restart meeting-scribe.service

tailscale serve --bg --https="${HTTPS_PORT}" "http://127.0.0.1:${PORT}" >/dev/null

health=""
for _ in $(seq 1 20); do
  if health="$(curl -fsS "http://127.0.0.1:${PORT}/healthz" 2>/dev/null)"; then break; fi
  health=""
  sleep 0.5
done
[ -n "${health}" ] || { echo "服務沒有起來，看 journalctl -u meeting-scribe" >&2; exit 1; }
echo "healthz: ${health}"
echo "python: ${PYTHON}"
echo "Claude Code：${claude_bin}；登入 token：${claude_token}"
echo "Codex：${codex_state}"
echo "學生資料自動更新：${pull_state}"
DNS="$(tailscale status --self --json | "${PYTHON}" -I -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
echo "網址：https://${DNS}:${HTTPS_PORT}/"
