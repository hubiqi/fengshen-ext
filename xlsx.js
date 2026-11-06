// 浏览器端最小 XLSX 读取器（零依赖）
// xlsx 本质是 ZIP：读 central directory -> 取 sharedStrings.xml + worksheet XML -> DOMParser 解析。
// deflate-raw 用浏览器原生 DecompressionStream，不需要打包任何第三方库。
/* global XLSX_READER */

const XLSX_READER = (() => {
  const dec = new TextDecoder("utf-8");

  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref || "");
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("当前浏览器不支持 DecompressionStream(deflate-raw)，无法解析排班/考勤 xlsx");
    }
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  }

  /** @returns {Promise<Array<{name:string, rows:string[][]}>>} */
  async function read(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);

    // ---- ZIP End Of Central Directory ----
    let eocd = -1;
    const low = Math.max(0, bytes.length - 65558);
    for (let i = bytes.length - 22; i >= low; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是有效的 xlsx（未找到 ZIP 目录尾）");

    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const entries = Object.create(null);

    for (let n = 0; n < count; n++) {
      if (off + 46 > bytes.length || dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const fnLen = dv.getUint16(off + 28, true);
      const exLen = dv.getUint16(off + 30, true);
      const cmLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = dec.decode(bytes.subarray(off + 46, off + 46 + fnLen));
      entries[name] = { method, compSize, localOff };
      off += 46 + fnLen + exLen + cmLen;
    }

    async function entryText(name) {
      const e = entries[name];
      if (!e) return null;
      const lfn = dv.getUint16(e.localOff + 26, true);
      const lex = dv.getUint16(e.localOff + 28, true);
      const start = e.localOff + 30 + lfn + lex;
      const raw = bytes.subarray(start, start + e.compSize);
      if (e.method === 0) return dec.decode(raw);
      if (e.method === 8) return dec.decode(await inflateRaw(raw));
      throw new Error("不支持的 ZIP 压缩方式：" + e.method);
    }

    // ---- sharedStrings ----
    let shared = [];
    const ssXml = await entryText("xl/sharedStrings.xml");
    if (ssXml) {
      const doc = new DOMParser().parseFromString(ssXml, "application/xml");
      const sis = doc.getElementsByTagName("si");
      for (let i = 0; i < sis.length; i++) {
        let s = "";
        const ts = sis[i].getElementsByTagName("t");
        for (let k = 0; k < ts.length; k++) s += ts[k].textContent || "";
        shared.push(s);
      }
    }

    // ---- worksheets ----
    const sheets = [];
    for (const name of Object.keys(entries)) {
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
      const xml = await entryText(name);
      if (!xml) continue;
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const rows = [];
      const rowEls = doc.getElementsByTagName("row");
      for (let ri = 0; ri < rowEls.length; ri++) {
        const cells = rowEls[ri].getElementsByTagName("c");
        const vals = [];
        let maxCi = -1;
        for (let ci = 0; ci < cells.length; ci++) {
          const c = cells[ci];
          const idx = colIndex(c.getAttribute("r"));
          if (idx < 0) continue;
          const t = c.getAttribute("t");
          let v = "";
          if (t === "inlineStr") {
            const is = c.getElementsByTagName("is")[0];
            if (is) {
              const ts = is.getElementsByTagName("t");
              for (let k = 0; k < ts.length; k++) v += ts[k].textContent || "";
            }
          } else {
            const vEl = c.getElementsByTagName("v")[0];
            if (vEl) {
              v = vEl.textContent || "";
              if (t === "s" && /^\d+$/.test(v)) v = shared[Number(v)] != null ? shared[Number(v)] : "";
            }
          }
          vals[idx] = v;
          if (idx > maxCi) maxCi = idx;
        }
        const row = [];
        for (let i = 0; i <= maxCi; i++) row.push(vals[i] == null ? "" : vals[i]);
        rows.push(row);
      }
      sheets.push({ name, rows });
    }
    return sheets;
  }

  /** 找出表头包含指定列名的 sheet，返回 {header, rows, col} */
  function pickSheet(sheets, mustHave) {
    for (const s of sheets) {
      if (!s.rows.length) continue;
      const header = s.rows[0].map((x) => String(x || "").trim());
      const col = Object.create(null);
      header.forEach((h, i) => { if (h && col[h] === undefined) col[h] = i; });
      if (mustHave.every((k) => col[k] !== undefined)) {
        return { header, rows: s.rows.slice(1), col, name: s.name };
      }
    }
    return null;
  }

  return { read, pickSheet, colIndex };
})();
