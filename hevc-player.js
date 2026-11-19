/* H.265（HEVC）内嵌播放器
 * Chrome 内核不带 HEVC 解码器，这里用 @hevcjs/core 的 WASM 解码器软解，
 * 自己用 mp4box 解封装，画到 canvas 上；声音仍交给原生 <video> 播。
 * 依赖：vendor/hevc/*（MIT）、vendor/mp4box/*（BSD-3-Clause）
 */

const WASM_GLUE = "vendor/hevc/wasm/hevc-decode.js";
const WASM_BIN = "vendor/hevc/wasm/hevc-decode.wasm";
const DECODER_MOD = "vendor/hevc/decoder-entry.js";
const MP4BOX_MOD = "vendor/mp4box/mp4box.all.mjs";

let gluePromise = null;
function loadGlue() {
  if (gluePromise) return gluePromise;
  gluePromise = new Promise((resolve, reject) => {
    if (globalThis.HEVCDecoderModule) { resolve(); return; }
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL(WASM_GLUE);
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("HEVC 解码器脚本加载失败"));
    (document.head || document.documentElement).appendChild(s);
  });
  return gluePromise;
}

function toAnnexB(data, lengthSize) {
  const parts = [];
  let off = 0;
  let total = 0;
  while (off + lengthSize <= data.length) {
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = (len << 8) | data[off + i];
    off += lengthSize;
    if (len <= 0 || off + len > data.length) break;
    total += 4 + len;
    parts.push({ off, len });
    off += len;
  }
  const out = new Uint8Array(total);
  let w = 0;
  for (const p of parts) {
    out[w++] = 0; out[w++] = 0; out[w++] = 0; out[w++] = 1;
    out.set(data.subarray(p.off, p.off + p.len), w);
    w += p.len;
  }
  return out;
}

function annexBFromNals(nals) {
  let total = 0;
  for (const n of nals) total += 4 + n.length;
  const out = new Uint8Array(total);
  let w = 0;
  for (const n of nals) {
    out[w++] = 0; out[w++] = 0; out[w++] = 0; out[w++] = 1;
    out.set(n, w);
    w += n.length;
  }
  return out;
}

async function demux(url) {
  const MP4Box = await import(chrome.runtime.getURL(MP4BOX_MOD));
  const np = await fetch(url).then((r) => r.arrayBuffer());
  np.fileStart = 0;
  const file = MP4Box.createFile();
  const samples = [];
  let track = null;
  let paramSets = null;
  let lengthSize = 4;

  const ready = new Promise((resolve, reject) => {
    file.onError = (e) => reject(new Error("MP4 解析失败：" + e));
    file.onReady = (info) => {
      try {
        const vt = (info.videoTracks || [])[0];
        if (!vt) { reject(new Error("没有视频轨")); return; }
        track = vt;
        const trak = file.getTrackById(vt.id);
        const entry = trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl
          && trak.mdia.minf.stbl.stsd && trak.mdia.minf.stbl.stsd.entries[0];
        const hvcC = entry && entry.hvcC;
        if (hvcC) {
          lengthSize = ((hvcC.lengthSizeMinusOne == null ? 3 : hvcC.lengthSizeMinusOne) & 3) + 1;
          const arrs = hvcC.nalu_arrays || hvcC.naluArrays || [];
          const nals = [];
          for (const arr of arrs) {
            const list = Array.isArray(arr) ? arr : (typeof arr[Symbol.iterator] === "function" ? Array.from(arr) : []);
            for (const n of list) {
              const bytes = n && n.data ? n.data : n;
              if (bytes && bytes.length) nals.push(bytes);
            }
          }
          if (nals.length) paramSets = annexBFromNals(nals);
        }
        file.setExtractionOptions(vt.id, null, { nbSamples: vt.nb_samples });
        file.start();
        resolve(info);
      } catch (e) { reject(e); }
    };
  });

  file.onSamples = (id, user, list) => { for (const s of list) samples.push(s); };
  file.appendBuffer(np);
  file.flush();
  const info = await ready;
  for (let i = 0; i < 80 && samples.length < (track.nb_samples || 0); i++) {
    await new Promise((r) => setTimeout(r, 50));
    file.flush();
  }
  if (!samples.length) throw new Error("没有取到视频样本");
  const timescale = track.timescale || 1;
  const fps = (track.nb_samples || samples.length) / (track.duration / timescale || 1);
  const list = samples.map((s) => ({
    t: (s.cts != null ? s.cts : s.dts) / timescale,
    dts: (s.dts || 0) / timescale,
    sync: !!s.is_sync,
    annexB: toAnnexB(s.data, lengthSize)
  }));
  return { list, paramSets, info, fps: fps || 25, duration: (track.duration / timescale) || 0 };
}

