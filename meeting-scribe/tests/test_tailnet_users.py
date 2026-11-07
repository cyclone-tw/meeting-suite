"""安裝時預設只放行安裝者自己的 tailnet 帳號（#209）：deploy/ensure-tailnet-users.py 與兩支安裝腳本。"""
import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / "deploy" / "ensure-tailnet-users.py"


def status(login="me@example.com", uid=42, tags=None, drop_user=False):
    self_node = {"DNSName": "host.tail1234.ts.net.", "UserID": uid}
    if tags:
        self_node["Tags"] = tags
    users = {} if drop_user else {str(uid): {"LoginName": login}}
    return json.dumps({"Self": self_node, "User": users})


class EnsureTailnetUsersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = Path(self.tmp.name) / "config.json"

    def run_helper(self, stdin, config=None):
        if config is not None:
            self.cfg.write_text(config if isinstance(config, str) else json.dumps(config), encoding="utf-8")
            self.cfg.chmod(0o600)
        return subprocess.run([sys.executable, "-I", str(HELPER), str(self.cfg)], input=stdin, capture_output=True, text=True)

    def data(self):
        return json.loads(self.cfg.read_text(encoding="utf-8"))

    def test_fills_the_installers_own_login_when_missing(self):
        r = self.run_helper(status("Me@Example.com"), {"host_label": "x", "max_concurrent_agents": 2})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.data()["tailscale_users"], ["me@example.com"])
        self.assertEqual(self.data()["host_label"], "x", "其他設定不動")
        self.assertEqual(stat.S_IMODE(self.cfg.stat().st_mode), 0o600)

    def test_keeps_an_existing_choice_even_an_empty_list(self):
        for existing in (["boss@example.com"], []):
            r = self.run_helper(status(), {"tailscale_users": existing})
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(self.data()["tailscale_users"], existing, "管理者已經決定的不覆蓋（空清單＝刻意不限制）")

    def test_tagged_or_unknown_identity_writes_nothing_and_says_why(self):
        for stdin in (status(tags=["tag:server"]), status(drop_user=True), "not json", "{}"):
            r = self.run_helper(stdin, {"host_label": "x"})
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotIn("tailscale_users", self.data(), stdin[:30])
            self.assertIn("tailscale_users", r.stdout + r.stderr, "要說明沒有設定與怎麼補")

    def test_broken_config_is_an_error_and_untouched(self):
        r = self.run_helper(status(), "{broken")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.cfg.read_text(encoding="utf-8"), "{broken")

    def test_login_with_odd_characters_is_refused(self):
        for bad in ("a b@example.com", "x\ny@example.com", ""):
            self.run_helper(status(bad), {})
            self.assertNotIn("tailscale_users", self.data(), repr(bad))


class InstallersCallTheHelperTest(unittest.TestCase):
    def test_both_installers_call_it_after_the_config_exists(self):
        for name in ("install-linux.sh", "install-macmini.sh"):
            text = (ROOT / "deploy" / name).read_text(encoding="utf-8")
            self.assertIn("ensure-tailnet-users.py", text, name)
            self.assertLess(text.index('CONFIG="'), text.index("ensure-tailnet-users.py"), name)
            self.assertIn("status --self --json", text[text.index("ensure-tailnet-users.py") - 300:text.index("ensure-tailnet-users.py") + 300], name)


def installer_block(name):
    """安裝腳本裡「預設只放行安裝者」那一段（從標記註解到下一個空行）。"""
    text = (ROOT / "deploy" / name).read_text(encoding="utf-8")
    start = text.index("# 預設只放行安裝者自己的 tailnet 帳號（#209）")
    return text[start:text.index("\n\n", start)]


class InstallerBlockUnderPipefailTest(unittest.TestCase):
    """安裝腳本開著 set -euo pipefail：tailscale 沒登入、或 helper 不讀 stdin 就結束，都不能讓整個安裝中止。"""

    def run_block(self, name, fake_tailscale, config):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / "config.json"
            cfg.write_text(json.dumps(config), encoding="utf-8")
            fake = Path(d) / "tailscale"
            fake.write_text("#!/bin/sh\n" + fake_tailscale, encoding="utf-8")
            fake.chmod(0o755)
            script = "\n".join([
                "set -euo pipefail",
                f'TS="{fake}"; PYTHON="{sys.executable}"; REPO="{ROOT}"; CONFIG="{cfg}"',
                'as_user() { "$@"; }',
                f'tailscale() {{ "{fake}" "$@"; }}',
                installer_block(name),
                'echo reached-the-end',
            ])
            r = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
            return r, json.loads(cfg.read_text(encoding="utf-8"))

    def test_tailscale_not_logged_in_does_not_abort_the_install(self):
        for name in ("install-linux.sh", "install-macmini.sh"):
            r, cfg = self.run_block(name, 'echo "Logged out." >&2; exit 1\n', {"host_label": "x"})
            self.assertEqual(r.returncode, 0, f"{name}: {r.stderr}")
            self.assertIn("reached-the-end", r.stdout, name)
            self.assertNotIn("tailscale_users", cfg, name)

    def test_existing_choice_with_big_tailscale_output_does_not_sigpipe(self):
        # 設定檔已有 tailscale_users：helper 不讀 stdin 就結束；tailscale 還在寫一大段輸出時不能因此回 141
        big = 'i=0; while [ $i -lt 4000 ]; do echo "                                                  filler line $i"; i=$((i+1)); done; exit 0\n'
        for name in ("install-linux.sh", "install-macmini.sh"):
            r, cfg = self.run_block(name, big, {"tailscale_users": ["boss@example.com"]})
            self.assertEqual(r.returncode, 0, f"{name}: {r.stderr}")
            self.assertEqual(cfg["tailscale_users"], ["boss@example.com"], name)


if __name__ == "__main__":
    unittest.main()
