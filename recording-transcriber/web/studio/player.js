"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：播放器轉接層（#181）。編輯頁的程式都用 video（currentTime、paused、play()、事件…）；
// 本機影片轉給 <video>，YouTube 連結專案轉給 youtube-nocookie 的嵌入框。
// 嵌入框只用 postMessage 控制（seekTo、playVideo、pauseVideo、setPlaybackRate）並收 infoDelivery，不載入 YouTube 的外部程式（CSP 只放行 frame-src）。

const YT_ORIGIN = "https://www.youtube-nocookie.com";
const YT_EVENTS = ["play", "pause", "seeked", "timeupdate", "loadedmetadata", "error", "ended"];

function makePlayer(el, frame) {
  const listeners = new Map(YT_EVENTS.map((k) => [k, new Set()]));
  const emit = (type) => { for (const fn of listeners.get(type) || []) { try { fn({ type }); } catch (e) { console.error(e); } } };
  let mode = "file";
  // YouTube 的狀態：t 是最後一次收到的時間，at 是收到的時刻；播放中用經過的時間補，畫字幕才順
  const yt = { id: "", ready: false, t: 0, at: 0, state: -1, duration: 0, rate: 1, queue: [], error: 0, frameDur: 0 };
  for (const type of YT_EVENTS) el.addEventListener(type, () => { if (mode === "file") emit(type); });

  const send = (func, args = []) => {
    if (!yt.ready) { yt.queue.push([func, args]); return; }
    frame.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args, id: 1, channel: "widget" }), YT_ORIGIN);
  };
  const playing = () => yt.state === 1 || yt.state === 3;   // 3 是緩衝中，照樣算在播
  const ytTime = () => (playing() && yt.at ? yt.t + ((performance.now() - yt.at) / 1000) * yt.rate : yt.t);

  // 嵌入框送來的訊息（window 的 message 事件轉進來；測試也直接呼叫）
  function handleMessage(raw) {
    let d;
    try { d = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return; }
    if (!d || typeof d !== "object") return;
    if (d.event === "onReady") {
      if (yt.ready) return;
      yt.ready = true;
      clearTimeout(listenTimer);
      for (const [func, args] of yt.queue.splice(0)) send(func, args);
      if (yt.rate !== 1) send("setPlaybackRate", [yt.rate]);
      emit("loadedmetadata");
    } else if (d.event === "onError") {
      yt.error = Number(d.info) || -1;
      emit("error");
    } else if (d.event === "infoDelivery" || d.event === "onStateChange") {
      const info = d.event === "onStateChange" ? { playerState: d.info } : d.info || {};
      if (Number.isFinite(info.duration) && info.duration > 0 && !yt.duration) { yt.duration = info.duration; emit("loadedmetadata"); }
      if (Number.isFinite(info.playbackRate)) yt.rate = info.playbackRate;
      if (Number.isFinite(info.currentTime)) { yt.t = info.currentTime; yt.at = performance.now(); }
      if (Number.isFinite(info.playerState) && info.playerState !== yt.state) {
        const was = playing();
        yt.state = info.playerState;
        if (playing() && !was) emit("play");
        if (!playing() && was) { emit("pause"); if (yt.state === 0) emit("ended"); }
      }
      if (Number.isFinite(info.currentTime)) emit("timeupdate");
    }
  }
  window.addEventListener("message", (e) => { if (mode === "yt" && e.origin === YT_ORIGIN && e.source === frame.contentWindow) handleMessage(e.data); });
  // 嵌入框載入好就說「我在聽」，它才會開始送狀態。嵌入框裡的程式可能還沒掛好：收到 onReady 前每 250 ms 再說一次（最多 10 秒，#182）
  let listenTimer = 0;
  const listen = (n = 0) => {
    clearTimeout(listenTimer);
    if (mode !== "yt" || yt.ready || n >= 40) return;
    frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), YT_ORIGIN);
    listenTimer = setTimeout(() => listen(n + 1), 250);
  };
  frame.addEventListener("load", () => listen());

  return {
    get mode() { return mode; },
    get ytError() { return yt.error; },
    // 本機影片：和原本一樣設 src
    useFile(src) {
      if (mode === "yt") this.unloadYouTube();
      mode = "file";
      frame.hidden = true;
      el.hidden = false;
      if (el.getAttribute("src") !== src) el.src = src;
    },
    // YouTube 連結：換成嵌入框（id 已經是伺服器確認過的 11 碼）
    useYouTube(id, durationMs = 0) {
      if (mode === "file" && el.getAttribute("src")) { el.pause(); el.removeAttribute("src"); el.load(); }
      mode = "yt";
      el.hidden = true;
      frame.hidden = false;
      if (yt.id === id && frame.getAttribute("src")) return;
      Object.assign(yt, { id, ready: false, t: 0, at: 0, state: -1, duration: durationMs / 1000, rate: 1, queue: [], error: 0 });
      const q = new URLSearchParams({ enablejsapi: "1", origin: location.origin, playsinline: "1", rel: "0", cc_load_policy: "0", iv_load_policy: "3", modestbranding: "1" });
      frame.src = `${YT_ORIGIN}/embed/${encodeURIComponent(id)}?${q}`;
    },
    unloadYouTube() {
      frame.removeAttribute("src");
      Object.assign(yt, { id: "", ready: false, t: 0, at: 0, state: -1, duration: 0, queue: [] });
    },
    // 關掉工作室時：兩種都停
    unload() {
      el.pause();
      el.removeAttribute("src");
      el.load();
      this.unloadYouTube();
      mode = "file";
    },
    handleMessage,
    get currentTime() { return mode === "yt" ? ytTime() : el.currentTime; },
    set currentTime(v) {
      if (mode !== "yt") { el.currentTime = v; return; }
      const t = Math.max(0, Number(v) || 0);
      yt.t = t;
      yt.at = performance.now();
      send("seekTo", [t, true]);
      emit("seeked");
    },
    get duration() { return mode === "yt" ? yt.duration : el.duration; },
    get paused() { return mode === "yt" ? !playing() : el.paused; },
    get readyState() { return mode === "yt" ? (yt.ready ? 4 : 0) : el.readyState; },
    get videoWidth() { return mode === "yt" ? 16 : el.videoWidth; },
    get videoHeight() { return mode === "yt" ? 9 : el.videoHeight; },
    get playbackRate() { return mode === "yt" ? yt.rate : el.playbackRate; },
    set playbackRate(v) { if (mode === "yt") { yt.rate = Number(v) || 1; send("setPlaybackRate", [yt.rate]); } else el.playbackRate = v; },
    play() {
      if (mode !== "yt") return el.play();
      send("playVideo");
      // 先當成在播，play 事件與畫字幕不用等嵌入框回報（回報來了會再對時間）
      if (!playing()) { yt.at = performance.now(); yt.state = 1; emit("play"); }
      return Promise.resolve();
    },
    pause() {
      if (mode !== "yt") { el.pause(); return; }
      yt.t = ytTime();
      send("pauseVideo");
      if (playing()) { yt.state = 2; emit("pause"); }
    },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    getAttribute(k) { return mode === "yt" ? (k === "src" ? frame.getAttribute("src") : null) : el.getAttribute(k); },
  };
}
