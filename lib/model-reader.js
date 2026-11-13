// Model reader: sends a document to the language model with a fixed JSON schema, then
// checks every returned value against the source text (grounding).
import { DOC_TYPES, FIELD_KEYS } from '../public/shared/schema.js';
import { parseDate, parseAmount } from './extract.js';

// Reader settings come from the environment only (see .env.example).
const env = (k) => (process.env[k] || '').trim();
const API_URL = () => env('EXTRACTION_API_URL');
const TEXT_MODELS = () => env('EXTRACTION_TEXT_MODELS').split(',').map((s) => s.trim()).filter(Boolean);
const VISION_MODEL = () => env('EXTRACTION_VISION_MODEL') || TEXT_MODELS()[0];
// Optional per-model reasoning effort, e.g. "model-a:low,model-b:none".
const REASONING = () => Object.fromEntries(env('EXTRACTION_REASONING').split(',').map((p) => p.trim().split(/:(?=[^:]+$)/)).filter((p) => p.length === 2));
const apiKey = () => env('EXTRACTION_API_KEY');
export const modelAvailable = () => !!(apiKey() && API_URL() && TEXT_MODELS().length);

export class RateLimited extends Error {
  constructor(retryAfter) { super('Reader busy'); this.retryAfter = retryAfter; }
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...FIELD_KEYS, 'confidence', 'notes'],
  properties: {
    doc_type: { type: 'string', enum: DOC_TYPES },
    entity: { type: ['string', 'null'] },
    counterparty: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    amount: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'] },
    reference: { type: ['string', 'null'] },
    period_start: { type: ['string', 'null'] },
    period_end: { type: ['string', 'null'] },
    signatures: {
      type: ['array', 'null'],
      items: { type: 'object', additionalProperties: false, required: ['party', 'signed'], properties: { party: { type: 'string' }, signed: { type: 'boolean' } } },
    },
    confidence: { type: 'object', additionalProperties: false, required: FIELD_KEYS, properties: Object.fromEntries(FIELD_KEYS.map((k) => [k, { type: 'number' }])) },
    notes: { type: 'string' },
  },
};

const INSTRUCTIONS = `You read audit evidence documents and return fields in a fixed JSON schema.
Field meanings:
- doc_type: invoice, bank_statement, contract, confirmation (balance or bank confirmation letter), board_minutes, or other.
- entity: the company the evidence is about (the client being audited). It is usually NOT the company whose name heads the page.
  Invoice: the customer in the "Bill to", "Invoice to" or "Customer" block, never the supplier at the top.
  Bank statement: the "Account name". Contract: party (1). Confirmation letter: the company named after "Re:", never the author of the letter. Board minutes: the company holding the meeting.
- counterparty: the other party. Invoice: the supplier at the top. Statement: the bank. Contract: party (2). Confirmation: the company that wrote the letter (its letterhead).
- date: YYYY-MM-DD. Invoice date, statement period end, agreement date, confirmation "as at" date, or meeting date.
- amount: number only. Invoice gross total, statement closing balance, confirmed balance, or stated contract value. Null if none.
- currency: ISO code such as GBP or USD.
- reference: invoice number; for statements the last four digits of the account number only; agreement reference; confirmation "our reference"; board resolution reference written as BR-YYYY-MM.
- period_start, period_end: YYYY-MM-DD, statements only, otherwise null.
- amount for board_minutes is always null.
- signatures: contracts only, one entry per signature block; signed is true only if a signature is present in that block. Null for other types.
- confidence: 0 to 1 per field. Use below 0.8 when a value is unlabelled, unclear or inferred.
- notes: anything a reviewer should know, or an empty string.
Copy values as written; do not correct or reconcile them. Use null for anything the document does not contain. Never guess.`;

async function request(model, messages, strict) {
  const body = {
    model,
    temperature: 0,
    max_completion_tokens: 2500,
    messages,
    response_format: { type: 'json_schema', json_schema: { name: 'evidence_fields', strict, schema: SCHEMA } },
  };
  const effort = REASONING()[model];
  if (effort) body.reasoning_effort = effort;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(API_URL(), { method: 'POST', headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429) {
      const hdr = Number(res.headers.get('retry-after'));
      const msg = Number((String(json?.error?.message || '').match(/try again in ([\d.]+)s/) || [])[1]);
      throw new RateLimited(Math.ceil(hdr || msg || 5));
    }
    if (!res.ok) throw new Error(json?.error?.message || `Reader request failed (${res.status})`);
    return { out: JSON.parse(json.choices?.[0]?.message?.content || '{}'), usage: json.usage || null };
  } finally { clearTimeout(timer); }
}

