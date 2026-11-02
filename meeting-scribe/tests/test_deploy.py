"""部署檔（#120）：學生資料自動 pull 的 systemd unit、install-linux.sh 的路徑檢查、公開說明站。"""
import os
import re
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy"
INFO = DEPLOY / "info-site"


def unit_lines(path):
    return [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.startswith("#")]


def git(*args, cwd=None):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", *args],
                   cwd=cwd, env=env, check=True, capture_output=True)


class PullUnitTest(unittest.TestCase):
    def test_service_keeps_root_home_and_oneshot(self):
        lines = unit_lines(DEPLOY / "meeting-scribe-wiki-pull.service.in")
        self.assertIn("Type=oneshot", lines)
        # 沒有 HOME 的話 git 讀不到 root 的 gh credential helper 與 ssh 別名
        self.assertIn("Environment=HOME=/root", lines)
        self.assertIn("TimeoutStartSec=120", lines)
        execs = [ln for ln in lines if ln.startswith("ExecStart=")]
        self.assertEqual(len(execs), 1)
        self.assertTrue(execs[0].endswith(" @DIRS@"))

    def test_timer_schedule(self):
        lines = unit_lines(DEPLOY / "meeting-scribe-wiki-pull.timer.in")
        for want in ("OnBootSec=2min", "OnUnitActiveSec=15min", "RandomizedDelaySec=60", "WantedBy=timers.target"):
            self.assertIn(want, lines)

    def test_exec_pulls_every_dir_even_if_one_fails(self):
        execs = [ln for ln in unit_lines(DEPLOY / "meeting-scribe-wiki-pull.service.in") if ln.startswith("ExecStart=")]
        # systemd 把 $$ 換成 $；其餘照 shell 的引號規則切
        argv = shlex.split(execs[0][len("ExecStart="):].replace("$$", "$"))
        self.assertEqual(argv[:2], ["/bin/sh", "-c"])
        self.assertEqual(argv[-1], "@DIRS@")
        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            up, good, broken = t / "up", t / "good", t / "not-a-repo"
            git("init", "-q", str(up))
            (up / "a.md").write_text("1", encoding="utf-8")
            git("add", ".", cwd=up)
            git("commit", "-qm", "1", cwd=up)
            git("clone", "-q", str(up), str(good))
            (up / "a.md").write_text("2", encoding="utf-8")
            git("commit", "-qam", "2", cwd=up)
            broken.mkdir()
            env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
            run = lambda dirs: subprocess.run(argv[:-1] + dirs, env=env, capture_output=True)  # noqa: E731
            r = run([str(broken), str(good)])
            self.assertEqual(r.returncode, 1, "有一個失敗，這次就要算失敗")
            self.assertEqual((good / "a.md").read_text(encoding="utf-8"), "2", "前面失敗了，後面的還是要 pull")
            self.assertEqual(run([str(good)]).returncode, 0)


