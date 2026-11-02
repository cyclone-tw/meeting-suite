# 讀部署設定（不進 git）：~/.config/meeting-scribe/deploy.env，一行一個 KEY=VALUE，# 開頭是註解。
# 值照字面用：不要加引號，也不要在行尾寫註解。
# 只認下面列的鍵，只補環境變數沒給的值（環境變數優先）。MEETING_SCRIBE_DEPLOY_ENV 可以改位置。
# 用法：在部署腳本裡 `. "${here}/load-env.sh"`。
deploy_env="${MEETING_SCRIBE_DEPLOY_ENV:-${HOME}/.config/meeting-scribe/deploy.env}"
if [ -f "${deploy_env}" ]; then
  while IFS='=' read -r key value; do
    case "${key}" in
      DEPLOY_OCI_HOST|DEPLOY_MINI_HOST|DEPLOY_OCI_REPO|DEPLOY_MINI_REPO|SCRIBE_API|CLOUDFLARE_ACCOUNT_ID|PAGES_PROJECT|INFO_PROJECT)
        value="${value%$'\r'}"   # 在 Windows 編輯過的檔
        [ -n "${!key:-}" ] || export "${key}=${value}" ;;
    esac
  done < <(grep -E '^[A-Z_]+=' "${deploy_env}" || true)
fi
