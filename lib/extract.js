// Extraction (server side only). Reads a document and returns a fixed set of fields
// with per-field confidence. A language model reads the document against a fixed JSON
// schema; every value it returns is then checked against the source text, and values
// that cannot be traced lose confidence. Without a model key, labelled-field rules run.
// The workflow downstream never trusts the reader's opinion; the coded rules decide flags.
import { extractPdfText } from './pdf.js';
import { DOC_TYPES, FIELD_KEYS, REQUIRED, overallConfidence } from '../public/shared/schema.js';

export { DOC_TYPES, FIELD_KEYS, REQUIRED, overallConfidence };

import { callModel, normaliseModelOutput, applyGrounding, modelAvailable, RateLimited } from './model-reader.js';

// ------------------------------------------------------------ helpers

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };
const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const pad = (n) => String(n).padStart(2, '0');
const valid = (y, m, d) => y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null;

export function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim().toLowerCase();
  let m;
  if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return valid(+m[1], +m[2], +m[3]);
  if ((m = t.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/))) return valid(+m[3], +m[2], +m[1]); // UK day first
  if ((m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})[\s-,]+(\d{4})\b/))) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[2].slice(0, 3)));
    if (mi >= 0) return valid(+m[3], mi + 1, +m[1]);
  }
  if ((m = t.match(/\b([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/))) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[1].slice(0, 3)));
    if (mi >= 0) return valid(+m[3], mi + 1, +m[2]);
  }
  return null;
}

// "the twenty-fourth day of september two thousand and twenty six"
function parseWordDate(t) {
  const s = t.toLowerCase();
  const m = s.match(/(?:the\s+)?([a-z-]+(?:[\s-][a-z]+)?)\s+day\s+of\s+([a-z]+)\s+two\s+thousand(?:\s+and)?\s+([a-z\s-]+)/);
  if (!m) return null;
  const dayWords = m[1].split(/[\s-]/);
  let day = 0;
  for (const w of dayWords) day += w === 'twenty' ? 20 : w === 'thirty' ? 30 : ORD[w] || 0;
  const mi = MONTHS.indexOf(m[2]);
  const yw = m[3].trim().split(/[\s-]+/);
  let y = 2000;
  for (const w of yw) { if (w === 'twenty') y += 20; else if (w === 'ten') y += 10; else if (UNITS[w]) y += UNITS[w]; else break; }
  return mi >= 0 && day ? valid(y, mi + 1, day) : null;
}