/** 逐像素 YUV→RGB（2D canvas，无 WebGL 环境也能用）。 */
function createRenderer(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  const Ylut = new Uint8Array(256), RU = new Int16Array(256), GU = new Int16Array(256),
    GV = new Int16Array(256), BU = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    Ylut[i] = Math.max(0, Math.min(255, Math.round(1.164383 * (i - 16))));
    const c = i - 128;
    RU[i] = Math.round(1.792741 * c);
    GU[i] = Math.round(-0.213249 * c);
    GV[i] = Math.round(-0.532909 * c);
    BU[i] = Math.round(2.112402 * c);
  }
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  let img = null, out = null, w = 0, h = 0;
  return function draw(f) {
    if (!img || w !== f.width || h !== f.height) {
      w = f.width; h = f.height;
      canvas.width = w; canvas.height = h;
      img = ctx.createImageData(w, h);
      out = img.data;
    }
    const Y = f.y, U = f.cb, V = f.cr, cw = f.chromaWidth;
    const sh = f.bitDepth === 10 ? 2 : 0;
    let p = 0;
    for (let y = 0; y < h; y++) {
      const ry = y * w, rc = (y >> 1) * cw;
      for (let x = 0; x < w; x++) {
        const yv = Ylut[(Y[ry + x] >> sh) & 255];
        const ci = rc + (x >> 1);
        const u = (U[ci] >> sh) & 255;
        const v = (V[ci] >> sh) & 255;
        out[p] = clamp(yv + RU[v]);
        out[p + 1] = clamp(yv + GU[u] + GV[v]);
        out[p + 2] = clamp(yv + BU[u]);
        out[p + 3] = 255;
        p += 4;
      }
    }
    ctx.putImageData(img, 0, 0);
  };
}

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 在容器里挂一个 HEVC 播放器。
 * @param {HTMLElement} container
 * @param {{url:string, name?:string, fallbackUrl?:string}} opts
 */
