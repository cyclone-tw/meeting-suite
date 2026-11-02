// 頁面共用的 lib（和伺服器同一份程式）。一般 script 不能 import，這裡先載入再掛到全域；
// 它是 module，排在其他 defer script 前面，依規格會先執行完（#50）。
import * as ops from "/cue-ops.mjs";
import * as cutOps from "/cuts.mjs";
import * as shortOps from "/shorts.mjs";
import * as boxOps from "/subtitle-box.mjs";

window.ops = ops;
window.cutOps = cutOps;
window.shortOps = shortOps;
window.boxOps = boxOps;
