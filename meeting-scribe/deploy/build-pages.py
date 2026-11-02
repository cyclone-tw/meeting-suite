"""把 web/ 打包成可以放 Cloudflare Pages 的靜態網站（#106）：網頁從 Pages 來，API 留在主機。

用法：python3 -I deploy/build-pages.py --api https://<主機>.<tailnet>.ts.net:9443 --out <空的資料夾>

做的事（只用標準函式庫）：
- 複製 web/ 底下的網頁、圖示、manifest 與 vendor 檔（vendor 跟網頁一起放 Pages，不從主機拿）；不複製 .md。
- index.html：<meta name="scribe-api"> 填入主機 API 的來源，CSP 的 connect-src 加上它；版本代碼換成這版的雜湊。
- build.txt：這版的雜湊，開著的頁面拿它判斷 Pages 有沒有更新。
- _headers：Cloudflare Pages 的回應標頭（同一份 CSP 外加 frame-ancestors、nosniff、vendor 長快取）。
不產生 Functions、不產生 _worker.js。
"""
import argparse
import hashlib
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
API_META = '<meta name="scribe-api" content="">'
CSP_META = re.compile(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">')
ORIGIN = re.compile(r"^(https?)://([a-z0-9.-]+|\[[0-9a-f:]+\])(:[0-9]{1,5})?$")
LOOPBACK = ("127.0.0.1", "localhost", "[::1]")
# vendor 檔名帶版本，內容不會變：長快取。其他用 Pages 預設（每次跟 Cloudflare 確認有沒有新版）
VENDOR_CACHE = "public, max-age=31536000, immutable"


# 網頁版本：和 server.py 的 web_build 同一個算法（index.html 加上 web/shared/ 的共用元件，#155）；tests/test_pages.py 會比對兩邊一樣
SHARED_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*\.(js|css)$")


def web_build_files(web=WEB):
    """組成這版網頁的檔：index.html 加上 web/shared/ 的共用元件（.js／.css，依檔名排序）。"""
    shared = sorted(f.name for f in (web / "shared").iterdir() if f.is_file() and SHARED_NAME.match(f.name)) if (web / "shared").is_dir() else []
    return ["index.html"] + ["shared/" + n for n in shared]


def web_build(web=WEB):
    h = hashlib.sha256()
    for name in web_build_files(web):
        data = (web / name).read_bytes()
        h.update(name.encode() + b"\0" + str(len(data)).encode() + b"\0" + data)
    return h.hexdigest()[:12]


def check_api(value):
    """主機 API 只能是「https://主機[:埠]」，不能有路徑；http 只接受本機（e2e 測試用）。"""
    origin = (value or "").strip().rstrip("/").lower()
    m = ORIGIN.match(origin)
    if not m:
        raise ValueError(f"API 位址要是 https://主機[:埠]，不能有路徑：{value!r}")
    if m.group(1) == "http" and m.group(2) not in LOOPBACK:
        raise ValueError("API 位址要用 https（http 只給本機測試）")
    return origin


def page_csp(html, api):
    """網頁裡的 CSP 加上主機 API；回傳 (新的 html, 新的 CSP)。"""
    found = CSP_META.findall(html)
    if len(found) != 1:
        raise ValueError("index.html 應該剛好有一個 CSP <meta>")
    csp = found[0]
    if csp.count("connect-src 'self'") != 1:
        raise ValueError("CSP 找不到 connect-src 'self'")
    new = csp.replace("connect-src 'self'", f"connect-src 'self' {api}", 1)
    return html.replace(f'content="{csp}"', f'content="{new}"', 1), new


def headers_file(csp):
    # frame-ancestors 只能放在回應標頭（<meta> 裡無效）：不讓別的網站把這頁包進 iframe
    return (
        "/*\n"
        f"  Content-Security-Policy: {csp}; frame-ancestors 'none'\n"
        "  X-Content-Type-Options: nosniff\n"
        "  Referrer-Policy: no-referrer\n"
        "/vendor/*\n"
        f"  Cache-Control: {VENDOR_CACHE}\n"
    )


def build(api, out, web=WEB):
    api = check_api(api)
    out = Path(out)
    if out.exists() and any(out.iterdir()):
        raise ValueError(f"輸出資料夾要是空的：{out}")
    src = (web / "index.html").read_bytes()
    # 跟 server.py 的 BUILD 同一個算法：同一版網頁，主機與 Pages 的代碼一樣
    build_id = web_build(web)
    html = src.decode("utf-8")
    if html.count(API_META) != 1:
        raise ValueError("index.html 應該剛好有一個空的 scribe-api <meta>")
    html = html.replace(API_META, f'<meta name="scribe-api" content="{api}">', 1)
    html, csp = page_csp(html, api)
    html = html.replace("__MS_BUILD__", build_id)
    out.mkdir(parents=True, exist_ok=True)
    for f in sorted(web.rglob("*")):
        rel = f.relative_to(web)
        if f.is_dir() or f.suffix == ".md" or rel.name.startswith(".") or rel == Path("index.html"):
            continue
        (out / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(f, out / rel)
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / "build.txt").write_text(build_id + "\n", encoding="ascii")
    (out / "_headers").write_text(headers_file(csp), encoding="utf-8")
    for line in (out / "_headers").read_text(encoding="utf-8").splitlines():
        if len(line) > 2000:   # Cloudflare Pages 單行上限
            raise ValueError("_headers 有一行超過 2000 字")
    return build_id


def main(argv=None):
    ap = argparse.ArgumentParser(description="打包 Cloudflare Pages 用的靜態網站")
    ap.add_argument("--print-build", action="store_true", help="只印出這版網頁的版本代碼（deploy-all 用來驗收）")
    ap.add_argument("--api", help="主機 API 的來源，例如 https://<主機>.<tailnet>.ts.net:9443")
    ap.add_argument("--out", help="輸出資料夾（要是空的或還不存在）")
    args = ap.parse_args(argv)
    if args.print_build:
        print(web_build())
        return 0
    if not args.api or not args.out:
        ap.error("要給 --api 和 --out")
    try:
        build_id = build(args.api, args.out)
    except ValueError as e:
        print(f"打包失敗：{e}", file=sys.stderr)
        return 2
    print(f"已打包到 {args.out}（版本 {build_id}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
