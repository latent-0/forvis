// Workflow engine (runs in the browser). Holds the case store, the untouched originals,
// the hash-chained audit log and the review decisions in IndexedDB. The only server call
// is /api/extract, which reads one document and keeps nothing.
import { DOC_TYPES, FIELD_KEYS, overallConfidence } from './shared/schema.js';
import { matchDocument, runRules, norm, normRef, RULES } from './shared/rules.js';
import { computeResults } from './shared/metrics.js';

export const PERSONAS = {
  client: { id: 'client', name: 'J. Okafor', title: 'Finance Manager, Northwind Components', role: 'Client uploader' },
  reviewer: { id: 'reviewer', name: 'A. Lindqvist', title: 'Audit Associate', role: 'Reviewer' },
  approver: { id: 'approver', name: 'M. Reyes', title: 'Audit Manager', role: 'Approver' },
};
const SYS = {
  intake: { actor: 'Intake service', role: 'System' },
  ai: { actor: 'Extraction', role: 'AI' },
  match: { actor: 'Matching service', role: 'System' },
  rules: { actor: 'Rules engine', role: 'Rules' },
};
const DEFAULT_REGISTER = [
  { id: 'UC-01', useCase: 'Evidence intake and matching', serviceLine: 'Audit and assurance', family: 'Document intelligence', model: 'Language model, fixed field schema, source-text check', dataSource: 'Synthetic dataset v1: 25 documents, 15-item request list, purchase ledger sample, trial balance extract', owner: 'M. Reyes, Audit Manager', humanControl: 'Reviewer approves, edits or rejects every document. Manager signs off.', status: 'POC', notes: 'Synthetic data only. No client data.' },
  { id: 'UC-02', useCase: 'Tax notice triage', serviceLine: 'Tax', family: 'Document intelligence', model: 'Not selected', dataSource: 'Not agreed', owner: 'To be named', humanControl: 'Tax manager approves each draft response.', status: 'Proposed', notes: '' },
  { id: 'UC-03', useCase: 'Invoice to ledger', serviceLine: 'Outsourcing', family: 'Process automation', model: 'Not selected', dataSource: 'Not agreed', owner: 'To be named', humanControl: 'Accountant approves exceptions before posting.', status: 'Proposed', notes: '' },
];
const REGISTER_STATUSES = ['Proposed', 'POC', 'Pilot', 'Live', 'Paused', 'Stopped'];
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
export const mimeFor = (name) => MIME[String(name).split('.').pop().toLowerCase()] || null;
export const MAX_BYTES = 3 * 1024 * 1024;
const CONCURRENCY = 3;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const err = (s, m) => new HttpError(s, m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

export function laneFor(flags) {
  if (flags.some((f) => f.severity === 'flag')) return 'flagged';
  if (flags.some((f) => f.code === 'LOW_CONFIDENCE')) return 'low_confidence';
  return 'clean';
}

// ---------------------------------------------------------------- storage

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('evidence-intake', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('docs', { keyPath: 'id' });
        d.createObjectStore('files');
        d.createObjectStore('audit', { keyPath: 'seq' });
        d.createObjectStore('kv');
        d.createObjectStore('batches', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const req = fn(s);
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const put = (store, val, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(val) : s.put(val, key)));
const all = (store) => tx(store, 'readonly', (s) => s.getAll());
const clear = (store) => tx(store, 'readwrite', (s) => s.clear());
const kvGet = async (k, fallback) => { const v = await get('kv', k); return v === undefined ? fallback : v; };
const kvSet = (k, v) => put('kv', v, k);
async function lastAudit() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction('audit').objectStore('audit').openCursor(null, 'prev');
    r.onsuccess = () => resolve(r.result ? r.result.value : null);
    r.onerror = () => reject(r.error);
  });
}

// Serialise writers across tabs (Web Locks), with an in-page fallback.
let localChain = Promise.resolve();
function withLock(name, fn) {
  if (navigator.locks?.request) return navigator.locks.request(name, fn);
  const run = localChain.then(fn, fn);
  localChain = run.catch(() => {});
  return run;
}

async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------- events

const bus = new EventTarget();
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('evidence-intake') : null;
function emit(ev, broadcast = true) {
  bus.dispatchEvent(new CustomEvent('change', { detail: ev }));
  if (broadcast && channel) channel.postMessage(ev);
}
if (channel) channel.onmessage = (m) => emit(m.data, false);
export const onChange = (fn) => bus.addEventListener('change', (e) => fn(e.detail));