export function parseAmount(s) {
  if (s == null) return null;
  const m = String(s).replace(/\s/g, ' ').match(/(-)?\s*(?:[A-Z]{3}|£|\$|€)?\s*(-)?([\d]{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[3].replace(/,/g, ''));
  return Number.isFinite(v) ? (m[1] || m[2] ? -v : v) : null;
}
function parseCurrency(s) {
  const m = String(s || '').match(/\b(GBP|USD|EUR)\b|([£$€])/);
  if (!m) return null;
  return m[1] || { '£': 'GBP', $: 'USD', '€': 'EUR' }[m[2]];
}

const SUFFIX = { ltd: 'Ltd', plc: 'plc', llp: 'LLP', inc: 'Inc', gmbh: 'GmbH', limited: 'Limited' };
export function titleCase(name) {
  if (!name) return name;
  return name.toLowerCase().split(/\s+/).map((w) => SUFFIX[w.replace(/[.,]/g, '')] || (w === '&' ? '&' : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

// ------------------------------------------------------------ local parser

export function parseLocal(text) {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = lines.map((l) => l.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean));
  const fields = Object.fromEntries(FIELD_KEYS.map((k) => [k, null]));
  const conf = Object.fromEntries(FIELD_KEYS.map((k) => [k, 0]));
  const notes = [];
  const set = (k, v, c) => { if (v != null && v !== '') { fields[k] = v; conf[k] = c; } };

  // Value in the cell after a label cell, or inline after "Label:" in the same cell.
  // Exact label cells win over inline matches anywhere in the document.
  const after = (re) => {
    for (const cells of rows) {
      for (let i = 0; i < cells.length - 1; i++) if (re.test(cells[i])) return cells[i + 1];
    }
    const inlineRe = new RegExp(`^(?:${re.source.replace(/^\^|\$$/g, '')})\\s*:?\\s+(.+)$`, 'i');
    for (const cells of rows) {
      for (const c of cells) {
        const m = c.match(inlineRe);
        if (m) return m[m.length - 1];
      }
    }
    return null;
  };
  const below = (re) => {
    for (let r = 0; r < rows.length - 1; r++) if (re.test(rows[r][0] || '')) return rows[r + 1][0];
    return null;
  };

  if (!lines.length) {
    notes.push('No readable text layer. The document may be an image or a scanned PDF.');
    return { fields, confidence: conf, notes };
  }
  const head = lines.slice(0, 3).join(' ');
  const all = lines.join('\n');

  let type = 'other', tc = 0.3;
  if (/\binvoice\b/i.test(head) || /\b(inv\. no|invoice no|invoice number)\b/i.test(all)) { type = 'invoice'; tc = 0.97; }
  else if (/statement of account|statement period/i.test(all)) { type = 'bank_statement'; tc = 0.97; }
  else if (/minutes of a meeting of the board/i.test(all)) { type = 'board_minutes'; tc = 0.97; }
  else if (/\bminutes\b/i.test(all) && /\b(director|board)/i.test(all)) { type = 'board_minutes'; tc = 0.7; }
  else if (/\bconfirmation\b/i.test(all) && /\bwe confirm\b/i.test(all)) { type = 'confirmation'; tc = 0.95; }
  else if (/\b(agreement|licence|lease)\b/i.test(all) && /\bbetween\b/i.test(all)) { type = 'contract'; tc = 0.95; }
  set('doc_type', type, tc);

  if (type === 'invoice') {
    set('counterparty', rows[0][0], 0.9);
    set('reference', after(/^(invoice no:?|invoice number|inv\. no\.?)$/i), 0.97);
    const ds = after(/^(invoice date:?|date of issue|tax point|date:?)$/i);
    set('date', parseDate(ds), parseDate(ds) ? 0.95 : 0);
    set('entity', below(/^(bill to:?|invoice to|customer|sold to:?)$/i), 0.93);
    const tot = after(/^(total due|amount due|total|invoice total)$/i);
    set('amount', parseAmount(tot), 0.96);
    set('currency', parseCurrency(tot), 0.95);
  } else if (type === 'bank_statement') {
    set('counterparty', rows[0][0], 0.9);
    set('entity', after(/^account name$/i), 0.96);
    const acct = after(/^account number$/i) || '';
    const last4 = (acct.match(/\*+\s*(\d{4})\b/) || acct.match(/(\d{4})\s*$/) || [])[1];
    set('reference', last4 || null, 0.95);
    const per = after(/^statement period$/i) || '';
    const [ps, pe] = per.split(/\s+(?:to|-|–)\s+/);
    set('period_start', parseDate(ps), 0.95);
    set('period_end', parseDate(pe), 0.95);
    set('date', fields.period_end, conf.period_end);
    const cb = after(/^closing balance$/i);
    set('amount', parseAmount(cb), 0.96);
    set('currency', parseCurrency(cb) || parseCurrency(after(/^currency$/i)), 0.95);
  } else if (type === 'contract') {
    const dm = all.match(/\bdated\s+(?:the\s+)?([^\n]+)/i);
    set('date', parseDate(dm && dm[1]), 0.94);
    set('reference', after(/^(agreement reference|reference|contract no\.?)$/i), 0.95);
    const parties = [];
    for (const l of lines) {
      const m = l.match(/^\((\d)\)\s+(.+?)(?:,|\(|;|$)/);
      if (m) parties.push(titleCase(m[2].trim()));
    }
    if (parties[0]) set('entity', parties[0], 0.88);
    if (parties[1]) set('counterparty', parties[1], 0.88);
    const cv = all.match(/contract value:?\s*([A-Z]{3}\s*[\d,]+\.\d{2})/i);
    if (cv) { set('amount', parseAmount(cv[1]), 0.93); set('currency', parseCurrency(cv[1]), 0.93); }
    const sigs = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^signed (?:for and )?on behalf of\s+(.+)$/i);
      if (!m) continue;
      const sigRow = rows.slice(i + 1, i + 4).find((c) => /^signature:?$/i.test(c[0]));
      sigs.push({ party: titleCase(m[1].trim()), signed: !!(sigRow && sigRow[1]) });
    }
    if (sigs.length) set('signatures', sigs, 0.9);
    else notes.push('No signature blocks found.');
  } else if (type === 'confirmation') {
    set('counterparty', rows[0][0], 0.9);
    set('entity', after(/^re:?$/i), 0.94);
    set('reference', after(/^(our reference:?|our ref:?|reference:?)$/i), 0.94);
    set('date', parseDate(after(/^(as at:?|as of:?)$/i)), 0.94);
    const cb = after(/^(confirmed balance|balance)$/i);
    set('amount', parseAmount(cb), 0.95);
    set('currency', parseCurrency(cb), 0.95);
  } else if (type === 'board_minutes') {
    const ent = lines.find((l) => /\b(ltd|plc|limited|llp)\b/i.test(l));
    const labelled = after(/^date of meeting$/i);
    set('entity', ent ? titleCase(ent.split(/\s{2,}/)[0]) : null, ent === lines[0] && ent === ent.toUpperCase() ? 0.93 : 0.7);
    if (labelled) set('date', parseDate(labelled), 0.95);
    else {
      const wd = parseWordDate(all) || parseDate(all);
      set('date', wd, 0.6);
      if (wd) notes.push('Meeting date read from narrative text, not a labelled field.');
    }
    const ref = after(/^resolution reference$/i);
    if (ref) set('reference', ref, 0.95);
    else {
      const m = all.match(/\b(BR)[\s-]*(\d{4})[\s/-]+(\d{2})\b/i);
      if (m) { set('reference', `${m[1].toUpperCase()}-${m[2]}-${m[3]}`, 0.55); notes.push(`Resolution reference normalised from "${m[0]}".`); }
    }
  } else {
    notes.push('Document type not recognised.');
  }
  return { fields, confidence: conf, notes };
}



// ------------------------------------------------------------ entry point

// input: { fileName, mime, data?: base64 file, images?: data URLs of rendered pages for scanned PDFs }
export async function extractDocument({ fileName, mime, data, images, allowFallback = false }) {
  const t0 = Date.now();
  const isPdf = mime === 'application/pdf';
  const isImage = /^image\//.test(mime || '');
  const buffer = data ? Buffer.from(data, 'base64') : null;
  const text = isPdf && buffer ? extractPdfText(buffer) : '';
  const hasText = text.replace(/\s/g, '').length > 20;
  const pageImages = isImage && data ? [`data:${mime};base64,${data}`] : (images || []);

  if (isPdf && !hasText && !pageImages.length && modelAvailable()) return { needImages: true };

  let result = null;
  let engine = 'rules';
  let fallbackReason = null;
  let usage = null;
  if (modelAvailable() && (hasText || pageImages.length)) {
    try {
      // Problems = required values that are implausible or cannot be found in the text.
      const accept = (out) => {
        if (!hasText) return 0;
        const probe = applyGrounding(normaliseModelOutput(out), text);
        const req = REQUIRED[probe.fields.doc_type] || REQUIRED.other;
        const implausible = ['entity', 'counterparty'].filter((k) => probe.fields[k] != null && !/[a-z]{3}/i.test(probe.fields[k]));
        return new Set([...(probe.ungrounded || []).filter((k) => req.includes(k)), ...implausible]).size;
      };
      const r = await callModel({ text: hasText ? text : '', images: hasText ? null : pageImages, accept });
      result = normaliseModelOutput(r.out);
      usage = r.usage;
      engine = 'ai';
      if (hasText) applyGrounding(result, text);
      else for (const k of FIELD_KEYS) result.confidence[k] = Math.min(result.confidence[k], 0.85);
    } catch (e) {
      // A busy reader is not a failure: tell the caller to retry instead of degrading.
      if (e instanceof RateLimited && !allowFallback) return { retryAfter: e.retryAfter };
      fallbackReason = e.name === 'AbortError' ? 'Reader timed out' : e.message;
    }
  }
  if (!result) {
    result = parseLocal(text);
    if (!hasText) result.notes.push('No readable text. Sent to the reviewer.');
  }
  // A required value that cannot be traced to the source keeps the document below the threshold.
  let overall = overallConfidence(result.fields, result.confidence);
  const req = REQUIRED[result.fields.doc_type] || REQUIRED.other;
  if ((result.ungrounded || []).some((k) => req.includes(k))) overall = Math.min(overall, 0.7);
  return {
    fields: result.fields,
    confidence: result.confidence,
    overall,
    notes: result.notes,
    text,
    engine,
    fallbackReason,
    usage,
    ms: Date.now() - t0,
  };
}
