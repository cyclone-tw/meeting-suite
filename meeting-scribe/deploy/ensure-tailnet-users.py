#!/usr/bin/env python3
"""安裝時把「只放行安裝者自己的 tailnet 帳號」寫進設定檔的 tailscale_users（#209）。

用法：tailscale status --self --json | python3 -I deploy/ensure-tailnet-users.py <config.json>

- 設定檔已有 tailscale_users（含空清單）就不動：管理者已經決定了。空清單＝刻意不限制。
- 沒有就填入這台機器的 tailnet 登入帳號（Self.UserID → User[...].LoginName）。
- 這台是 tagged 裝置、或讀不到帳號：不寫，說明原因與手動設定的方法（安裝照常繼續）。
- 設定檔壞掉：回錯誤，不改檔。
只用標準函式庫。
"""
import json
import os
import re
import sys
import tempfile

LOGIN = re.compile(r"^[^\s@]+@[^\s@]+$")
HOW = '要限制使用者，在 config.json 設 "tailscale_users": ["你的 tailnet 帳號"]（docs/deploy-linux.md）'


def own_login(status_text):
    """這台機器的 tailnet 登入帳號；tagged 裝置、讀不到、格式怪都回 None。"""
    try:
        status = json.loads(status_text)
        node = status["Self"]
        if node.get("Tags"):
            return None
        login = status["User"][str(node["UserID"])]["LoginName"]
    except (ValueError, KeyError, TypeError, AttributeError):
        return None
    login = str(login).strip().lower()
    return login if LOGIN.match(login) else None


def main(argv, stdin):
    if len(argv) != 2:
        print("用法：ensure-tailnet-users.py <config.json>", file=sys.stderr)
        return 2
    path = argv[1]
    status_text = stdin.read()   # 先讀完：不管後面走哪條路，都不讓上游的 tailscale 寫到關掉的管道
    try:
        with open(path, encoding="utf-8") as fh:
            config = json.load(fh)
    except (OSError, ValueError) as e:
        print(f"tailscale_users：讀不到設定檔 {path}（{type(e).__name__}），沒有改", file=sys.stderr)
        return 1
    if not isinstance(config, dict):
        print(f"tailscale_users：{path} 不是 JSON 物件，沒有改", file=sys.stderr)
        return 1
    if "tailscale_users" in config:
        print("tailscale_users：沿用設定檔裡的設定")
        return 0
    login = own_login(status_text)
    if not login:
        print(f"tailscale_users：讀不到這台的 tailnet 登入帳號（tagged 裝置或 tailscale 沒回應），沒有設定。目前 tailnet 內每台裝置都能使用。{HOW}")
        return 0
    config["tailscale_users"] = [login]
    # 原子寫入、權限 600（設定檔可能含金鑰檔路徑與 Drive 位置）
    fd, tmp = tempfile.mkstemp(prefix=".config-", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(config, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    print(f"tailscale_users：已設為 {login}（只有這個帳號的裝置能使用；{HOW}）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv, sys.stdin))