// ---------------------------------------------------------------- audit

const hashEntry = (prev, e) => sha256Hex([prev, e.ts, e.case_id || '', e.batch_id || '', e.actor, e.role, e.action, e.detail].join('|'));

async function audit({ caseId = null, batchId = null, actor, role, action, detail = {} }) {
  const entry = await withLock('evidence-audit', async () => {
    const last = await lastAudit();
    const e = { seq: (last?.seq || 0) + 1, ts: nowIso(), case_id: caseId, batch_id: batchId, actor, role, action, detail: JSON.stringify(detail) };
    e.prev_hash = last?.hash || 'GENESIS';
    e.hash = await hashEntry(e.prev_hash, e);
    await put('audit', e);
    return e;
  });
  emit({ type: 'audit', entry: { ...entry, detail } });
  return entry;
}
async function verifyChain() {
  const rows = (await all('audit')).sort((a, b) => a.seq - b.seq);
  let prev = 'GENESIS';
  for (const r of rows) {
    if (r.prev_hash !== prev || (await hashEntry(prev, r)) !== r.hash) return { ok: false, entries: rows.length, brokenAt: r.seq };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length, head: prev };
}

// ---------------------------------------------------------------- reference data

let scenarioP = null, answersP = null;
export const scenario = () => (scenarioP ||= fetch('/dataset/scenario.json').then((r) => r.json()));
const answerSheet = () => (answersP ||= fetch('/dataset/answer-sheet.json').then((r) => r.json()));
const threshold = () => kvGet('threshold', 0.8);

const docsAll = async () => (await all('docs')).sort((a, b) => a.seq - b.seq);
const getDoc = async (id) => { const d = await get('docs', id); if (!d) throw err(404, 'Document not found'); return d; };
const saveDoc = async (d) => { await put('docs', d); emit({ type: 'doc', id: d.id, stage: d.stage }); return d; };

// ---------------------------------------------------------------- pipeline

const queue = [];
let active = 0;