class InstallPullDirsTest(unittest.TestCase):
    """install-linux.sh 裡檢查 MEETING_SCRIBE_PULL_DIRS 的那一段，單獨拿出來跑。"""

    @classmethod
    def setUpClass(cls):
        src = (DEPLOY / "install-linux.sh").read_text(encoding="utf-8")
        start = src.index("PULL_DIRS=()\n")
        end = src.index("\nfi\n", start) + len("\nfi\n")
        cls.block = "set -euo pipefail\n" + src[start:end] + 'printf "%s\\n" "${#PULL_DIRS[@]}:${PULL_DIRS[*]:-}"\n'

    def check(self, value):
        env = dict(os.environ)
        env.pop("MEETING_SCRIBE_PULL_DIRS", None)
        if value is not None:
            env["MEETING_SCRIBE_PULL_DIRS"] = value
        return subprocess.run(["bash", "-c", self.block], env=env, capture_output=True, text=True)

    def test_unset_means_nothing_to_do(self):
        for value in (None, "", "  "):
            r = self.check(value)
            self.assertEqual((r.returncode, r.stdout.strip()), (0, "0:"), value)

    def test_accepts_git_checkouts_split_on_whitespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / "wiki-students", Path(tmp) / "packs"
            git("init", "-q", str(a))
            git("init", "-q", str(b))
            r = self.check(f" {a}\n\t{b} ")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout.strip(), f"2:{a} {b}")

    def test_rejects_bad_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            plain = Path(tmp) / "plain"
            plain.mkdir()
            for value in ("opt/wiki", "/opt/*", str(plain)):
                r = self.check(value)
                self.assertEqual(r.returncode, 1, value)
            # 就算是 git checkout，路徑裡有會弄壞 unit 或 sed 的字元、有 .. 也不收
            for name in ("w;k", "w@k", "w%k", "w$k", "w|k", "w'k"):
                repo = Path(tmp) / name
                git("init", "-q", str(repo))
                r = self.check(str(repo))
                self.assertEqual(r.returncode, 1, name)
                self.assertIn("只能有英數", r.stderr, name)
            git("init", "-q", str(Path(tmp) / "ok"))
            for value in (f"{tmp}/ok/../ok", f"{tmp}/ok/.."):
                self.assertEqual(self.check(value).returncode, 1, value)
            self.assertEqual(self.check(f"{tmp}/ok").returncode, 0)

    def test_install_block_is_guarded(self):
        src = (DEPLOY / "install-linux.sh").read_text(encoding="utf-8")
        install = src.index('install -m 644 -o root -g root "${pull_tmp}"')
        guard = src.rindex('if [ "${#PULL_DIRS[@]}" -gt 0 ]; then', 0, install)
        self.assertNotIn("\nfi\n", src[guard:install], "寫 pull unit 只能在有設 MEETING_SCRIBE_PULL_DIRS 時")


class InfoSiteTest(unittest.TestCase):
    def files(self):
        return sorted(p for p in INFO.rglob("*") if p.is_file())

    def test_pages_exist(self):
        self.assertEqual([p.relative_to(INFO).as_posix() for p in self.files()], ["index.html", "privacy/index.html", "style.css"])
        self.assertIn('href="/privacy/"', (INFO / "index.html").read_text(encoding="utf-8"))

    def test_no_personal_data_or_scripts(self):
        email = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+")
        for p in self.files():
            text = p.read_text(encoding="utf-8")
            self.assertIsNone(email.search(text), f"{p.name} 不能有 email")
            self.assertNotRegex(text.lower(), r"<script|<iframe|ts\.net|cloudflareaccess", p.name)
            # 只連自己的檔；外部只允許撤銷授權的 Google 帳戶頁
            for url in re.findall(r'(?:href|src)="([^"]+)"', text):
                self.assertTrue(url.startswith("/") or url == "https://myaccount.google.com/permissions", f"{p.name}: {url}")

    def test_deploy_script_dry_run_lists_files_without_token(self):
        env = {k: v for k, v in os.environ.items() if k not in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")}
        env["MEETING_SCRIBE_DEPLOY_ENV"] = os.devnull + ".none"
        r = subprocess.run(["bash", str(DEPLOY / "deploy-info-site.sh"), "--dry-run"], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.split(), ["./index.html", "./privacy/index.html", "./style.css"])
        r = subprocess.run(["bash", str(DEPLOY / "deploy-info-site.sh")], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("CLOUDFLARE_API_TOKEN", r.stderr)
        r = subprocess.run(["bash", str(DEPLOY / "deploy-info-site.sh")], env=dict(env, CLOUDFLARE_API_TOKEN="x"), capture_output=True, text=True)
        self.assertEqual(r.returncode, 2, "沒有自己的 Cloudflare 帳號 ID 就不部署（repo 不帶任何人的帳號）")
        self.assertIn("CLOUDFLARE_ACCOUNT_ID", r.stderr)

    def test_deploy_script_pins_wrangler_and_project(self):
        src = (DEPLOY / "deploy-info-site.sh").read_text(encoding="utf-8")
        self.assertIn('wrangler@${WRANGLER_VERSION:-4.152.0}', src)
        self.assertIn('pnpm dlx "${wrangler}" pages deploy', src)
        self.assertIn('project="${INFO_PROJECT:-scribe-info}"', src)
        self.assertNotRegex(src, r"\bnpx\b|echo[^\n]*CLOUDFLARE_API_TOKEN\}")


if __name__ == "__main__":
    unittest.main()