// accept(out) -> number of problems (0 = good). A reader whose answer has problems hands
// over to the next; if none is clean, the answer with the fewest problems is returned.
export async function callModel({ text, images, accept = () => 0 }) {
  const vision = !text && images?.length;
  if (vision) {
    const content = [{ type: 'text', text: 'Extract the fields from this document.' }, ...images.slice(0, 3).map((url) => ({ type: 'image_url', image_url: { url } }))];
    return request(VISION_MODEL(), [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content }], false);
  }
  const messages = [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: `Document text (layout preserved, cells separated by two spaces):

${text.slice(0, 16000)}` }];
  let wait = Infinity;
  let lastError = null;
  let best = null;
  const models = TEXT_MODELS();
  for (const model of [...models, models[0]]) {
    try {
      const r = await request(model, messages, true);
      const problems = accept(r.out);
      if (problems === 0) return r;
      if (!best || problems < best.problems) best = { ...r, problems };
    } catch (e) {
      if (e instanceof RateLimited) { wait = Math.min(wait, e.retryAfter); continue; }
      lastError = e;
      console.warn(`reader ${model} failed: ${e.message}`);
    }
  }
  if (best && best.problems <= 1) return best;
  if (Number.isFinite(wait)) throw new RateLimited(wait);
  if (best) return best;
  throw lastError || new Error('Reader unavailable');
}

export function normaliseModelOutput(out) {
  const fields = Object.fromEntries(FIELD_KEYS.map((k) => [k, out[k] ?? null]));
  if (!DOC_TYPES.includes(fields.doc_type)) fields.doc_type = 'other';
  for (const k of ['date', 'period_start', 'period_end']) if (fields[k]) fields[k] = parseDate(fields[k]) || null;
  if (typeof fields.amount === 'string') fields.amount = parseAmount(fields.amount);
  if (fields.currency) fields.currency = String(fields.currency).toUpperCase().slice(0, 3);
  for (const k of ['entity', 'counterparty', 'reference']) if (typeof fields[k] === 'string') fields[k] = fields[k].trim() || null;
  if (fields.doc_type === 'bank_statement' && fields.reference) fields.reference = (String(fields.reference).match(/(\d{4})\D*$/) || [])[1] || fields.reference;
  if (fields.doc_type !== 'contract') fields.signatures = null;
  if (fields.doc_type === 'board_minutes') fields.amount = null;
  if (Array.isArray(fields.signatures)) fields.signatures = fields.signatures.map((s) => ({ party: String(s.party || 'Unnamed party'), signed: !!s.signed }));
  const confidence = Object.fromEntries(FIELD_KEYS.map((k) => [k, Math.max(0, Math.min(1, Number(out.confidence?.[k] ?? 0)))]));
  return { fields, confidence, notes: out.notes ? [String(out.notes)] : [] };
}

// ---------- grounding

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const MONTHS_L = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function dateForms(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const mon = MONTHS_L[m - 1];
  return [iso, `${dd}/${mm}/${y}`, `${d} ${mon} ${y}`, `${dd} ${mon} ${y}`, `${dd} ${mon.slice(0, 3)} ${y}`, `${d} ${mon.slice(0, 3)} ${y}`, `${dd}-${mon.slice(0, 3)}-${y}`, `${mon} ${d}, ${y}`];
}
function grounded(k, v, text, low, flat) {
  if (v == null || k === 'doc_type' || k === 'signatures' || k === 'currency') return true;
  if (k === 'amount') {
    const a = Math.abs(Number(v));
    return [a.toFixed(2), a.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), ...(Number.isInteger(a) ? [a.toLocaleString('en-GB')] : [])].some((f) => text.includes(f));
  }
  if (k === 'date' || k === 'period_start' || k === 'period_end') return dateForms(v).some((f) => low.includes(f));
  const sv = squash(v);
  if (!sv) return false;
  if (flat.includes(sv)) return true;
  const core = squash(String(v).replace(/\b(ltd|limited|plc|llp|inc)\b\.?/gi, ''));
  return core.length >= 4 && flat.includes(core);
}
export function applyGrounding(result, text) {
  const low = text.toLowerCase().replace(/\s+/g, ' ');
  const flat = squash(text);
  const missing = [];
  for (const k of FIELD_KEYS) {
    if (!grounded(k, result.fields[k], text, low, flat)) {
      result.confidence[k] = Math.min(result.confidence[k], 0.6);
      missing.push(k);
    }
  }
  result.ungrounded = missing;
  if (missing.length) result.notes.push(`Not found as written in the document: ${missing.join(', ').replace(/_/g, ' ')}. Check against the original.`);
  return result;
}