async function ingest(files, persona, pace) {
  const sc = await scenario();
  const batchId = `B-${nowIso().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
  await put('batches', { id: batchId, uploaded_by: persona.name, created_at: nowIso(), count: files.length });
  await audit({ batchId, actor: persona.name, role: persona.role, action: 'batch.uploaded', detail: { files: files.length } });
  const ids = [];
  for (const f of files) {
    const sha256 = await sha256Hex(f.buffer);
    const { id, seq } = await withLock('evidence-caseid', async () => {
      const n = (await kvGet('caseCounter', 0)) + 1;
      await kvSet('caseCounter', n);
      return { seq: n, id: `EV-${sc.engagement.yearEnd.slice(0, 4)}-${String(n).padStart(4, '0')}` };
    });
    await put('files', f.buffer, id);
    const doc = {
      seq, id, batch_id: batchId, file_name: f.name, mime: f.mime, size: f.buffer.byteLength, sha256,
      uploaded_by: persona.name, received_at: nowIso(), stage: 'received', started_at: null, queued_at: null, paced_ms: 0,
      text: '', extraction: null, fields: null, confidence: null, overall: null, match: null, flags: null, edited: false,
      review_status: 'pending', reviewed_by: null, reviewed_at: null, review_note: null, signoff_by: null, signoff_at: null, error: null,
    };
    await saveDoc(doc);
    await audit({ caseId: id, batchId, ...SYS.intake, action: 'document.received', detail: { file: f.name, bytes: f.buffer.byteLength, sha256, mime: f.mime, uploadedBy: persona.name } });
    ids.push(id);
    queue.push({ id, pace });
  }
  emit({ type: 'batch', batchId });
  pump();
  return { batchId, ids };
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    process(job).catch((e) => fail(job.id, e)).finally(() => { active--; pump(); });
  }
}
export const busy = () => active + queue.length;

async function fail(id, e) {
  const d = await get('docs', id);
  if (d) await saveDoc({ ...d, stage: 'error', error: String(e.message || e) });
  await audit({ caseId: id, ...SYS.intake, action: 'processing.failed', detail: { error: String(e.message || e) } });
}

async function renderPdfPages(buffer) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
  const out = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 3); i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1.6 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    out.push(c.toDataURL('image/jpeg', 0.82));
  }
  return out;
}

async function callExtract(payload) {
  let tries = 0;
  for (;;) {
    const res = await fetch('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, final: tries >= 8 }) });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429 && tries < 8) { tries++; await sleep(Math.min(20, json.retryAfter || 5) * 1000); continue; }
    if (!res.ok) throw new Error(json.error || `Extraction failed (${res.status})`);
    return json;
  }
}

async function process({ id, pace }) {
  let paced = 0;
  const wait = async () => { if (pace) { await sleep(pace); paced += pace; } };
  let d = await getDoc(id);
  d = await saveDoc({ ...d, stage: 'extracting', started_at: nowIso() });
  await wait();

  const buffer = await get('files', id);
  let ex = await callExtract({ fileName: d.file_name, mime: d.mime, data: toBase64(buffer) });
  if (ex.needImages) ex = await callExtract({ fileName: d.file_name, mime: d.mime, images: await renderPdfPages(buffer) });
  if (ex.fallbackReason) await audit({ caseId: id, ...SYS.ai, action: 'extraction.fallback', detail: { reason: 'Reader unavailable; labelled-field rules used' } });
  const confidence = { ...ex.confidence, overall: ex.overall };
  await audit({ caseId: id, ...SYS.ai, action: 'extraction.completed', detail: { ms: ex.ms, overall: ex.overall, fields: ex.fields, confidence: ex.confidence, notes: ex.notes } });
  d = await saveDoc({ ...(await getDoc(id)), text: ex.text || '', fields: ex.fields, confidence, overall: ex.overall, stage: 'matching' });
  await wait();

  const sc = await scenario();
  const match = matchDocument(ex.fields, sc);
  await audit({ caseId: id, ...SYS.match, action: 'match.completed', detail: { requestId: match.requestId, ledgerLine: match.ledgerLine || null, basis: match.basis, score: match.score } });
  d = await saveDoc({ ...(await getDoc(id)), match, stage: 'checking' });
  await wait();

  const flags = runRules({ id, sha256: d.sha256, fields: ex.fields, confidence, match }, sc, { others: await others(id), threshold: await threshold() });
  await audit({ caseId: id, ...SYS.rules, action: 'rules.checked', detail: { flags: flags.map((f) => f.code), results: flags } });
  const queuedAt = nowIso();
  d = await saveDoc({
    ...(await getDoc(id)),
    extraction: { engine: ex.engine, fields: ex.fields, confidence, notes: ex.notes, initialMatch: match, initialFlags: flags.map((f) => f.code), extractMs: ex.ms },
    match, flags, stage: 'queued', queued_at: queuedAt, paced_ms: paced,
  });
  await audit({ caseId: id, ...SYS.intake, action: 'queued.for.review', detail: { lane: laneFor(flags), msFromUpload: Date.parse(queuedAt) - Date.parse(d.received_at) - paced } });

  // A later document can make an earlier-numbered one a duplicate; re-check those.
  if (ex.fields.reference) {
    for (const o of await others(id)) {
      if (o.id > id && normRef(o.fields.reference) === normRef(ex.fields.reference) && norm(o.fields.counterparty) === norm(ex.fields.counterparty)) {
        await recheck(o.id, SYS.rules, 'duplicate check after a related document arrived');
      }
    }
  }
}

async function others(id) {
  return (await docsAll()).filter((d) => d.id !== id && d.fields).map((d) => ({ id: d.id, sha256: d.sha256, fileName: d.file_name, fields: d.fields }));
}

async function recheck(id, who, reason) {
  const d = await getDoc(id);
  if (!d.fields) return d;
  const sc = await scenario();
  const match = matchDocument(d.fields, sc);
  const flags = runRules({ id, sha256: d.sha256, fields: d.fields, confidence: d.confidence, match }, sc, { others: await others(id), threshold: await threshold() });
  const before = (d.flags || []).map((f) => f.code);
  const next = { ...d, match, flags };
  if (d.review_status === 'pending' && !d.edited && d.extraction && reason.startsWith('duplicate')) next.extraction = { ...d.extraction, initialFlags: flags.map((f) => f.code) };
  await saveDoc(next);
  await audit({ caseId: id, actor: who.actor || who.name, role: who.role, action: 'rules.rerun', detail: { reason, before, after: flags.map((f) => f.code), requestId: match.requestId } });
  return next;
}

// Documents left mid-way (for example the tab closed) are picked up again.
export async function resume() {
  const stale = (await docsAll()).filter((d) => !['queued', 'error'].includes(d.stage));
  for (const d of stale) if (!queue.some((q) => q.id === d.id)) queue.push({ id: d.id, pace: 0 });
  pump();
}

// ---------------------------------------------------------------- decisions

function sanitizeFields(input, current) {
  const out = { ...current };
  const str = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 200));
  for (const k of ['entity', 'counterparty', 'currency', 'reference']) if (k in input) out[k] = str(input[k]);
  if (out.currency) out.currency = out.currency.toUpperCase().slice(0, 3);
  if ('doc_type' in input) { if (!DOC_TYPES.includes(input.doc_type)) throw err(400, 'Unknown document type.'); out.doc_type = input.doc_type; }
  for (const k of ['date', 'period_start', 'period_end']) {
    if (!(k in input)) continue;
    const v = str(input[k]);
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw err(400, `${k.replace('_', ' ')} must be YYYY-MM-DD.`);
    out[k] = v;
  }
  if ('amount' in input) {
    const v = input.amount;
    if (v == null || String(v).trim() === '') out.amount = null;
    else { const n = Number(String(v).replace(/[, ]/g, '')); if (!Number.isFinite(n)) throw err(400, 'Amount must be a number.'); out.amount = Math.round(n * 100) / 100; }
  }
  if ('signatures' in input) out.signatures = Array.isArray(input.signatures) ? input.signatures.map((s) => ({ party: str(s.party) || 'Unnamed party', signed: !!s.signed })) : null;
  return out;
}

async function edit(id, input, p) {
  const d = await getDoc(id);
  if (d.review_status !== 'pending') throw err(409, 'Reopen the document before editing it.');
  const clean = sanitizeFields(input, d.fields);
  const changes = FIELD_KEYS.filter((k) => JSON.stringify(clean[k]) !== JSON.stringify(d.fields[k])).map((k) => ({ field: k, from: d.fields[k], to: clean[k] }));
  if (!changes.length) return d;
  const confidence = { ...d.confidence };
  for (const c of changes) confidence[c.field] = 1;
  confidence.overall = overallConfidence(clean, confidence);
  await saveDoc({ ...d, fields: clean, confidence, overall: confidence.overall, edited: true });
  await audit({ caseId: id, actor: p.name, role: p.role, action: 'fields.edited', detail: { changes } });
  return recheck(id, SYS.rules, 'fields edited by reviewer');
}
async function approve(id, note, p) {
  const d = await getDoc(id);
  if (d.stage !== 'queued') throw err(409, 'Document is still processing.');
  if (d.review_status !== 'pending') throw err(409, `Document is already ${d.review_status}.`);
  const open = (d.flags || []).filter((f) => f.severity === 'flag');
  if (open.length && (!note || note.trim().length < 5)) throw err(400, 'This document has open flags. Record why you accept them before approving.');
  await saveDoc({ ...d, review_status: 'approved', reviewed_by: p.name, reviewed_at: nowIso(), review_note: note || null });
  await audit({ caseId: id, actor: p.name, role: p.role, action: 'review.approved', detail: { note: note || null, exceptionsAccepted: open.map((f) => f.code), warnings: (d.flags || []).filter((f) => f.severity === 'warning').map((f) => f.code) } });
}
async function reject(id, reason, p) {
  const d = await getDoc(id);
  if (d.stage !== 'queued') throw err(409, 'Document is still processing.');
  if (d.review_status !== 'pending') throw err(409, `Document is already ${d.review_status}.`);
  if (!reason || reason.trim().length < 5) throw err(400, 'Give a reason for rejecting this document.');
  await saveDoc({ ...d, review_status: 'rejected', reviewed_by: p.name, reviewed_at: nowIso(), review_note: reason });
  await audit({ caseId: id, actor: p.name, role: p.role, action: 'review.rejected', detail: { reason, flags: (d.flags || []).map((f) => f.code) } });
}
async function reopen(id, p) {
  const d = await getDoc(id);
  if (d.signoff_at) throw err(409, 'Signed-off documents cannot be reopened.');
  if (d.review_status === 'pending') return;
  await saveDoc({ ...d, review_status: 'pending', reviewed_by: null, reviewed_at: null, review_note: null });
  await audit({ caseId: id, actor: p.name, role: p.role, action: 'review.reopened', detail: { previous: d.review_status } });
}
async function signoff(id, p) {
  const d = await getDoc(id);
  if (d.review_status !== 'approved') throw err(409, 'Only approved documents can be signed off.');
  if (d.signoff_at) return;
  if (d.reviewed_by === p.name) throw err(409, 'The approver cannot sign off their own review.');
  await saveDoc({ ...d, signoff_by: p.name, signoff_at: nowIso() });
  await audit({ caseId: id, actor: p.name, role: p.role, action: 'signoff.completed', detail: { reviewedBy: d.reviewed_by, reviewedAt: d.reviewed_at } });
}

// ---------------------------------------------------------------- views of the data

const summary = (d) => ({
  id: d.id, batch_id: d.batch_id, file_name: d.file_name, mime: d.mime, size: d.size, sha256: d.sha256, stage: d.stage,
  received_at: d.received_at, queued_at: d.queued_at, overall: d.overall,
  doc_type: d.fields?.doc_type || null, counterparty: d.fields?.counterparty || null, reference: d.fields?.reference || null, amount: d.fields?.amount ?? null, currency: d.fields?.currency || null,
  requestId: d.match?.requestId || null, ledgerLine: d.match?.ledgerLine || null,
  flags: (d.flags || []).map((f) => ({ code: f.code, severity: f.severity, title: f.title })),
  lane: d.flags ? laneFor(d.flags) : null, edited: d.edited,
  review_status: d.review_status, reviewed_by: d.reviewed_by, signoff_by: d.signoff_by, signoff_at: d.signoff_at, error: d.error,
});

function coverage(sc, docs) {
  return sc.requests.map((r) => {
    const linked = docs.filter((d) => d.match?.requestId === r.id && d.review_status !== 'rejected');
    const approved = linked.filter((d) => d.review_status === 'approved').length;
    const flagged = linked.filter((d) => (d.flags || []).some((f) => f.severity === 'flag')).length;
    let status = 'Outstanding';
    if (linked.length) status = approved >= r.expectedCount ? 'Complete' : flagged ? 'Exceptions' : linked.length >= r.expectedCount ? 'Received' : 'Partial';
    return { ...r, received: linked.length, approved, flagged, status };
  });
}

async function state() {
  const [sc, docs, thr, mm] = await Promise.all([scenario(), docsAll(), threshold(), kvGet('manualMinutes', 6)]);
  const count = (fn) => docs.filter(fn).length;
  return {
    engagement: sc.engagement,
    personas: PERSONAS,
    threshold: thr,
    manualMinutes: mm,
    processing: busy(),
    counts: {
      total: docs.length,
      processing: count((d) => d.stage !== 'queued' && d.stage !== 'error'),
      queued: count((d) => d.stage === 'queued'),
      flagged: count((d) => d.flags && laneFor(d.flags) === 'flagged'),
      lowConfidence: count((d) => d.flags && laneFor(d.flags) === 'low_confidence'),
      clean: count((d) => d.flags && laneFor(d.flags) === 'clean'),
      pending: count((d) => d.stage === 'queued' && d.review_status === 'pending'),
      approved: count((d) => d.review_status === 'approved'),
      rejected: count((d) => d.review_status === 'rejected'),
      signedOff: count((d) => !!d.signoff_at),
      errors: count((d) => d.stage === 'error'),
    },
    requests: coverage(sc, docs),
  };
}

async function auditRows({ caseId, limit = 1000 } = {}) {
  let rows = (await all('audit')).sort((a, b) => b.seq - a.seq);
  if (caseId) rows = rows.filter((e) => e.case_id === caseId);
  else rows = rows.slice(0, limit);
  return rows.map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
}

async function register() {
  const [rows, docs, thr] = await Promise.all([kvGet('register', DEFAULT_REGISTER), docsAll(), threshold()]);
  const last = docs.reduce((a, d) => (d.queued_at && (!a || d.queued_at > a) ? d.queued_at : a), null);
  return { statuses: REGISTER_STATUSES, rows: rows.map((r) => (r.id === 'UC-01' ? { ...r, live: { documents: docs.length, lastRun: last, threshold: thr, rules: RULES.length } } : r)) };
}

const originals = new Map();
export async function originalUrl(id) {
  if (!originals.has(id)) {
    const [d, buf] = await Promise.all([getDoc(id), get('files', id)]);
    originals.set(id, URL.createObjectURL(new Blob([buf], { type: d.mime })));
  }
  return originals.get(id);
}
export async function originalBytes(id) { return get('files', id); }

// ---------------------------------------------------------------- exports

const csvEscape = (v) => { const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); return `"${s.replace(/"/g, '""')}"`; };
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export async function exportAudit() {
  const rows = (await all('audit')).sort((a, b) => a.seq - b.seq);
  const head = 'seq,timestamp,case_id,batch_id,actor,role,action,detail,prev_hash,hash';
  download('audit-trail.csv', [head, ...rows.map((r) => [r.seq, r.ts, r.case_id, r.batch_id, r.actor, r.role, r.action, r.detail, r.prev_hash, r.hash].map(csvEscape).join(','))].join('\n'));
}
export async function exportResults() {
  const r = await results();
  const pct = (v) => (v == null ? '' : `${(v * 100).toFixed(1)}%`);
  download('results.csv', [
    'measure,target,result,met',
    ['Extraction accuracy', '90% of fields', `${pct(r.accuracy.value)} (${r.accuracy.correct}/${r.accuracy.total})`, r.accuracy.value >= 0.9],
    ['Planted errors caught', '5 of 5', `${r.planted.caught} of ${r.planted.total}`, r.planted.caught === 5],
    ['Time per document', 'Under 30 s', r.time.avgSeconds == null ? '' : `avg ${r.time.avgSeconds.toFixed(2)} s, max ${r.time.maxSeconds.toFixed(2)} s`, r.time.avgSeconds != null && r.time.avgSeconds < 30],
    ['False positive flags', 'Report', String(r.planted.falsePositives.length), ''],
  ].map((row) => (Array.isArray(row) ? row.map(csvEscape).join(',') : row)).join('\n'));
}
async function results() {
  const [docs, ans, mm, thr] = await Promise.all([docsAll(), answerSheet(), kvGet('manualMinutes', 6), threshold()]);
  return computeResults(docs, ans, { manualMinutes: mm, threshold: thr });
}

