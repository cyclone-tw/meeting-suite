"""web/shared/ 共用元件（#157）的 JavaScript 測試：用 node 跑 tests/shared/*.test.mjs。這台沒有 node 就略過。"""
import shutil
import subprocess
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class SharedJsTest(unittest.TestCase):
    def test_shared_components(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("這台沒有 node")
        files = sorted(str(p) for p in (HERE / "shared").glob("*.test.mjs"))
        self.assertTrue(files, "tests/shared/ 底下要有測試")
        r = subprocess.run([node, "--test", *files], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-2000:])

    def test_extra_file_names_match_server(self):
        # 延伸的檔名（#166）：App 由伺服器取、工作室由 RecapFiles 取，兩邊要一樣
        node = shutil.which("node")
        if not node:
            self.skipTest("這台沒有 node")
        import json
        import sys
        sys.path.insert(0, str(HERE.parent))
        import server
        labels = ["視角回饋（家長）", "a/b:c*..", "summary", "Summary", "視角回饋（家長）", "..", "  有空白  ", "😀" * 90, "x\x07y", "\x1cabc", "\x85abc", "\ufeffabc", "\u3000全形空白\u3000", "\u2028分隔", "空"]
        extras = [{"label": x, "markdown": "" if x == "空" else "內容"} for x in labels]
        taken = ["transcript.txt", "summary.md", "minutes.md", "mindmap.md"]
        js = (HERE.parent / "web" / "shared" / "recap-files.js").as_posix()
        code = ("const R = require(process.argv[1]); const [extras, taken] = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
                "console.log(JSON.stringify(R.extraFiles(extras, { taken }).map((f) => f.file)))")
        r = subprocess.run([node, "-e", code, js], input=json.dumps([extras, taken]), capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), list(server.Handler._extra_files(None, extras, taken)), "Python 與 JS 的延伸檔名要一樣")


if __name__ == "__main__":
    unittest.main()
