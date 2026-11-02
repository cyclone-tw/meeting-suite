"use strict";
// 字幕工作室頁面的一部分（#50）：沒有編譯步驟，這幾個檔依 studio.html 的順序以一般 script 載入，
// 共用同一個全域範圍，所以可以直接用其他檔宣告的函式與變數。頂層只放宣告和事件綁定，
// 呼叫其他檔的函式要放在事件或函式裡，因為載入當下後面的檔還沒執行。
// 這個檔：時間軸元件（預覽頁與編輯頁共用）。

// ---- 時間軸元件：縮圖、波形、剪掉的區段、選取範圍、播放位置（預覽頁與編輯頁共用）----
const THUMB_W = 128, THUMB_H = 72, STRIP_H = 54, WAVE_H = 40;
const ZOOMS = [1, 2, 4, 8, 16, 32, 64];
function makeTimeline(root, on) {
  const scroll = root.querySelector(".tl-scroll"), inner = root.querySelector(".tl-inner"), view = root.querySelector(".tl-view");
  const thumbsCv = root.querySelector(".tl-thumbs"), waveCv = root.querySelector(".tl-wave");
  const hintsBox = root.querySelector(".tl-hints");
  const cutsBox = root.querySelector(".tl-cuts"), selBox = root.querySelector(".tl-sel"), markBox = root.querySelector(".tl-mark"), head = root.querySelector(".tl-head");
  const t = { dur: 1, zoom: 1, tiles: [], wave: null, cuts: [], hints: [], picked: -1, sel: null, mark: null, now: 0 };
  const W = () => scroll.clientWidth * t.zoom;
  const xOf = (ms) => (ms / t.dur) * W();
  const msOf = (x) => Math.max(0, Math.min(t.dur, (x / W()) * t.dur));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function draw() {
    const vw = scroll.clientWidth, left = scroll.scrollLeft, dpr = window.devicePixelRatio || 1;
    inner.style.width = `${W()}px`;
    view.style.width = `${vw}px`;
    for (const [cv, h] of [[thumbsCv, STRIP_H], [waveCv, WAVE_H]]) {
      if (cv.width !== Math.round(vw * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(vw * dpr); cv.height = Math.round(h * dpr); cv.style.width = `${vw}px`; cv.style.height = `${h}px`; }
    }
    // 縮圖：一格一張，挑時間最接近格子中間的那張
    const g = thumbsCv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = css("--surface-2");
    g.fillRect(0, 0, vw, STRIP_H);
    const sw = (THUMB_W * STRIP_H) / THUMB_H;
    const loaded = t.tiles.filter(Boolean);
    for (let k = Math.floor(left / sw); k * sw < left + vw; k++) {
      const tc = msOf((k + 0.5) * sw);
      let best = null;
      for (const tile of loaded) if (!best || Math.abs(tile.t_ms - tc) < Math.abs(best.t_ms - tc)) best = tile;
      if (best?.img.complete) g.drawImage(best.img, k * sw - left, 0, sw, STRIP_H);
    }
    // 波形：每一個像素欄取這段時間裡最大的振幅
    const w = waveCv.getContext("2d");
    w.setTransform(dpr, 0, 0, dpr, 0, 0);
    w.clearRect(0, 0, vw, WAVE_H);
    if (t.wave?.peaks.length) {
      w.fillStyle = css("--accent");
      const { peaks, bucket_ms } = t.wave;
      for (let x = 0; x < vw; x++) {
        const a = Math.floor(msOf(left + x) / bucket_ms), b = Math.max(a + 1, Math.ceil(msOf(left + x + 1) / bucket_ms));
        let m = 0;
        for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
        const h = Math.max(1, (m / 255) * (WAVE_H - 2));
        w.fillRect(x, (WAVE_H - h) / 2, 1, h);
      }
    } else {
      w.fillStyle = css("--muted");
      w.font = "12px -apple-system, sans-serif";
      w.fillText(t.wave ? "這支影片沒有聲音" : "讀取聲音波形…", 8, WAVE_H / 2 + 4);
    }
    if (hintsBox) hintsBox.innerHTML = t.hints.map((h) => `<div style="left:${xOf(h.start)}px;width:${Math.max(2, xOf(h.end) - xOf(h.start))}px"></div>`).join("");
    cutsBox.innerHTML = t.cuts.map((c, i) => `<div data-cut="${i}" class="${c.by === "ai" ? "ai" : ""}${i === t.picked ? " sel" : ""}" style="left:${xOf(c.start)}px;width:${Math.max(2, xOf(c.end) - xOf(c.start))}px" title="${esc(c.reason || "剪掉的區段")}：點一下可以恢復"></div>`).join("");
    selBox.hidden = !t.sel;
    if (t.sel) Object.assign(selBox.style, { left: `${xOf(t.sel[0])}px`, width: `${xOf(t.sel[1]) - xOf(t.sel[0])}px` });
    markBox.hidden = t.mark === null || !!t.sel;
    if (t.mark !== null) markBox.style.left = `${xOf(t.mark)}px`;
    head.style.left = `${xOf(t.now)}px`;
  }

  // 播放時讓播放位置留在畫面裡
  function follow() {
    const x = xOf(t.now), vw = scroll.clientWidth;
    if (x < scroll.scrollLeft || x > scroll.scrollLeft + vw - 24) scroll.scrollLeft = Math.max(0, x - vw * 0.2);
  }

  let drag = null;
  inner.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = inner.getBoundingClientRect();
    drag = { x0: e.clientX - r.left, moved: false, cut: e.target.closest("[data-cut]")?.dataset.cut };
    inner.setPointerCapture(e.pointerId);
  });
  inner.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const x = e.clientX - inner.getBoundingClientRect().left;
    if (!drag.moved && Math.abs(x - drag.x0) < 5) return;
    drag.moved = true;
    const a = msOf(Math.min(x, drag.x0)), b = msOf(Math.max(x, drag.x0));
    t.sel = [a, b];
    draw();
  });
  inner.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) { on.select?.(t.sel); return; }
    if (d.cut !== undefined) on.pickCut?.(Number(d.cut));
    else on.seek?.(msOf(e.clientX - inner.getBoundingClientRect().left));
  });
  inner.addEventListener("pointercancel", () => { drag = null; });   // 觸控被瀏覽器接手（捲動）時，不要繼續拉選取
  scroll.addEventListener("scroll", () => requestAnimationFrame(draw), { passive: true });
  new ResizeObserver(() => draw()).observe(scroll);

  return {
    reset(dur) { Object.assign(t, { dur: Math.max(1, dur), zoom: 1, tiles: [], wave: null, cuts: [], hints: [], picked: -1, sel: null, mark: null, now: 0 }); scroll.scrollLeft = 0; draw(); },
    addTile(tile) {
      const img = new Image();
      img.onload = () => requestAnimationFrame(draw);
      img.src = `data:image/jpeg;base64,${tile.jpg}`;
      t.tiles[tile.i] = { t_ms: tile.t_ms, img };
    },
    setWave(wave) { t.wave = wave; draw(); },
    setCuts(cuts, picked = -1) { t.cuts = cuts; t.picked = picked; draw(); },
    setHints(hints) { t.hints = hints; draw(); },
    setSel(sel, mark = null) { t.sel = sel; t.mark = mark; draw(); },
    setNow(ms, playing) { t.now = ms; if (playing) follow(); head.style.left = `${xOf(ms)}px`; },
    zoom(dir) {
      const i = Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(t.zoom) + dir));
      t.zoom = ZOOMS[i];
      draw();
      scroll.scrollLeft = Math.max(0, xOf(t.now) - scroll.clientWidth / 2);
      draw();
      return t.zoom;
    },
    get zoomLevel() { return t.zoom; },
  };
}