// ---------------------------------------------------------------- request router

function persona(id, allowed) {
  const p = PERSONAS[id];
  if (!p) throw err(401, 'Choose who you are acting as.');
  if (allowed && !allowed.includes(p.id)) throw err(403, `${p.role} cannot do this. Switch to ${allowed.map((a) => PERSONAS[a].role).join(' or ')}.`);
  return p;
}

export async function uploadFiles(fileList, personaId, pace) {
  const p = persona(personaId, ['client']);
  const list = [...fileList];
  if (!list.length) throw err(400, 'No files received.');
  const bad = list.filter((f) => !mimeFor(f.name) || !f.size);
  if (bad.length) throw err(400, `Unsupported or empty: ${bad.map((f) => f.name).join(', ')}. Upload PDF or image files.`);
  const big = list.filter((f) => f.size > MAX_BYTES);
  if (big.length) throw err(413, `Over 3 MB: ${big.map((f) => f.name).join(', ')}.`);
  const files = await Promise.all(list.map(async (f) => ({ name: f.name, mime: mimeFor(f.name), buffer: await f.arrayBuffer() })));
  return ingest(files, p, pace ? 140 : 0);
}

export async function request(path, { method = 'GET', body = {}, as } = {}) {
  const u = new URL(path, location.origin);
  const parts = u.pathname.replace(/^\/api\//, '').split('/').map(decodeURIComponent);
  const [a, b, c] = parts;
  if (method === 'GET') {
    if (a === 'state') return state();
    if (a === 'scenario') return { ...(await scenario()), rules: RULES, docTypes: DOC_TYPES };
    if (a === 'documents' && !b) return (await docsAll()).map(summary);
    if (a === 'documents' && b && !c) {
      const d = await getDoc(b);
      const sc = await scenario();
      const req = sc.requests.find((r) => r.id === d.match?.requestId) || null;
      const tb = req?.tbAccount ? sc.trialBalance.find((t) => t.id === req.tbAccount) : null;
      return { ...d, lane: d.flags ? laneFor(d.flags) : null, request: req, trialBalance: tb, trail: (await auditRows({ caseId: b })).reverse() };
    }
    if (a === 'documents' && c === 'integrity') {
      const d = await getDoc(b);
      const cur = await sha256Hex(await get('files', b));
      return { ok: cur === d.sha256, stored: d.sha256, current: cur };
    }
    if (a === 'audit' && b === 'verify') return verifyChain();
    if (a === 'audit') return auditRows({ caseId: u.searchParams.get('case'), limit: Number(u.searchParams.get('limit') || 1000) });
    if (a === 'results') return results();
    if (a === 'register') return register();
  }
  if (method === 'POST') {
    if (a === 'load-sample') {
      const p = persona(as, ['client']);
      const ans = await answerSheet();
      const names = ans.documents.map((x) => x.file).sort((x, y) => x.localeCompare(y, 'en', { sensitivity: 'base' }));
      const files = await Promise.all(names.map(async (n) => ({ name: n, mime: mimeFor(n), buffer: await (await fetch(`/dataset/documents/${encodeURIComponent(n)}`)).arrayBuffer() })));
      return ingest(files, p, body.pace ? 140 : 0);
    }
    if (a === 'documents' && c === 'edit') return edit(b, body.fields || {}, persona(as, ['reviewer']));
    if (a === 'documents' && c === 'approve') return approve(b, body.note, persona(as, ['reviewer']));
    if (a === 'documents' && c === 'reject') return reject(b, body.reason, persona(as, ['reviewer']));
    if (a === 'documents' && c === 'reopen') return reopen(b, persona(as, ['reviewer']));
    if (a === 'documents' && c === 'signoff') return signoff(b, persona(as, ['approver']));
    if (a === 'signoff-all') {
      const p = persona(as, ['approver']);
      const ids = (await docsAll()).filter((d) => d.review_status === 'approved' && !d.signoff_at).map((d) => d.id);
      for (const id of ids) await signoff(id, p);
      return { signedOff: ids.length };
    }
    if (a === 'register' && b) {
      const p = persona(as, ['approver']);
      const rows = await kvGet('register', DEFAULT_REGISTER);
      const row = rows.find((r) => r.id === b);
      if (!row) throw err(404, 'Use case not found');
      const changes = {};
      for (const k of ['owner', 'status', 'notes']) {
        if (k in body && String(body[k]).trim() !== row[k]) {
          if (k === 'status' && !REGISTER_STATUSES.includes(body[k])) throw err(400, 'Unknown status');
          changes[k] = { from: row[k], to: String(body[k]).trim().slice(0, 300) };
          row[k] = changes[k].to;
        }
      }
      await kvSet('register', rows);
      if (Object.keys(changes).length) await audit({ actor: p.name, role: p.role, action: 'register.updated', detail: { useCase: b, changes } });
      return row;
    }
    if (a === 'settings') {
      const p = persona(as, ['approver']);
      const changes = {};
      if (body.threshold != null) {
        const t = Number(body.threshold);
        if (!(t >= 0.5 && t <= 0.99)) throw err(400, 'Threshold must be between 0.50 and 0.99.');
        changes.threshold = { from: await threshold(), to: t };
        await kvSet('threshold', t);
      }
      if (body.manualMinutes != null) {
        const m = Number(body.manualMinutes);
        if (!(m > 0 && m <= 120)) throw err(400, 'Manual minutes must be between 1 and 120.');
        changes.manualMinutes = { from: await kvGet('manualMinutes', 6), to: m };
        await kvSet('manualMinutes', m);
      }
      await audit({ actor: p.name, role: p.role, action: 'settings.updated', detail: changes });
      return { ok: true };
    }
    if (a === 'reset') {
      persona(as);
      if (busy()) throw err(409, 'Wait for processing to finish before resetting.');
      for (const s of ['docs', 'files', 'audit', 'kv', 'batches']) await clear(s);
      originals.forEach((u) => URL.revokeObjectURL(u));
      originals.clear();
      emit({ type: 'reset' });
      return { ok: true };
    }
  }
  throw err(404, 'Not found');
}

// ---------------------------------------------------------------- PDF.js loader (shared with the viewer)

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsReady = null;
export function loadPdfJs() {
  if (!pdfjsReady) {
    pdfjsReady = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = `${PDFJS}pdf.min.js`;
      sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.js`; resolve(window.pdfjsLib); };
      sc.onerror = () => { pdfjsReady = null; reject(new Error('PDF viewer unavailable')); };
      document.head.appendChild(sc);
    });
  }
  return pdfjsReady;
}
