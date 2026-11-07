"""deploy/deploy-all.sh：一鍵部署 Linux 主機、Mac 主機、Pages（測試用 linux-host、mac-host 兩個假主機名稱）。

用假的 ssh 跑：每個遠端命令開頭有 `: step=<名稱>;`，假 ssh 把 (主機, 步驟) 記下來，照環境變數回答。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "deploy" / "deploy-all.sh"
sys.path.insert(0, str(ROOT))
import server  # noqa: E402

FAKE_SSH = r'''#!/usr/bin/env python3
import json, os, re, sys
args = sys.argv[1:]
while args and args[0] == "-o":
    args = args[2:]
host, cmd = args[0], args[1]
step = re.match(r": step=([\w-]+);", cmd).group(1)
stdin = sys.stdin.read() if step == "corr-write" else ""
with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"host": host, "step": step, "cmd": cmd, "stdin": stdin}) + "\n")
key = host.replace("-", "_").upper()
answers = {
    "health": os.environ.get("FAKE_HEALTH_" + key, json.dumps({"ok": True, "recording_idle_s": None, "build": os.environ["FAKE_BUILD"]})),
    "head": os.environ["FAKE_HEAD"],
    "mini-poll": os.environ.get("FAKE_MINI_RC", "0"),
    "dns": json.dumps({"Self": {"DNSName": "linux-host.example.ts.net."}}),
    "corr-read-oci": os.environ.get("FAKE_CORR_OCI", '{"hints": [], "fixed": []}'),
    "corr-read-mini": os.environ.get("FAKE_CORR_MINI", '{"hints": [], "fixed": []}'),
}
if step in os.environ.get("FAKE_FAIL", "").split(","):
    sys.exit(1)
if step in answers:
    print(answers[step])
'''


def git(*args, cwd):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", *args],
                          cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()


class DeployAllTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        origin, self.repo = self.tmp / "origin.git", self.tmp / "repo"
        git("init", "-q", "--bare", str(origin), cwd=self.tmp)
        git("init", "-q", str(self.repo), cwd=self.tmp)
        (self.repo / "deploy").mkdir()
        (self.repo / "web").mkdir()
        shutil.copy(SCRIPT, self.repo / "deploy" / "deploy-all.sh")
        shutil.copy(SCRIPT.parent / "build-pages.py", self.repo / "deploy" / "build-pages.py")
        shutil.copy(SCRIPT.parent / "load-env.sh", self.repo / "deploy" / "load-env.sh")
        (self.repo / "web" / "index.html").write_text("<html>v1</html>", encoding="utf-8")
        (self.repo / "web" / "shared").mkdir()
        (self.repo / "web" / "shared" / "mindmap.js").write_text("// v1", encoding="utf-8")
        git("add", ".", cwd=self.repo)
        git("commit", "-qm", "v1", cwd=self.repo)
        git("remote", "add", "origin", str(origin), cwd=self.repo)
        git("push", "-q", "origin", "main", cwd=self.repo)
        self.sha = git("rev-parse", "HEAD", cwd=self.repo)
        self.build = server.web_build(self.repo / "web")   # 和 build-pages.py --print-build 同一個算法
        self.log = self.tmp / "ssh.log"
        ssh = self.tmp / "fake-ssh"
        ssh.write_text(FAKE_SSH, encoding="utf-8")
        ssh.chmod(0o755)
        self.env = {k: v for k, v in os.environ.items() if k != "CLOUDFLARE_API_TOKEN"}
        self.env.update(DEPLOY_SSH=str(ssh), FAKE_LOG=str(self.log), FAKE_HEAD=self.sha, FAKE_BUILD=self.build,
                        DEPLOY_POLL_STEP="0", GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                        DEPLOY_OCI_HOST="linux-host", DEPLOY_MINI_HOST="mac-host",
                        CLOUDFLARE_ACCOUNT_ID="test-account",
                        MEETING_SCRIBE_DEPLOY_ENV=str(self.tmp / "no-deploy.env"))

    def run_deploy(self, *args, **env):
        return subprocess.run(["bash", str(self.repo / "deploy" / "deploy-all.sh"), *args],
                              env=dict(self.env, **env), capture_output=True, text=True, timeout=60)

    def steps(self):
        if not self.log.exists():
            return []
        return [json.loads(ln) for ln in self.log.read_text(encoding="utf-8").splitlines()]

    def step_names(self, host=None):
        return [s["step"] for s in self.steps() if host is None or s["host"] == host]

    def test_refuses_dirty_tree_before_touching_hosts(self):
        (self.repo / "web" / "index.html").write_text("<html>local edit</html>", encoding="utf-8")
        r = self.run_deploy("--only", "oci,mini")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("沒 commit 的改動", r.stderr)
        self.assertEqual(self.steps(), [])

    def test_a_target_without_its_host_stops_before_touching_anything(self):
        r = self.run_deploy("--only", "oci,mini", DEPLOY_OCI_HOST="")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("DEPLOY_OCI_HOST", r.stderr)
        self.assertEqual(self.steps(), [])
        r = self.run_deploy("--only", "corrections", DEPLOY_MINI_HOST="")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("DEPLOY_MINI_HOST", r.stderr)
        r = self.run_deploy("--only", "mini", DEPLOY_OCI_HOST="", DEPLOY_MINI_HOST="a;rm -rf x")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("主機名稱只能有", r.stderr)
        self.assertEqual(self.steps(), [])
        r = self.run_deploy("--only", "mini", DEPLOY_OCI_HOST="")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(set(s["host"] for s in self.steps()), {"mac-host"}, "只用 Mac 主機時不需要 Linux 主機")

    def test_hosts_come_from_deploy_env_and_the_environment_wins(self):
        env_file = self.tmp / "deploy.env"
        env_file.write_bytes("# 主機\r\nDEPLOY_OCI_HOST=file-linux\r\nDEPLOY_MINI_HOST=file-mac\r\nNOT_ALLOWED=x\r\n".encode())   # CRLF 也要讀對
        r = self.run_deploy("--only", "oci,mini", "--dry-run", DEPLOY_OCI_HOST="", DEPLOY_MINI_HOST="mac-env",
                            MEETING_SCRIBE_DEPLOY_ENV=str(env_file))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(set(s["host"] for s in self.steps()), {"file-linux", "mac-env"})

    def test_mac_repo_defaults_to_the_same_place_under_home(self):
        r = self.run_deploy("--only", "mini", DEPLOY_OCI_HOST="", HOME=str(self.tmp))
        self.assertEqual(r.returncode, 0, r.stderr)
        update = next(s["cmd"] for s in self.steps() if s["step"] == "mini-update")
        self.assertIn('cd "$HOME/repo" && ', update, "家目錄留給遠端展開，路徑加引號")
        self.log.unlink()
        r = self.run_deploy("--only", "mini", DEPLOY_OCI_HOST="", DEPLOY_MINI_REPO="/srv/my scribe")
        self.assertIn('cd "/srv/my scribe" && ', next(s["cmd"] for s in self.steps() if s["step"] == "mini-update"))

    def test_pages_without_an_account_stops_before_any_host_is_touched(self):
        r = self.run_deploy(CLOUDFLARE_API_TOKEN="x", CLOUDFLARE_ACCOUNT_ID="")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("CLOUDFLARE_ACCOUNT_ID", r.stderr)
        self.assertEqual(self.steps(), [])

    def test_refuses_untracked_files(self):
        (self.repo / "web" / "new.js").write_text("x", encoding="utf-8")
        r = self.run_deploy("--only", "oci")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(self.steps(), [])

    def test_refuses_commit_not_on_origin_main(self):
        (self.repo / "web" / "index.html").write_text("<html>v2</html>", encoding="utf-8")
        git("commit", "-qam", "v2", cwd=self.repo)
        r = self.run_deploy("--only", "oci,mini")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("不是 origin/main 最新的", r.stderr)
        self.assertEqual(self.steps(), [])

    def test_refuses_checkout_behind_origin_main(self):
        other = self.tmp / "other"
        git("clone", "-q", str(self.tmp / "origin.git"), str(other), cwd=self.tmp)
        (other / "web" / "index.html").write_text("<html>v2</html>", encoding="utf-8")
        git("commit", "-qam", "v2", cwd=other)
        git("push", "-q", "origin", "main", cwd=other)
        r = self.run_deploy("--only", "oci,mini,pages", CLOUDFLARE_API_TOKEN="x")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("不是 origin/main 最新的", r.stderr)
        self.assertEqual(self.steps(), [])

    def test_pages_waits_for_oci(self):
        r = self.run_deploy("--only", "oci,pages", FAKE_FAIL="oci-install", CLOUDFLARE_API_TOKEN="x")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Pages：linux-host 沒有更新成功，網頁不換", r.stderr)
        self.assertNotIn("dns", self.step_names(), "沒走到 Pages 部署")

    def test_mini_install_failure_and_timeout(self):
        r = self.run_deploy("--only", "mini", FAKE_MINI_RC="1")
        self.assertEqual(r.returncode, 1)
        self.assertIn("mac-host：安裝失敗（結束碼 1）", r.stderr)
        self.assertNotIn("head", self.step_names("mac-host"))
        self.log.unlink()
        for rc in ("running", ""):
            r = self.run_deploy("--only", "mini", FAKE_MINI_RC=rc, DEPLOY_POLL_TRIES="3")
            self.assertEqual(r.returncode, 1)
            self.assertIn("安裝還沒結束", r.stderr, repr(rc))
            self.assertEqual(self.step_names("mac-host").count("mini-poll"), 3, repr(rc))
            self.log.unlink()

    def test_dry_run_only_reads(self):
        r = self.run_deploy("--dry-run", "--only", "oci,mini,corrections",
                            FAKE_CORR_OCI='{"hints": [["a", "b"]], "fixed": []}')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sorted(set(self.step_names())), ["corr-read-mini", "corr-read-oci", "health"])
        self.assertIn("會把 /opt/meeting-scribe 快轉到", r.stdout)
        self.assertIn("會把 linux-host 的對照複製到 mac-host", r.stdout)

    def test_full_run_deploys_both_hosts_and_verifies(self):
        r = self.run_deploy("--only", "oci,mini")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.step_names("linux-host"), ["health", "oci-update", "oci-install", "health", "head"])
        self.assertEqual(self.step_names("mac-host"), ["health", "mini-update", "mini-start", "mini-poll", "mini-log", "health", "head"])
        update = next(s["cmd"] for s in self.steps() if s["step"] == "oci-update")
        self.assertIn(f"merge -q --ff-only {self.sha}", update)
        self.assertIn("symbolic-ref --short HEAD)\" = main", update)
        install = next(s["cmd"] for s in self.steps() if s["step"] == "oci-install")
        self.assertIn("MEETING_SCRIBE_WAIT_TRIES=0", install)
        self.assertIn("MEETING_SCRIBE_PULL_DIRS=", install)
        self.assertIn("全部完成", r.stdout)

    def test_recording_host_is_skipped_and_run_fails(self):
        busy = json.dumps({"ok": True, "recording_idle_s": 5, "build": self.build})
        r = self.run_deploy("--only", "oci,mini", FAKE_HEALTH_LINUX_HOST=busy)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("linux-host：有會議正在錄音", r.stderr)
        self.assertNotIn("oci-install", self.step_names("linux-host"))
        self.assertNotIn("oci-update", self.step_names("linux-host"))
        self.assertIn("mini-start", self.step_names("mac-host"), "另一台照樣部署")

    def test_quiet_recording_older_than_threshold_is_fine(self):
        quiet = json.dumps({"ok": True, "recording_idle_s": 600, "build": self.build})
        r = self.run_deploy("--only", "oci", FAKE_HEALTH_LINUX_HOST=quiet)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("oci-install", self.step_names("linux-host"))

    def test_verify_catches_stale_build(self):
        stale = json.dumps({"ok": True, "recording_idle_s": None, "build": "000000000000"})
        r = self.run_deploy("--only", "mini", FAKE_HEALTH_MAC_HOST=stale)
        self.assertEqual(r.returncode, 1)
        self.assertIn("mac-host：網頁版本是 000000000000", r.stderr)

    def test_failed_install_is_reported_per_host(self):
        r = self.run_deploy("--only", "oci,mini", FAKE_FAIL="oci-install")
        self.assertEqual(r.returncode, 1)
        self.assertIn("linux-host：更新或安裝失敗", r.stderr)
        self.assertNotIn("head", self.step_names("linux-host"))
        self.assertIn("mac-host：驗收通過", r.stdout)

    def test_pages_without_token_is_not_success(self):
        r = self.run_deploy("--only", "pages")
        self.assertEqual(r.returncode, 1)
        self.assertIn("沒給 CLOUDFLARE_API_TOKEN", r.stderr)

    def test_corrections_copy_backs_up_and_sends_oci_file(self):
        oci = '{"hints": [["a", "b"], ["c", "d"]], "fixed": []}'
        r = self.run_deploy("--only", "corrections", FAKE_CORR_OCI=oci, FAKE_CORR_MINI='{"hints": [["a", "b"]]}')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        write = [s for s in self.steps() if s["step"] == "corr-write"]
        self.assertEqual(len(write), 1)
        self.assertEqual(json.loads(write[0]["stdin"]), json.loads(oci))
        self.assertIn(".bak-", write[0]["cmd"])
        self.assertLess(write[0]["cmd"].index("json.load"), write[0]["cmd"].index("mv "), "寫壞的檔不能換上去")
        self.assertIn("chmod 600", write[0]["cmd"])

    def test_corrections_never_drop_mini_only_entries(self):
        r = self.run_deploy("--only", "corrections", FAKE_CORR_OCI='{"hints": [["a", "b"]]}',
                            FAKE_CORR_MINI='{"hints": [["a", "b"], ["思語", "詩妤"]]}')
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("思語", r.stderr, "個人修正對可能含人名，只印組數（#207）")
        self.assertNotIn("詩妤", r.stderr)
        self.assertIn("有 1 組", r.stderr)
        self.assertNotIn("corr-write", self.step_names())

    def test_corrections_same_means_no_write(self):
        same = '{"hints": [["a", "b"]], "fixed": []}'
        r = self.run_deploy("--only", "corrections", FAKE_CORR_OCI=same, FAKE_CORR_MINI=same)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("corr-write", self.step_names())

    def test_rejects_unknown_target(self):
        r = self.run_deploy("--only", "oci,prod")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.steps(), [])

    def test_script_never_echoes_token(self):
        src = SCRIPT.read_text(encoding="utf-8")
        self.assertNotRegex(src, r"echo[^\n]*\$\{?CLOUDFLARE_API_TOKEN")
        self.assertNotRegex(src, r"\bnpx\b")


if __name__ == "__main__":
    unittest.main()
