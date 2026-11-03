"use strict";
// 字幕工作室頁面的一部分（#152）：介面中英切換的開頭設定。放在 <head>、不 defer，比其他頁面程式先跑：
// 決定語言（記在 studio.lang，沒選過看瀏覽器）、建翻譯（會議 App 的共用元件字典＋工作室自己的字典），全域的 _ 給其他檔用。
// 會議轉錄 App 的 checkout 不在時（/shared/i18n.js 404）就照中文。靜態畫面在 common.js 換字。
// 會議 App 的翻譯引擎：create／pick 都要有才用（checkout 不在或太舊就照中文）
const ENGINE = window.MeetingI18n && typeof MeetingI18n.create === "function" && typeof MeetingI18n.pick === "function" ? MeetingI18n : null;
const UI_LANG = ENGINE ? ENGINE.pick((() => { try { return localStorage.getItem("studio.lang"); } catch (e) { return null; } })(), navigator.languages || [navigator.language]) : "zh";
// 會議 App 的 checkout 比較舊、引擎還沒有 msg（主機訊息反查）時，主機訊息照原樣
const withMsg = (t) => (typeof t.msg === "function" ? t : Object.freeze({ ...t, msg: (s) => s }));
const I18N = ENGINE ? withMsg(ENGINE.create(UI_LANG, [window.MeetingLangEN || {}, window.StudioLangEN || {}]))
  : { lang: "zh", translate() {}, missing: new Set(), msg: (s) => s, _: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)) : s) };
const _ = I18N._;
if (ENGINE && typeof ENGINE.use === "function") ENGINE.use(I18N);   // 共用元件（心智圖、延伸頁籤）用同一份
document.documentElement.lang = UI_LANG === "en" ? "en" : "zh-Hant";
// 英文：靜態畫面換好字之前先不顯示，免得閃一下中文（common.js 換完拿掉；3 秒保底）
if (UI_LANG === "en") { document.documentElement.classList.add("i18n-wait"); setTimeout(() => document.documentElement.classList.remove("i18n-wait"), 3000); }
