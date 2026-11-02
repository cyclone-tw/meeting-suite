// 防呆（以後新模組、改畫面都只改一處）：會後內容的畫面與存檔格式只在
// 會議轉錄 App 的 web/shared/ 改（MdView、ExtPanel、MindMap、RecapFiles）。工作室自己又寫一套就失敗。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ...fs.readdirSync(path.join(ROOT, "web", "studio")).filter((f) => f.endsWith(".js")).map((f) => path.join("web", "studio", f)),
  ...["scripts", "lib"].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith(".mjs")).map((f) => path.join(d, f))),
];
// 這些是自己寫一套的跡象：Markdown 標題／清單的解析、心智圖的版面與畫圖、延伸的子頁籤與選項、會後檔案的格式
const FORKS = [
  [/function\s+(recapMarkdown|moduleMarkdown|moduleFile|mmLayout|mmSvg|renderModuleOptions|renderModulePicker|parseMarkdown|renderMd)\b/, "自己寫的會後內容函式"],
  [/const\s+(SAPLING|MOD_LOOK)\b/, "自己畫的模組圖示"],
  [/#\{1,6\}\\s|\^#\{1,6\}/, "自己解析 Markdown 標題"],
  [/`# 會後總結/, "自己組 summary.md"],
  [/class=\\?"mm-node|mm-edge/, "自己畫心智圖"],
];

test("the Studio has no own copy of the meeting app's post-meeting UI or file formats", () => {
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const [re, why] of FORKS) if (re.test(text)) hits.push(`${f}：${why}（${re}）`);
  }
  assert.deepEqual(hits, [], "會後內容的畫面與存檔格式只在 meeting-scribe 的 web/shared/ 改");
});
