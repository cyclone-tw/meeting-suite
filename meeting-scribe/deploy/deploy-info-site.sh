#!/usr/bin/env bash
# 把公開說明站（deploy/info-site/）部署到 Cloudflare Pages 專案（預設 scribe-info）。
# Google OAuth 正式版（External）的品牌頁要填公開的首頁與隱私權政策網址，這個站就是給它用的：
#   https://<你的網域>/（首頁）、https://<你的網域>/privacy/（隱私權政策）；網域在 Cloudflare 綁到這個 Pages 專案
# 這個站不放 Access（Google 要能直接打開），所以只放說明文字：不放程式、不放個人 email 或任何個資。
# 改了 deploy/info-site/ 底下的檔就要重跑一次。
#
# 用法：
#   CLOUDFLARE_API_TOKEN="$(cat ~/.config/cloudflare/deploy.token)" bash deploy/deploy-info-site.sh
#   bash deploy/deploy-info-site.sh --dry-run  # 只列出要放上去的檔，不上傳（不需要 token）
#
# 環境變數：
#   CLOUDFLARE_API_TOKEN   必填（--dry-run 除外）。由呼叫端提供；這支腳本不讀檔、不印出、不寫進任何檔案
#   CLOUDFLARE_ACCOUNT_ID  必填（--dry-run 除外）。自己的 Cloudflare 帳號 ID，可以寫在 ~/.config/meeting-scribe/deploy.env
#   INFO_PROJECT           預設 scribe-info
#   INFO_BRANCH            預設 main（Pages 專案的 production branch；換別的名稱會變成 preview 部署）
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

project="${INFO_PROJECT:-scribe-info}"
branch="${INFO_BRANCH:-main}"
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

out="$(mktemp -d "${TMPDIR:-/tmp}/scribe-info.XXXXXX")"
cleanup() { rm -rf "${out}"; }
trap cleanup EXIT

# 複製到暫存資料夾再部署：wrangler 不會讀到 repo 裡任何設定檔，也不會把 .wrangler 快取留在 repo
cp -R "${here}/info-site" "${out}/site"

# 只放靜態檔：有 Functions 或 _worker.js 就停下；也不放 script
if [ -e "${out}/site/_worker.js" ] || [ -d "${out}/site/functions" ]; then
  echo "info-site 出現 _worker.js 或 functions/，不部署" >&2
  exit 1
fi
if grep -rqi '<script' "${out}/site"; then
  echo "info-site 不放 script，不部署" >&2
  exit 1
fi

if [ "${dry_run}" -eq 1 ]; then
  (cd "${out}/site" && find . -type f | sort)
  exit 0
fi

commit="$(git -C "${root}" rev-parse HEAD 2>/dev/null || echo unknown)"
dirty=false
if [ -n "$(git -C "${root}" status --porcelain -- deploy/info-site 2>/dev/null)" ]; then
  dirty=true
fi

cd "${out}"
pnpm dlx "${wrangler}" pages deploy "${out}/site" \
  --project-name "${project}" \
  --branch "${branch}" \
  --commit-hash "${commit}" \
  --commit-message "scribe-info ${commit:0:7}" \
  --commit-dirty="${dirty}"
