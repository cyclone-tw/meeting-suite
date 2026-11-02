// 測試用的假 RecapFiles（真的在 meeting-scribe 的 web/shared/recap-files.js，那邊測格式）。
// 這裡只做到讓工作室的流程測得起來：同樣的函式名稱、撞名加 -2、不分大小寫
const NAME_BAD = /[/\\:*?"<>|\u0000-\u001f]/g;
export const fakeRecapFiles = Object.freeze({
  version: "1.0.0",
  headerLines: ({ name, place } = {}) => [...(name ? [`會議：${name}`] : []), ...(place ? [`地點：${place}`] : [])],
  summaryMarkdown: ({ header = [], intro = "", chapters = [], full = "", short = "", transcript = "" }) =>
    `# 會後總結\n\n${header.length ? `${header.join("\n")}\n\n` : ""}## 簡介\n\n${intro}${chapters.length ? `\n\n[ 分段章節 ]\n${chapters.map((c) => c.title).join("\n")}` : ""}\n\n## 完整總結\n\n${full}\n\n## 短總結\n\n${short}\n\n## 逐字稿\n\n${transcript}\n`,
  extraFileName: (label) => `${String(label).trim().replace(NAME_BAD, "_").replace(/^\.+/, "").slice(0, 80) || "延伸"}.md`,
  extraFiles(list, { header = [], taken = [] } = {}) {
    const used = new Set(taken.map((f) => String(f).toLowerCase()));
    return list.filter((x) => String(x.markdown || "").trim()).map((x) => {
      const base = fakeRecapFiles.extraFileName(x.label).replace(/\.md$/, "");
      let file = `${base}.md`;
      for (let n = 2; used.has(file.toLowerCase()); n += 1) file = `${base}-${n}.md`;
      used.add(file.toLowerCase());
      return { label: x.label, file, markdown: `# ${x.label}\n\n${header.length ? `${header.join("\n")}\n\n` : ""}${x.markdown}\n` };
    });
  },
});
