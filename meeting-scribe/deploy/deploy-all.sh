#!/usr/bin/env bash
# 從自己的 Mac 一次部署 meeting-scribe 到 Linux 主機（主力）、Mac 主機（同版本備援）與 Cloudflare Pages。
# 只用其中幾個就加 --only。主機與位置寫在 ~/.config/meeting-scribe/deploy.env（不進 git，KEY=VALUE），
# 或用同名環境變數給；沒設主機卻要部署那個目標就停下。
#
# 用法（在 repo checkout，main 已 pull 到最新）：
#   bash deploy/deploy-all.sh --dry-run                    # 只檢查、列出會做什麼，不改任何東西
#   CLOUDFLARE_API_TOKEN="$(cat ~/.config/cloudflare/deploy.token)" bash deploy/deploy-all.sh
#   bash deploy/deploy-all.sh --only oci,mini,corrections  # 不部署 Pages（不用 token）
#
# 目標（--only 用逗號分隔，預設全部）：
#   oci          Linux 主機（DEPLOY_OCI_HOST）：DEPLOY_OCI_REPO 快轉到這個 commit，跑 install-linux.sh（沿用現有的自動 pull 設定）
#   mini         Mac 主機（DEPLOY_MINI_HOST）：repo 快轉到這個 commit，背景跑 install-macmini.sh 再輪詢結果（SSH 長命令會斷）
#   corrections  Linux 主機的個人常錯字對照複製到 Mac 主機（先備份；Mac 主機有 Linux 主機沒有的對照就不蓋，列出來）
#   pages        網頁放 Cloudflare Pages（deploy-pages.sh）；CLOUDFLARE_API_TOKEN 沒給就跳過，算沒完成
#
# 規則：
# - 只部署 origin/main 最新的 commit：本機工作樹有改動、或 HEAD 不等於 origin/main（沒 pull 或還沒 push）就拒絕。
# - 部署前先看每台的 /healthz：有會議正在錄音（recording_idle_s 小於 MEETING_SCRIBE_RECORDING_QUIET_S，預設 90 秒）
#   就不動那台，最後算失敗；其他台照做。
# - 最後檢查每台：healthz ok、build 等於這版網頁的雜湊、git HEAD 等於這個 commit。任一項沒過就非零結束，並說是哪一台。
#
# 設定（deploy.env 或環境變數；環境變數優先）：
#   MEETING_SCRIBE_DEPLOY_ENV  設定檔位置（預設 ~/.config/meeting-scribe/deploy.env）
#   DEPLOY_OCI_HOST     Linux 主機的 ssh 名稱；DEPLOY_MINI_HOST Mac 主機的 ssh 名稱（要部署那個目標就必填）
#   DEPLOY_OCI_REPO     預設 /opt/meeting-scribe；DEPLOY_MINI_REPO 預設 Mac 主機上和這裡相同的家目錄相對位置
#   DEPLOY_SSH          ssh 執行檔（預設 ssh）
#   DEPLOY_POLL_TRIES   Mac 主機安裝結果最多問幾次（每 DEPLOY_POLL_STEP 秒，預設 60 次 × 5 秒）
#   SCRIBE_API          Pages 要連的主機 API；沒設就問 Linux 主機的 tailnet 名稱，組成 https://<名稱>:9443
#   CLOUDFLARE_API_TOKEN  由呼叫端提供；這支腳本只轉交給 deploy-pages.sh，不印、不寫檔
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/.." && pwd)"
. "${here}/load-env.sh"
SSH_BIN="${DEPLOY_SSH:-ssh}"
OCI="${DEPLOY_OCI_HOST:-}"
MINI="${DEPLOY_MINI_HOST:-}"
OCI_REPO="${DEPLOY_OCI_REPO:-/opt/meeting-scribe}"
case "${root}" in "${HOME}"/*) mini_default="\$HOME/${root#"${HOME}"/}" ;; *) mini_default="${root}" ;; esac
MINI_REPO="${DEPLOY_MINI_REPO:-${mini_default}}"
QUIET_S="${MEETING_SCRIBE_RECORDING_QUIET_S:-90}"
POLL_TRIES="${DEPLOY_POLL_TRIES:-60}"
POLL_STEP="${DEPLOY_POLL_STEP:-5}"
MINI_LOG=/tmp/meeting-scribe-deploy.log
MINI_RC=/tmp/meeting-scribe-deploy.rc
OCI_CORR='~scribe/.local/share/meeting-scribe/corrections.json'
MINI_CORR='$HOME/.local/share/meeting-scribe/corrections.json'

dry_run=0
targets="oci,mini,corrections,pages"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --only) shift; targets="${1:-}" ;;
    --only=*) targets="${1#--only=}" ;;
    *) echo "不認得的參數：$1" >&2; exit 2 ;;
  esac
  shift
done
for t in $(printf '%s' "${targets}" | tr ',' ' '); do
  case "${t}" in oci|mini|corrections|pages) ;; *) echo "--only 只能是 oci、mini、corrections、pages：${t}" >&2; exit 2 ;; esac
done
[ -n "$(printf '%s' "${targets}" | tr -d ', ')" ] || { echo "--only 至少要一個目標" >&2; exit 2; }
case "${QUIET_S}${POLL_TRIES}${POLL_STEP}" in *[!0-9]*) echo "MEETING_SCRIBE_RECORDING_QUIET_S／DEPLOY_POLL_TRIES／DEPLOY_POLL_STEP 要是非負整數" >&2; exit 2 ;; esac
want() { case ",${targets}," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
# Pages 要的帳號 ID 先查：不然主機都更新完了才發現網頁換不了
if want pages && [ "${dry_run}" -eq 0 ] && [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "要部署 Pages，先在 ${deploy_env} 設 CLOUDFLARE_ACCOUNT_ID；不用就加 --only 拿掉 pages" >&2; exit 2
fi
if { want oci || want corrections; } && [ -z "${OCI}" ]; then
  echo "要部署 Linux 主機（oci）或同步對照（corrections），先在 ${deploy_env} 設 DEPLOY_OCI_HOST；不用就加 --only 拿掉" >&2; exit 2
fi
if { want mini || want corrections; } && [ -z "${MINI}" ]; then
  echo "要部署 Mac 主機（mini）或同步對照（corrections），先在 ${deploy_env} 設 DEPLOY_MINI_HOST；不用就加 --only 拿掉" >&2; exit 2
fi
for h in "${OCI}" "${MINI}"; do
  case "${h}" in *[!A-Za-z0-9._@-]*|-*) echo "主機名稱只能有英數、. _ @ -：${h}" >&2; exit 2 ;; esac
done

# 每個遠端命令開頭帶 `: step=<名稱>;`，紀錄看得出在做哪一步（測試的假 ssh 也靠它分辨）
remote() { local host="$1" step="$2"; shift 2; "${SSH_BIN}" -o ConnectTimeout=10 -o BatchMode=yes "${host}" ": step=${step}; $*"; }

failed=""
note_fail() { failed="${failed}
- $1"; echo "失敗：$1" >&2; }

# ---- 1. 本機：只部署已 push 的 commit ----
if [ -n "$(git -C "${root}" status --porcelain --untracked-files=normal)" ]; then
  echo "本機工作樹有沒 commit 的改動（含新檔），不部署。先 commit 並 push，或換到乾淨的 checkout。" >&2
  exit 2
fi
git -C "${root}" fetch -q origin main
sha="$(git -C "${root}" rev-parse HEAD)"
# 落後也不行：主機快轉到舊 commit 會「已是最新」而照樣重啟，Pages 卻會換成舊網頁
if [ "${sha}" != "$(git -C "${root}" rev-parse origin/main)" ]; then
  echo "這個 commit（${sha:0:7}）不是 origin/main 最新的，不部署。先 git pull；只部署已經 merge 並 push 的最新版。" >&2
  exit 2
fi
build="$(python3 -I "${root}/deploy/build-pages.py" --print-build)"
echo "要部署：${sha:0:7}（網頁版本 ${build}）；目標：${targets}$( [ "${dry_run}" -eq 1 ] && echo '；dry-run，不改任何東西' )"

# ---- 2. 部署前看每台有沒有人在錄音 ----
health_field() { python3 -I -c 'import json,sys
d=json.loads(sys.stdin.read() or "{}"); v=d.get(sys.argv[1])
print("" if v is None else (str(v).lower() if isinstance(v,bool) else v))' "$1"; }
precheck() {  # $1 名稱 $2 host；可以部署回 0
  local name="$1" host="$2" h idle
  if ! h="$(remote "${host}" health 'curl -fsS -m 5 http://127.0.0.1:18095/healthz')"; then
    note_fail "${name}：部署前連不到 /healthz（主機或服務沒開），這台沒部署"; return 1
  fi
  idle="$(printf '%s' "${h}" | health_field recording_idle_s)"
  if [ -n "${idle}" ] && [ "${idle%.*}" -lt "${QUIET_S}" ]; then
    note_fail "${name}：有會議正在錄音（${idle} 秒前還有活動），這台沒部署；錄完再跑一次"; return 1
  fi
  echo "${name}：沒有人在錄音，可以部署"
}
do_oci=0; do_mini=0
if want oci && precheck "${OCI}" "${OCI}"; then do_oci=1; fi
if want mini && precheck "${MINI}" "${MINI}"; then do_mini=1; fi

# 主機上的 repo 必須在 main，才快轉；不在 main 就是有人在那裡做別的事，不動它
ff_cmd() {  # $1 git 指令前綴
  printf '%s' "test \"\$($1 symbolic-ref --short HEAD)\" = main || { echo '主機上的 repo 不在 main，不動它' >&2; exit 1; }; $1 fetch -q origin main && $1 merge -q --ff-only ${sha}"
}

# ---- 3. Linux 主機 ----
if [ "${do_oci}" -eq 1 ]; then
  ogit="sudo -n git -c safe.directory=${OCI_REPO} -C ${OCI_REPO}"
  # 沿用已裝的學生資料／擴充包自動 pull 清單；沒裝過就留空，安裝腳本不會動 timer
  pull_dirs='$(sed -n "s/^ExecStart=.* pull //p" /etc/systemd/system/meeting-scribe-wiki-pull.service 2>/dev/null)'
  if [ "${dry_run}" -eq 1 ]; then
    echo "${OCI}：會把 ${OCI_REPO} 快轉到 ${sha:0:7}，再 sudo 跑 deploy/install-linux.sh（沿用現有的自動 pull 清單）"
  elif remote "${OCI}" oci-update "$(ff_cmd "${ogit}")" \
    && remote "${OCI}" oci-install "cd ${OCI_REPO} && sudo -n env MEETING_SCRIBE_WAIT_TRIES=0 MEETING_SCRIBE_PULL_DIRS=\"${pull_dirs}\" bash deploy/install-linux.sh"; then
    echo "${OCI}：安裝完成"
  else
    note_fail "${OCI}：更新或安裝失敗（看上面的訊息）"
    do_oci=0
  fi
fi

# ---- 4. Pages（API 先換好，網頁才換）----
if want pages; then
  if want oci && [ "${do_oci}" -eq 0 ]; then
    note_fail "Pages：${OCI} 沒有更新成功，網頁不換（不然網頁會比 API 新）"
  elif [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    note_fail "Pages：沒給 CLOUDFLARE_API_TOKEN，跳過沒部署（不想部署 Pages 就用 --only 拿掉 pages）"
  elif [ "${dry_run}" -eq 1 ]; then
    echo "Pages：會用 deploy-pages.sh 部署這版網頁"
  else
    api="${SCRIBE_API:-}"
    if [ -z "${api}" ] && [ -n "${OCI}" ]; then
      dns="$(remote "${OCI}" dns 'tailscale status --self --json' | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' || true)"
      [ -n "${dns}" ] && api="https://${dns}:9443"
    fi
    if [ -z "${api}" ]; then
      note_fail "Pages：沒設 SCRIBE_API，${OCI:+也問不到 ${OCI} 的 tailnet 名稱，}沒部署（設 SCRIBE_API 或 DEPLOY_OCI_HOST）"
    elif SCRIBE_API="${api}" bash "${here}/deploy-pages.sh"; then
      echo "Pages：部署完成"
    else
      note_fail "Pages：deploy-pages.sh 失敗"
    fi
  fi
fi

# ---- 5. Mac 主機（背景安裝＋輪詢：SSH 長命令會斷）----
if [ "${do_mini}" -eq 1 ]; then
  if [ "${dry_run}" -eq 1 ]; then
    echo "${MINI}：會把 repo 快轉到 ${sha:0:7}，背景跑 deploy/install-macmini.sh（紀錄 ${MINI_LOG}）"
  elif remote "${MINI}" mini-update "cd \"${MINI_REPO}\" && $(ff_cmd git)" \
    && remote "${MINI}" mini-start "cd \"${MINI_REPO}\" && echo running > ${MINI_RC} && (nohup sh -c 'env MEETING_SCRIBE_WAIT_TRIES=0 bash deploy/install-macmini.sh > ${MINI_LOG} 2>&1; echo \$? > ${MINI_RC}' </dev/null >/dev/null 2>&1 &)"; then
    rc=running; i=0
    while [ "${rc}" = running ] && [ "${i}" -lt "${POLL_TRIES}" ]; do
      i=$(( i + 1 ))
      sleep "${POLL_STEP}"
      rc="$(remote "${MINI}" mini-poll "cat ${MINI_RC}" 2>/dev/null || echo running)"
      [ -n "${rc}" ] || rc=running   # 結束碼正在寫入的瞬間會讀到空檔
    done
    remote "${MINI}" mini-log "tail -n 8 ${MINI_LOG}" 2>/dev/null | sed "s/^/  ${MINI}｜/" || true
    case "${rc}" in
      0) echo "${MINI}：安裝完成" ;;
      running) note_fail "${MINI}：等了 $(( POLL_TRIES * POLL_STEP )) 秒安裝還沒結束，看 ${MINI} 的 ${MINI_LOG}"; do_mini=0 ;;
      *) note_fail "${MINI}：安裝失敗（結束碼 ${rc}），看 ${MINI} 的 ${MINI_LOG}"; do_mini=0 ;;
    esac
  else
    note_fail "${MINI}：更新或啟動安裝失敗（看上面的訊息）"
    do_mini=0
  fi
fi

# ---- 6. 個人常錯字對照：Linux 主機 → Mac 主機 ----
if want corrections; then
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/meeting-scribe-deploy.XXXXXX")"
  trap 'rm -rf "${tmp}"' EXIT
  if ! remote "${OCI}" corr-read-oci "sudo -n cat ${OCI_CORR}" > "${tmp}/oci.json"; then
    note_fail "對照同步：讀不到 ${OCI} 的 corrections.json"
  elif ! remote "${MINI}" corr-read-mini "cat ${MINI_CORR} 2>/dev/null || echo '{}'" > "${tmp}/mini.json"; then
    note_fail "對照同步：讀不到 ${MINI} 的 corrections.json"
  else
    # same：一樣；copy：Mac 主機是 Linux 主機的子集，可以蓋；extra：Mac 主機有 Linux 主機沒有的，不蓋
    verdict="$(python3 -I - "${tmp}/oci.json" "${tmp}/mini.json" <<'PYEOF'
import json, sys
def pairs(p):
    d = json.load(open(p, encoding="utf-8"))
    if not isinstance(d, dict):
        raise SystemExit("bad")
    return {(k, w, r) for k in ("hints", "fixed") for w, r in d.get(k, [])}
try:
    o, m = pairs(sys.argv[1]), pairs(sys.argv[2])
except (ValueError, TypeError, SystemExit):
    print("bad"); sys.exit(0)
if o == m:
    print("same")
elif m <= o:
    print(f"copy {len(o - m)}")
else:
    print(f"extra {len(m - o)}")   # 只印組數：個人修正對可能含人名，不進終端機與記錄（#207）
PYEOF
)"
    case "${verdict}" in
      same) echo "對照同步：兩台一樣，不用動" ;;
      bad) note_fail "對照同步：有一台的 corrections.json 格式不對，沒有同步" ;;
      extra*) note_fail "對照同步：${MINI} 有 ${verdict#extra } 組 ${OCI} 沒有的對照，沒有覆蓋；先在 ${OCI} 的設定面板補上再跑" ;;
      copy*)
        if [ "${dry_run}" -eq 1 ]; then
          echo "對照同步：會把 ${OCI} 的對照複製到 ${MINI}（多 ${verdict#copy } 組，原檔先備份）"
        elif remote "${MINI}" corr-write "f=${MINI_CORR}; umask 077; cat > \"\$f.new\" && /usr/bin/python3 -I -c 'import json,sys; json.load(open(sys.argv[1]))' \"\$f.new\" && chmod 600 \"\$f.new\" && { [ ! -f \"\$f\" ] || cp -p \"\$f\" \"\$f.bak-\$(date +%Y%m%d%H%M%S)\"; } && mv \"\$f.new\" \"\$f\"" < "${tmp}/oci.json"; then
          echo "對照同步：已複製到 ${MINI}（多 ${verdict#copy } 組，原檔已備份）"
        else
          note_fail "對照同步：寫入 ${MINI} 失敗"
        fi ;;
    esac
  fi
fi

# ---- 7. 驗收：有部署的主機都要在這個 commit、跑這版網頁 ----
verify() {  # $1 名稱 $2 host $3 git 指令前綴
  local name="$1" host="$2" g="$3" h head
  h="$(remote "${host}" health 'curl -fsS -m 5 http://127.0.0.1:18095/healthz' 2>/dev/null || true)"
  head="$(remote "${host}" head "${g} rev-parse HEAD" 2>/dev/null || true)"
  if [ "$(printf '%s' "${h}" | health_field ok)" != true ]; then note_fail "${name}：部署後 /healthz 不正常"
  elif [ "$(printf '%s' "${h}" | health_field build)" != "${build}" ]; then note_fail "${name}：網頁版本是 $(printf '%s' "${h}" | health_field build)，不是 ${build}（服務可能沒重啟）"
  elif [ "${head}" != "${sha}" ]; then note_fail "${name}：repo 在 ${head:0:7}，不是 ${sha:0:7}"
  else echo "${name}：驗收通過（${sha:0:7}、網頁 ${build}）"; fi
}
if [ "${dry_run}" -eq 0 ]; then
  [ "${do_oci}" -eq 1 ] && verify "${OCI}" "${OCI}" "sudo -n git -c safe.directory=${OCI_REPO} -C ${OCI_REPO}"
  [ "${do_mini}" -eq 1 ] && verify "${MINI}" "${MINI}" "git -C \"${MINI_REPO}\""
fi

if [ -n "${failed}" ]; then
  echo "
沒有全部完成：${failed}" >&2
  exit 1
fi
echo "全部完成。"
