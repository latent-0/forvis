// Minimal PDF writer (for the synthetic dataset) and a text-layer reader (for intake).
// No dependencies. The reader handles uncompressed and FlateDecode content streams
// with standard-encoded fonts; anything it cannot read comes back empty, which the
// pipeline treats as low confidence and routes to a reviewer.
import zlib from 'node:zlib';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const FONTS = { R: 'F1', B: 'F2', I: 'F3', M: 'F4' };

// Approximate Helvetica advance widths (per 1pt of font size) for right-alignment.
function charWidth(ch, font) {
  if (font === 'M') return 0.6;
  if ('0123456789'.includes(ch)) return 0.556;
  if (',.: ;|il\'!'.includes(ch)) return 0.278;
  if ('-()/'.includes(ch)) return 0.333;
  if (ch >= 'A' && ch <= 'Z') return font === 'B' ? 0.72 : 0.667;
  if ('mw'.includes(ch)) return 0.833;
  return font === 'B' ? 0.556 : 0.5;
}
export function textWidth(str, size = 10, font = 'R') {
  let w = 0;
  for (const ch of String(str)) w += charWidth(ch, font);
  return w * size;
}

function rgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
}
function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7e]/g, '?');
}
const n = (v) => Number(v).toFixed(2);

export class PdfDoc {
  constructor({ title = 'Document', author = 'Synthetic', created = new Date() } = {}) {
    this.meta = { title, author, created };
    this.pages = [];
    this.newPage();
  }
  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    return this;
  }
  text(x, yTop, str, o = {}) {
    const f = FONTS[o.font || 'R'];
    const size = o.size || 10;
    let px = x;
    if (o.align === 'right') px = x - textWidth(str, size, o.font || 'R');
    this.ops.push(`BT /${f} ${size} Tf ${rgb(o.color || '#1a1a1a')} rg 1 0 0 1 ${n(px)} ${n(PAGE_H - yTop)} Tm (${esc(str)}) Tj ET`);
    return this;
  }
  line(x1, y1, x2, y2, o = {}) {
    this.ops.push(`${o.width || 0.6} w ${rgb(o.color || '#9a9a9a')} RG ${n(x1)} ${n(PAGE_H - y1)} m ${n(x2)} ${n(PAGE_H - y2)} l S`);
    return this;
  }
  rect(x, yTop, w, h, o = {}) {
    this.ops.push(`${rgb(o.fill || '#eeeeee')} rg ${n(x)} ${n(PAGE_H - yTop - h)} ${n(w)} ${n(h)} re f`);
    return this;
  }
  toBuffer() {
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    const catalog = add(null);
    const pagesObj = add(null);
    const fonts = [
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>'),
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
    ];
    const fontRes = `<< /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R /F3 ${fonts[2]} 0 R /F4 ${fonts[3]} 0 R >>`;
    const kids = [];
    for (const ops of this.pages) {
      const body = ops.join('\n');
      const content = add(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font ${fontRes} >> /Contents ${content} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const d = this.meta.created;
    const pdfDate = `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
    const info = add(`<< /Title (${esc(this.meta.title)}) /Author (${esc(this.meta.author)}) /Producer (Synthetic dataset generator) /CreationDate (${pdfDate}) >>`);

    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

// ---------- Text-layer reader ----------

function unescapePdfString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const nx = s[++i];
    if (nx === 'n') out += '\n';
    else if (nx === 'r') out += '\r';
    else if (nx === 't') out += '\t';
    else if (nx === 'b' || nx === 'f') out += '';
    else if (/[0-7]/.test(nx)) {
      let oct = nx;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1])) oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else if (nx === '\n' || nx === '\r') { /* line continuation */ }
    else out += nx;
  }
  return out;
}

function tokenize(content) {
  const toks = [];
  let i = 0;
  const L = content.length;
  while (i < L) {
    const c = content[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '%') { while (i < L && content[i] !== '\n') i++; continue; }
    if (c === '(') {
      let depth = 1, j = i + 1, s = '';
      while (j < L && depth > 0) {
        const d = content[j];
        if (d === '\\') { s += d + content[j + 1]; j += 2; continue; }
        if (d === '(') depth++;
        if (d === ')') { depth--; if (depth === 0) break; }
        s += d; j++;
      }
      toks.push({ t: 'str', v: unescapePdfString(s) });
      i = j + 1; continue;
    }
    if (c === '<' && content[i + 1] !== '<') {
      const j = content.indexOf('>', i);
      const hex = content.slice(i + 1, j).replace(/\s/g, '');
      let s = '';
      for (let k = 0; k < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      toks.push({ t: 'str', v: s });
      i = j + 1; continue;
    }
    if (c === '[') { toks.push({ t: '[' }); i++; continue; }
    if (c === ']') { toks.push({ t: ']' }); i++; continue; }
    if (c === '<' || c === '>') { i += 2; toks.push({ t: 'dict' }); continue; }
    let j = i;
    while (j < L && !/[\s()[\]<>%/]/.test(content[j])) j++;
    if (c === '/') { j = i + 1; while (j < L && !/[\s()[\]<>%/]/.test(content[j])) j++; toks.push({ t: 'name', v: content.slice(i, j) }); i = j; continue; }
    const word = content.slice(i, j) || content[i];
    if (/^[-+]?\d*\.?\d+$/.test(word)) toks.push({ t: 'num', v: parseFloat(word) });
    else toks.push({ t: 'op', v: word });
    i = j > i ? j : i + 1;
  }
  return toks;
}

function segmentsFromContent(content) {
  const toks = tokenize(content);
  const segs = [];
  let stack = [];
  let x = 0, y = 0, lx = 0, ly = 0, leading = 12;
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t !== 'op') { stack.push(tk); continue; }
    const op = tk.v;
    const nums = stack.filter((s) => s.t === 'num').map((s) => s.v);
    if (op === 'BT') { x = lx = 0; y = ly = 0; }
    else if (op === 'Tm' && nums.length >= 6) { x = lx = nums[nums.length - 2]; y = ly = nums[nums.length - 1]; }
    else if ((op === 'Td' || op === 'TD') && nums.length >= 2) { lx += nums[nums.length - 2]; ly += nums[nums.length - 1]; x = lx; y = ly; if (op === 'TD') leading = -nums[nums.length - 1]; }
    else if (op === 'TL' && nums.length) leading = nums[nums.length - 1];
    else if (op === 'T*') { ly -= leading; x = lx; y = ly; }
    else if (op === 'Tj' || op === "'" || op === '"') {
      if (op !== 'Tj') { ly -= leading; x = lx; y = ly; }
      const s = stack.filter((s) => s.t === 'str').map((s) => s.v).join('');
      if (s) segs.push({ x, y, s });
    } else if (op === 'TJ') {
      let s = '';
      for (const it of stack) {
        if (it.t === 'str') s += it.v;
        else if (it.t === 'num' && it.v < -200) s += ' ';
      }
      if (s) segs.push({ x, y, s });
    }
    stack = [];
  }
  return segs;
}

export function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  const segs = [];
  let pageOffset = 0;
  let idx = 0;
  while (true) {
    const sIdx = raw.indexOf('stream', idx);
    if (sIdx < 0) break;
    if (raw.slice(sIdx - 3, sIdx) === 'end') { idx = sIdx + 6; continue; }
    const dictStart = raw.lastIndexOf('<<', sIdx);
    const dict = raw.slice(dictStart, sIdx);
    let dataStart = sIdx + 6;
    if (raw[dataStart] === '\r') dataStart++;
    if (raw[dataStart] === '\n') dataStart++;
    const eIdx = raw.indexOf('endstream', dataStart);
    if (eIdx < 0) break;
    let data = buf.subarray(dataStart, eIdx);
    idx = eIdx + 9;
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject|\/FontFile/.test(dict)) continue;
    if (/FlateDecode/.test(dict)) {
      try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateRawSync(data); } catch { continue; } }
    } else if (/\/Filter/.test(dict)) continue;
    const content = data.toString('latin1');
    if (!/\bBT\b/.test(content)) continue;
    for (const s of segmentsFromContent(content)) segs.push({ ...s, y: s.y - pageOffset });
    pageOffset += 10000;
  }
  // Group into lines by y (top to bottom), then x.
  segs.sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
  const lines = [];
  let cur = null;
  for (const s of segs) {
    if (cur && Math.abs(cur.y - s.y) <= 2) cur.parts.push(s);
    else { cur = { y: s.y, parts: [s] }; lines.push(cur); }
  }
  return lines
    .map((l) => l.parts.sort((a, b) => a.x - b.x).map((p) => p.s.trim()).filter(Boolean).join('  '))
    .filter((l) => l.trim())
    .join('\n');
}
