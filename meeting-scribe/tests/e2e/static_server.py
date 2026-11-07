"""e2e 用的靜態檔伺服器（Pages 情境）：python3 -I tests/e2e/static_server.py PORT DIR

不用 `python -m http.server`：它綁埠時會做反向名稱查詢（socket.getfqdn），在 GitHub 的 macOS 機器上卡約 35 秒（#211）。"""
import functools
import http.server
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nodns import NoDnsServer  # noqa: E402

port, directory = int(sys.argv[1]), sys.argv[2]
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
NoDnsServer(("127.0.0.1", port), handler).serve_forever()
