"""e2e 用的測試服務：真的 server.py，只把 Claude、本機 ASR worker、模型快取換成假的，
Drive 根目錄、暫存、修正清單都放在 WORKDIR；Redmine、Soniox 非即時 API、Google OAuth／Drive（#107）也換成假的，擴充包用 tests/fake_pack.py 產生的假包。同一個 WORKDIR 重開服務（模擬重啟）時資料還在。

用法：python3 -I tests/e2e/serve.py PORT WORKDIR
"""
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import server  # noqa: E402
from fake_redmine import KEY, FakeRedmine  # noqa: E402
from fake_soniox import KEY as SONIOX_KEY, FakeSoniox  # noqa: E402
from test_local_asr import FAKE, make_hub  # noqa: E402
from fake_pack import make_pack, make_students  # noqa: E402
from fake_google import CLIENT_ID as GOOGLE_CLIENT_ID, FakeGoogle  # noqa: E402

port, work = sys.argv[1], Path(sys.argv[2])
(work / "drive").mkdir(parents=True, exist_ok=True)
# 假 Redmine（#82）跟著服務一起開；網址寫在 WORKDIR/redmine-url，情境用它查收到的任務
redmine = FakeRedmine().start()
(work / "redmine-url").write_text(redmine.url, encoding="utf-8")
(work / "redmine-key").write_text(KEY, encoding="ascii")
# Drive 瀏覽器直傳（#107）：WORKDIR/drive-browser 存在就設 drive_mode = browser，並開假的 Google OAuth／Drive；
# 檔案內容是允許跳回的 redirect_uri（JSON 清單，空的就是這台自己的 /oauth/）；網址寫在 WORKDIR/google-url
browser_drive = (work / "drive-browser").exists()
if browser_drive:
    uris = json.loads((work / "drive-browser").read_text(encoding="utf-8") or "[]") or [f"http://127.0.0.1:{port}/oauth/"]
    google = FakeGoogle(uris).start()
    (work / "google-url").write_text(google.url, encoding="utf-8")
config = work / "config.json"
config.write_text(json.dumps({
    "drive_roots": {"t": {"label": "測試 Drive", "path": str(work / "drive")}},
    "redmine": {"api_url": redmine.url, "public_url": redmine.url, "key_file": str(work / "redmine-key"),
                "project": "student-meetings", "assignee": 1},
    # 假擴充包（#97）：測試用的表單與會議紀錄模板，不碰任何客製的範本
    "packs": [str(make_pack(work / "pack"))],
    "students_dir": str(make_students(work / "students")),
    "students_label": "README.md",
    # 共用用詞正本（#140）：情境在 WORKDIR/vocabulary.md 寫一份才有，沒有就照舊用 config/glossary.md
    "vocabulary_files": [str(work / "vocabulary.md")],
    # 頁面提示裡的主機名稱（#170）
    "host_label": "測試主機",
    # client 模式（#105）：WORKDIR/client-mode 存在就讓轉錄金鑰放在瀏覽器
    **({"asr_key_mode": "client"} if (work / "client-mode").exists() else {}),
    # 網頁放 Cloudflare Pages（#106）：WORKDIR/cors-origins 寫 JSON 清單就設成 cors_origins
    **({"cors_origins": json.loads((work / "cors-origins").read_text(encoding="utf-8"))} if (work / "cors-origins").exists() else {}),
    **({"drive_mode": "browser", "google_client_id": GOOGLE_CLIENT_ID} if browser_drive else {}),
}), encoding="utf-8")
# 假 Soniox 非即時 API（#90 匯入檔案用）；金鑰用假的，不會碰到鑰匙圈裡真的 Soniox 金鑰
soniox = FakeSoniox().start()
server.SONIOX_API = soniox.url
server.SONIOX_POLL_S = 0.2
hf = work / "hf"
if not hf.exists():
    hf.mkdir()
    make_hub(hf)

server.Handler.hf_hub = hf
# 慢線路（#102）：WORKDIR/slow-vendor 寫秒數就延遲 vendor 檔；有 WORKDIR/fail-vendor 就回 503
_do_get = server.Handler.do_GET


def do_get(self):
    if self.path.startswith("/vendor/"):
        if (work / "fail-vendor").exists():
            self._json(503, {"error": "e2e"})
            return
        slow = work / "slow-vendor"
        if slow.exists():
            time.sleep(float(slow.read_text(encoding="utf-8")))
    _do_get(self)


server.Handler.do_GET = do_get
server.asr_python = lambda: Path(sys.executable)
server.ASR_WORKER.command = FAKE
fake_claude = [sys.executable, str(ROOT / "tests" / "fake_claude.py")]
server.claude_command = lambda *a, **k: fake_claude
server.Handler.agent_ready = staticmethod(lambda: True)
os.environ.update({
    "MEETING_SCRIBE_PORT": port,
    "MEETING_SCRIBE_CONFIG": str(config),
    "MEETING_SCRIBE_DRAFTS": str(work / "drafts"),
    "MEETING_SCRIBE_CORRECTIONS": str(work / "corrections.json"),
    "SONIOX_API_KEY": SONIOX_KEY,
    # 假 Claude 每則回覆前等 WORKDIR/claude-delay 寫的秒數（沒有這個檔就不等，#126）
    "FAKE_DELAY_FILE": str(work / "claude-delay"),
})
server.main()
