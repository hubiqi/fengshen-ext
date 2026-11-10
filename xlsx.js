// 浏览器端最小 XLSX 读写器（零依赖）
// xlsx 本质是 ZIP：读 central directory -> 取 sharedStrings.xml + worksheet XML -> DOMParser 解析。
// deflate-raw 用浏览器原生 DecompressionStream，不需要打包任何第三方库。
// 写侧 XLSX_WRITER 用 store（不压缩）ZIP + CRC32 生成标准 OOXML，支持多 Sheet、
// inlineStr 单元格内换行、冻结窗格、表头/状态底色，Excel / WPS / Numbers 都能直接打开。
/* global XLSX_READER, XLSX_WRITER */

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

// ---------------------------------------------------------------- 写入侧
const XLSX_WRITER = (() => {
  const enc = new TextEncoder();
  const DOS_DATE = 0x5C21;              // 1980 起算的固定时间戳（2026-01-01），避免 0 日期

  /** 样式索引：rent.js 生成 styles 矩阵时直接用这些常量。 */
  const STYLE = {
    base: 0, head: 1, info: 2,
    ok: 3, busy: 4, before: 5, after: 6, past: 7
  };

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** ZIP store 模式：本地头 + 数据 + 中央目录 + EOCD。文件名全 ASCII，内容是 UTF-8 XML。 */
  function zipStore(files) {
    const locals = [], centrals = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length + data.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);       // UTF-8 文件名标记
      lv.setUint16(8, 0, true);            // 0 = store
      lv.setUint16(10, 0, true);
      lv.setUint16(12, DOS_DATE, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      local.set(data, 30 + name.length);
      locals.push(local);

      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, DOS_DATE, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);
      centrals.push(central);
      offset += local.length;
    }
    const cdSize = centrals.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const out = new Uint8Array(offset + cdSize + 22);
    let p = 0;
    for (const l of locals) { out.set(l, p); p += l.length; }
    for (const c of centrals) { out.set(c, p); p += c.length; }
    out.set(eocd, p);
    return out;
  }

  const xmlEsc = (s) => String(s == null ? "" : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  function colName(i) {
    let s = "", n = i + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="10"/><name val="Calibri"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="10"/><color rgb="FF9A3412"/><name val="Calibri"/></font>
</fonts>
<fills count="8">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFEDD5"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEF9C3"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFE5E7EB"/></left><right style="thin"><color rgb="FFE5E7EB"/></right><top style="thin"><color rgb="FFE5E7EB"/></top><bottom style="thin"><color rgb="FFE5E7EB"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="7" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

  function sheetXml(sh) {
    const rows = sh.rows || [];
    const styles = sh.styles || [];
    const maxCol = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const lastRef = `${colName(Math.max(0, maxCol - 1))}${Math.max(1, rows.length)}`;
    const freeze = sh.freeze || { rows: 1, cols: 0 };
    const topLeft = `${colName(freeze.cols)}${freeze.rows + 1}`;
    const pane = `<pane xSplit="${freeze.cols}" ySplit="${freeze.rows}" topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/>` +
      `<selection pane="bottomRight" activeCell="${topLeft}" sqref="${topLeft}"/>`;
    const widths = sh.widths || [];
    const cols = widths.length
      ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
      : "";
    const rowXml = rows.map((cells, ri) => {
      const ht = ri === 0 ? (sh.headHeight || 32) : (sh.rowHeight || 0);
      const attr = ht ? ` ht="${ht}" customHeight="1"` : "";
      const body = cells.map((v, ci) => {
        const text = v == null ? "" : String(v);
        if (!text) return "";
        const s = (styles[ri] && styles[ri][ci]) || 0;
        return `<c r="${colName(ci)}${ri + 1}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
      }).join("");
      return `<row r="${ri + 1}"${attr}>${body}</row>`;
    }).join("");
    const filter = sh.autoFilter === false ? "" : `<autoFilter ref="A1:${lastRef}"/>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS}"><dimension ref="A1:${lastRef}"/>
<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData>${rowXml}</sheetData>${filter}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>`;
  }

  /** @param {Array<{name:string, rows:string[][], styles?:number[][], widths?:number[], freeze?:{rows:number,cols:number}}>} sheets */
  function build(sheets) {
    const n = sheets.length;
    const overrides = sheets.map((_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
    const sheetTags = sheets.map((s, i) =>
      `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
    const sheetRels = sheets.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
    const files = [
      {
        name: "[Content_Types].xml",
        data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${overrides}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`)
      },
      {
        name: "_rels/.rels",
        data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`)
      },
      {
        name: "xl/workbook.xml",
        data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets>${sheetTags}</sheets></workbook>`)
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRels}<Relationship Id="rId${n + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>
</Relationships>`)
      },
      { name: "xl/styles.xml", data: enc.encode(STYLES_XML) }
    ];
    sheets.forEach((s, i) => files.push({
      name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s))
    }));
    return zipStore(files);
  }

  function download(filename, sheets) {
    const bytes = build(sheets);
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    return { blob, bytes };
  }

  return { STYLE, build, download, crc32, colName, sheetXml };
})();
