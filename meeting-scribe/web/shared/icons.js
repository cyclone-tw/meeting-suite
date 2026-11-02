// 共用元件（meeting-scribe#168）：會後畫面的小圖示，會議轉錄 App、ExtPanel 與字幕工作室都從這裡拿，不各自畫。
// 一般 script，載入後掛 window.MeetingIcons。只用 DOM 組 SVG（不拼 HTML 字串）。
//
//   MeetingIcons.icon(name, { doc, className, label })  → <svg> 元素；沒有這個名稱回 null
//     doc：要建在哪個 document（預設 window.document）；className：加在 <svg> 上的 class；
//     label：有給就是有名字的圖（role="img"），沒給就是裝飾（aria-hidden，旁邊一定要有文字）
//   MeetingIcons.names    → 所有名稱
//   MeetingIcons.version  → 版本
//
// 線條圖示照 DESIGN.md：24 格、1.8 線寬、圓角端點、顏色跟著文字（currentColor）；sapling（發芽的樹苗）是唯一的彩色圖。
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const LINE = { fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" };
  const p = (d) => ["path", { d }];

  const ICONS = {
    // 會後區塊
    recap: { shapes: [p("M5 6h14M5 10h14M5 14h9M5 18h6")] },                                   // 會後總結：幾行字
    minutes: { shapes: [["rect", { x: 5, y: 4, width: 14, height: 17, rx: 2 }], ["rect", { x: 8.5, y: 2.5, width: 7, height: 3.5, rx: 1 }],
      p("M9 11h6M9 14.5h6M9 18h3.5")] },                                                          // 會議紀錄：夾板
    form: { shapes: [p("M6 3h8l4 4v14H6z"), p("M14 3v4h4"), p("M8.5 11.5h7"),
      p("M8.5 17c1.1-1.9 1.9-1.9 2.5-.6.5 1.1 1.2 1.2 1.9-.2.4-.7.9-.7 1.6 0")] },              // 表單紀錄（簽名版）：文件加簽名
    mindmap: { shapes: [["circle", { cx: 12, cy: 12, r: 2.6 }], ["circle", { cx: 4.8, cy: 5.5, r: 1.9 }], ["circle", { cx: 19.2, cy: 5.5, r: 1.9 }],
      ["circle", { cx: 4.8, cy: 18.5, r: 1.9 }], ["circle", { cx: 19.2, cy: 18.5, r: 1.9 }],
      p("M10 10.3L6.3 6.9M14 10.3l3.7-3.4M10 13.7l-3.7 3.4M14 13.7l3.7 3.4")] },                // 心智圖：中心接四個節點
    ext: { shapes: [p("M10 4.5a2 2 0 0 1 4 0V6h3.5a1 1 0 0 1 1 1v3.5H17a2 2 0 0 0 0 4h1.5V18a1 1 0 0 1-1 1H14v-1.5a2 2 0 0 0-4 0V19H6.5a1 1 0 0 1-1-1v-3.5H7a2 2 0 0 0 0-4H5.5V7a1 1 0 0 1 1-1H10z")] },   // 延伸模組：拼圖
    drive: { shapes: [p("M7.5 18H17a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.6 4.25 4.25 0 0 0 7.5 18z"), p("M12 15.5v-5M9.8 12.5l2.2-2.2 2.2 2.2")] },   // 存到 Drive：雲加上傳
    // 延伸模組與選項
    spark: { shapes: [p("M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6-5.6-1.9 5.6-1.9z"), p("M19 3.5v3M17.5 5h3")] },   // 沒指定圖示的模組
    eye: { shapes: [p("M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"), ["circle", { cx: 12, cy: 12, r: 3 }]] },   // 視角回饋
    briefcase: { shapes: [["rect", { x: 3.5, y: 7.5, width: 17, height: 12, rx: 2 }], p("M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M3.5 12.5h17")] },   // 老闆／主管
    cap: { shapes: [p("M2.5 9.5L12 5l9.5 4.5L12 14z"), p("M6.5 11.6v3.9c0 1.3 2.5 2.8 5.5 2.8s5.5-1.5 5.5-2.8v-3.9"), p("M21.5 9.5v5")] },   // 特教專家
    house: { shapes: [p("M4 11l8-6.5 8 6.5"), p("M6 9.5v10h12v-10"), p("M10 19.5v-5h4v5")] },   // 家長
    // 發芽：彩色樹苗（和字幕工作室 #99 同一張）
    sapling: { viewBox: "0 0 32 32", color: true, shapes: [
      ["ellipse", { cx: 16, cy: 27.5, rx: 9.5, ry: 2.8, fill: "#b08458" }],
      ["path", { d: "M16 27V15.5", stroke: "#2f8f3a", "stroke-width": 2.4, "stroke-linecap": "round", fill: "none" }],
      ["path", { d: "M16 18.5C9.5 18.8 5.2 14 5.8 7.2c6.6-.3 10.4 4.2 10.2 11.3z", fill: "#5cc169" }],
      ["path", { d: "M16 15.2c.1-6 3.6-10 10.4-10.2.4 6.3-3.6 10.2-10.4 10.2z", fill: "#86d97f" }],
      ["path", { d: "M8.4 9.6c2.6 1.9 5 4.7 7 8.4M24 7.4c-2.4 1.6-4.6 4-6.6 7.2", stroke: "#3a9b46", "stroke-width": 1.1, "stroke-linecap": "round", fill: "none" }],
      ["circle", { cx: 11, cy: 24.6, r: 0.9, fill: "#8f6a43" }],
      ["circle", { cx: 21.5, cy: 25.2, r: 0.7, fill: "#8f6a43" }],
    ] },
  };

  function icon(name, { doc, className, label } = {}) {
    const def = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : null;
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!def || !d) return null;
    const svg = d.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", def.viewBox || "0 0 24 24");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("data-icon", name);
    if (className) svg.setAttribute("class", className);
    if (label) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label); }
    else svg.setAttribute("aria-hidden", "true");
    if (!def.color) for (const [k, v] of Object.entries(LINE)) svg.setAttribute(k, String(v));
    for (const [tag, attrs] of def.shapes) {
      const s = d.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, String(v));
      svg.append(s);
    }
    return svg;
  }

  window.MeetingIcons = Object.freeze({ icon, names: Object.freeze(Object.keys(ICONS)), version: "1.0.0" });
})();
