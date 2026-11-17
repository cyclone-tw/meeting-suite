#!/usr/bin/env node
// Ask AI 查 wiki 的 MCP 轉接器（#194）。由 Claude 依 --mcp-config 叫起來，不是給人直接跑的：
//   node scripts/wiki-mcp.mjs --bin <wiki 查詢工具的絕對路徑>
// 細節見 lib/wiki-mcp.mjs。

import path from "node:path";
import { serve } from "../lib/wiki-mcp.mjs";

const i = process.argv.indexOf("--bin");
const bin = i > 0 ? process.argv[i + 1] : "";
if (!bin || !path.isAbsolute(bin)) {
  process.stderr.write("usage: wiki-mcp.mjs --bin <absolute path to the wiki CLI>\n");
  process.exit(2);
}
serve({ bin });