export async function mountHevcPlayer(container, opts) {
  const url = opts.url;
  container.innerHTML =
    `<div class="hp"><div class="hp-stage"><canvas></canvas>` +
    `<div class="hp-tip">H.265 软解中…</div></div>` +
    `<div class="hp-bar"><button type="button" class="hp-play" title="播放/暂停">▶</button>` +
    `<span class="hp-time">0:00 / 0:00</span>` +
    `<input class="hp-seek" type="range" min="0" max="1000" value="0" step="1">` +
    `<button type="button" class="hp-mute" title="静音">🔊</button>` +
    `<span class="hp-badge">H.265 软解</span></div></div>`;
  const root = container.querySelector(".hp");
  const canvas = root.querySelector("canvas");
  const tip = root.querySelector(".hp-tip");
  const playBtn = root.querySelector(".hp-play");
  const timeEl = root.querySelector(".hp-time");
  const seekEl = root.querySelector(".hp-seek");
  const muteBtn = root.querySelector(".hp-mute");

  const audio = document.createElement("video");
  audio.src = url;
  audio.preload = "auto";
  audio.playsInline = true;
  audio.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;";
  root.appendChild(audio);

  let destroyed = false;
  let decoder = null;
  let samples = [];
  let fps = 25;
  let duration = 0;
  let cursor = 0;
  let frameNo = 0;
  let queue = [];
  let eof = false;
  let lastDrawn = null;
  let draw = null;
  let raf = 0;
  let wallT0 = 0;
  let wallBase = 0;
  let useWall = false;

  const clock = () => {
    if (!useWall) {
      const t = audio.currentTime;
      if (Number.isFinite(t)) return t;
    }
    return wallBase + (performance.now() - wallT0) / 1000;
  };

  let newDecoder = null;

  const teardownDecoder = () => {
    if (decoder) { try { decoder.destroy(); } catch (e) { /* ignore */ } decoder = null; }
    queue = [];
    eof = false;
  };

  const startAt = async (t) => {
    teardownDecoder();
    const list = (samples && samples.list) || [];
    let idx = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].t <= t + 0.001) { if (list[i].sync) idx = i; } else break;
    }
    cursor = idx;
    frameNo = Math.round((list[idx] ? list[idx].t : 0) * fps);
    decoder = await newDecoder();
    if (samples && samples.paramSets) decoder.feed(samples.paramSets);
  };

  const pump = () => {
    if (!decoder || eof || !samples || !samples.list) return;
    const target = 8;
    while (queue.length < target && cursor < samples.list.length) {
      const s = samples.list[cursor++];
      decoder.feed(s.annexB);
      for (const f of decoder.drain()) {
        queue.push({ t: frameNo / fps, f });
        frameNo++;
      }
    }
    if (cursor >= samples.list.length) {
      for (const f of decoder.flush()) { queue.push({ t: frameNo / fps, f }); frameNo++; }
      eof = true;
    }
  };

  try {
    samples = await demux(url);
    fps = samples.fps;
    duration = samples.duration || (audio.duration || 0);
    await loadGlue();
    const { HEVCDecoder } = await import(chrome.runtime.getURL(DECODER_MOD));
    newDecoder = () => HEVCDecoder.create({ wasmBinaryUrl: chrome.runtime.getURL(WASM_BIN) });
    draw = createRenderer(canvas);
    if (!draw) throw new Error("画布不可用");
    await startAt(0);
    pump();
    if (queue.length) {
      draw(queue[0].f);
      lastDrawn = queue[0];
    }
    tip.textContent = "";
    tip.style.display = "none";
  } catch (e) {
    tip.textContent = "软解失败：" + String((e && e.message) || e);
    tip.classList.add("is-err");
    if (opts.fallbackUrl) {
      const a = document.createElement("a");
      a.className = "hp-dl";
      a.href = opts.fallbackUrl;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = "改用系统播放器";
      tip.appendChild(document.createElement("br"));
      tip.appendChild(a);
    }
    return;
  }

  audio.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      duration = audio.duration;
    }
    timeEl.textContent = `0:00 / ${fmt(duration)}`;
  });
  audio.addEventListener("error", () => { useWall = true; });
  audio.addEventListener("ended", () => { playBtn.textContent = "▶"; });
  audio.addEventListener("play", () => { playBtn.textContent = "❚❚"; });
  audio.addEventListener("pause", () => { playBtn.textContent = "▶"; });
  audio.addEventListener("seeked", () => { startAt(audio.currentTime).then(pump); });

  const seekTo = (t) => {
    const target = Math.max(0, Math.min(duration || t, t));
    if (useWall || !Number.isFinite(audio.duration)) {
      wallBase = target;
      wallT0 = performance.now();
    } else {
      audio.currentTime = target;
    }
    lastDrawn = null;
    startAt(target).then(pump);
  };

  playBtn.addEventListener("click", () => {
    if (audio.paused) {
      audio.play().catch(() => { useWall = true; wallBase = clock(); wallT0 = performance.now(); });
    } else {
      audio.pause();
      if (useWall) wallBase = clock();
    }
  });
  muteBtn.addEventListener("click", () => {
    audio.muted = !audio.muted;
    muteBtn.textContent = audio.muted ? "🔇" : "🔊";
  });
  seekEl.addEventListener("input", () => {
    const t = (Number(seekEl.value) / 1000) * (duration || 0);
    seekTo(t);
  });

  const loop = () => {
    if (destroyed) return;
    raf = requestAnimationFrame(loop);
    const t = clock();
    if (queue.length) {
      let keep = 0;
      for (let i = 0; i < queue.length; i++) if (queue[i].t <= t + 0.012) keep = i;
      if (keep > 0) queue.splice(0, keep);
      const head = queue[0];
      if (head && head.t <= t + 0.08 && head !== lastDrawn) {
        draw(head.f);
        lastDrawn = head;
      }
    }
    pump();
    if (duration) {
      seekEl.value = String(Math.round((Math.min(t, duration) / duration) * 1000));
      timeEl.textContent = `${fmt(Math.min(t, duration))} / ${fmt(duration)}`;
    }
  };
  raf = requestAnimationFrame(loop);

  return function destroy() {
    destroyed = true;
    cancelAnimationFrame(raf);
    try { audio.pause(); } catch (e) { /* ignore */ }
    audio.removeAttribute("src");
    try { audio.load(); } catch (e) { /* ignore */ }
    teardownDecoder();
    container.innerHTML = "";
  };
}
