#!/usr/bin/env bash
# 把網頁部署到 Cloudflare Pages：只放靜態檔，不用 Functions、沒有 _worker.js。
# API 留在主機（tailnet-only 的 tailscale serve），主機的 config cors_origins 要列出 Pages 的網址。
#
# 用法：
#   CLOUDFLARE_API_TOKEN="$(cat ~/.config/cloudflare/deploy.token)" \
#   SCRIBE_API=https://<主機>.<tailnet>.ts.net:9443 \
#   bash deploy/deploy-pages.sh            # 部署到正式網址（production branch main）
#   bash deploy/deploy-pages.sh --dry-run  # 只打包、印出內容，不上傳（不需要 token）
#
# 環境變數：
#   SCRIBE_API             必填。主機 API 的來源（https://主機[:埠]，不能有路徑）
#   CLOUDFLARE_API_TOKEN   必填（--dry-run 除外）。由呼叫端提供；這支腳本不讀檔、不印出、不寫進任何檔案
#   CLOUDFLARE_ACCOUNT_ID  必填（--dry-run 除外）。自己的 Cloudflare 帳號 ID，可以寫在 ~/.config/meeting-scribe/deploy.env
#   PAGES_PROJECT          預設 meeting-scribe
#   PAGES_BRANCH           預設 main（Pages 專案的 production branch；換別的名稱會變成 preview 部署）
#   WRANGLER_VERSION       預設 4.152.0
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/.." && pwd)"
. "${here}/load-env.sh"
dry_run=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run) dry_run=1 ;;
    *) echo "不認得的參數：${arg}" >&2; exit 2 ;;
  esac
done

: "${SCRIBE_API:?要設 SCRIBE_API（主機 API 的來源，例如 https://<主機>.<tailnet>.ts.net:9443）}"
project="${PAGES_PROJECT:-meeting-scribe}"
branch="${PAGES_BRANCH:-main}"
wrangler="wrangler@${WRANGLER_VERSION:-4.152.0}"

if [ "${dry_run}" -eq 0 ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "要設 CLOUDFLARE_API_TOKEN（由呼叫端提供，不要寫進檔案）" >&2
  exit 2
fi
if [ "${dry_run}" -eq 0 ] && [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "要設 CLOUDFLARE_ACCOUNT_ID（自己的 Cloudflare 帳號 ID；可以寫在 ${deploy_env}）" >&2
  exit 2
fi
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"

out="$(mktemp -d "${TMPDIR:-/tmp}/meeting-scribe-pages.XXXXXX")"
cleanup() { rm -rf "${out}"; }
trap cleanup EXIT

python3 -I "${here}/build-pages.py" --api "${SCRIBE_API}" --out "${out}/site"

# 只放靜態檔：有 Functions 或 _worker.js 就停下，不部署
if [ -e "${out}/site/_worker.js" ] || [ -d "${out}/site/functions" ]; then
  echo "打包結果出現 _worker.js 或 functions/，不部署" >&2
  exit 1
fi

if [ "${dry_run}" -eq 1 ]; then
  (cd "${out}/site" && find . -type f | sort)
  echo "--- _headers"
  cat "${out}/site/_headers"
  exit 0
fi

commit="$(git -C "${root}" rev-parse HEAD 2>/dev/null || echo unknown)"
dirty=false
if [ -n "$(git -C "${root}" status --porcelain -- web deploy 2>/dev/null)" ]; then
  dirty=true
fi

# 在暫存資料夾執行：wrangler 不會讀到 repo 裡任何設定檔，也不會把 .wrangler 快取留在 repo
cd "${out}"
pnpm dlx "${wrangler}" pages deploy "${out}/site" \
  --project-name "${project}" \
  --branch "${branch}" \
  --commit-hash "${commit}" \
  --commit-message "meeting-scribe ${commit:0:7}" \
  --commit-dirty="${dirty}"
