// Evidence Intake — client. Vanilla JS, hash routing, live updates from the workflow engine.
import * as engine from './engine.js';
import { startTour, shouldAutoStart, isTouring } from './tour.js';

const S = {
  persona: safeGet('persona') || 'client',
  state: null,
  scenario: null,
  docs: [],
  queueTab: 'review',
  auditFilter: '',
  editing: false,
  viewerTab: 'original',
  route: { view: 'intake' },
  animate: true,
  just: null,          // case id whose decision was just recorded
  trace: null,         // field currently traced in the text layer
};
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let docKeys = null;
document.addEventListener('keydown', (e) => { if (docKeys) docKeys(e); });

// ---------------------------------------------------------------- utilities

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, { method = 'GET', body } = {}) {
  return engine.request(path, { method, body, as: S.persona });
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, bad ? 4200 : 2600);
}

function confirmDialog(title, body, ok = 'Confirm', danger = false) {
  const d = $('#dialog');
  d.innerHTML = `<h3>${esc(title)}</h3><p>${esc(body)}</p><div class="row" style="justify-content:flex-end"><button class="btn" value="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" value="yes">${esc(ok)}</button></div>`;
  return new Promise((resolve) => {
    $$('button', d).forEach((b) => b.addEventListener('click', () => { d.close(); resolve(b.value === 'yes'); }));
    d.addEventListener('cancel', () => resolve(false), { once: true });
    d.showModal();
  });
}

const TYPE = { invoice: 'Invoice', bank_statement: 'Bank statement', contract: 'Contract', confirmation: 'Confirmation', board_minutes: 'Board minutes', other: 'Unrecognised' };
const FIELD_LABEL = { doc_type: 'Type', entity: 'Entity', counterparty: 'Counterparty', date: 'Date', amount: 'Amount', currency: 'Currency', reference: 'Reference', period_start: 'Period start', period_end: 'Period end', signatures: 'Signatures' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const money = (v, ccy) => (v == null ? '—' : `${ccy ? ccy + ' ' : ''}${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const dateFmt = (iso) => { if (!iso) return '—'; const [y, m, d] = iso.slice(0, 10).split('-'); return `${+d} ${MONTHS[+m - 1]} ${y}`; };
const clock = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
const stamp = (ts) => { if (!ts) return '—'; const d = new Date(ts); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${clock(ts)}`; };
const pct = (v, dp = 0) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`);
const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function confHtml(v) {
  if (v == null) return '<span class="faint">—</span>';
  const low = v < (S.state?.threshold ?? 0.8);
  return `<span class="conf${low ? ' low' : ''}"><span class="bar"><i style="width:${Math.round(v * 100)}%"></i></span><span class="num">${Math.round(v * 100)}%</span></span>`;
}
// Count a number up from its previous value (tabular figures keep the width steady).
const lastValues = new Map();
function countUp(node, key, to, fmt = (v) => String(Math.round(v))) {
  const from = lastValues.has(key) ? lastValues.get(key) : 0;
  lastValues.set(key, to);
  if (from === to || reduceMotion()) { node.textContent = fmt(to); return; }
  if (to > from) { node.classList.remove('bump'); void node.offsetWidth; node.classList.add('bump'); }
  const t0 = performance.now(), dur = 520;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    node.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Mark the characters of `found` that differ from `expected` (same length), else the whole value.
function diffHtml(expected, found) {
  const a = String(expected ?? ''), b = String(found ?? '');
  if (!a || !b || a === b) return esc(b || '—');
  if (a.length !== b.length) return `<mark class="diff">${esc(b)}</mark>`;
  let out = '', run = '';
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) run += b[i];
    else { if (run) { out += `<mark class="diff">${esc(run)}</mark>`; run = ''; } out += esc(b[i]); }
  }
  return out + (run ? `<mark class="diff">${esc(run)}</mark>` : '');
}

// Forms a value can take in the source text, for trace-to-source highlighting.
const MONTHS_LONG = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function valueForms(k, v) {
  if (v == null || k === 'doc_type' || k === 'signatures') return [];
  if (k === 'amount') { const a = Math.abs(Number(v)); return [a.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), a.toFixed(2), ...(Number.isInteger(a) ? [a.toLocaleString('en-GB')] : [])]; }
  if (k === 'date' || k === 'period_start' || k === 'period_end') {
    const [y, m, d] = String(v).split('-').map(Number);
    const dd = String(d).padStart(2, '0'), mm = String(m).padStart(2, '0'), mon = MONTHS_LONG[m - 1] || '';
    return [v, `${dd}/${mm}/${y}`, `${d} ${mon} ${y}`, `${dd} ${mon.slice(0, 3)} ${y}`, `${d} ${mon.slice(0, 3)} ${y}`, `${dd}-${mon.slice(0, 3)}-${y}`];
  }
  return [String(v)];
}
function highlightText(text, forms) {
  const safe = esc(text);
  const pats = forms.filter(Boolean).map((f) => esc(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  if (!pats.length) return { html: safe, hits: 0 };
  let hits = 0;
  const html = safe.replace(new RegExp(pats.join('|'), 'gi'), (m) => { hits++; return `<mark class="trace">${m}</mark>`; });
  return { html, hits };
}

function codesHtml(flags) {
  if (!flags?.length) return '<span class="faint">None</span>';
  return `<span class="codes">${flags.map((f) => `<span class="code${f.severity === 'warning' ? ' warn' : ''}" title="${esc(f.title)}">${esc(f.code)}</span>`).join('')}</span>`;
}
function statusChip(d) {
  if (d.stage === 'error') return '<span class="chip flag">Error</span>';
  if (d.stage !== 'queued') return `<span class="chip plain">Processing · ${esc(d.stage)}</span>`;
  if (d.signoff_at) return '<span class="chip navy">Signed off</span>';
  if (d.review_status === 'approved' && !d.batch_approved) return '<span class="chip ok">Approved</span>';
  if (d.review_status === 'rejected') return '<span class="chip flag">Rejected</span>';
  if (d.review_status === 'approved' && d.batch_approved) return '<span class="chip ok">Approved · batch</span>';
  if (d.lane === 'flagged') return '<span class="chip flag">Held: flagged</span>';
  if (d.lane === 'low_confidence') return '<span class="chip warn">Low confidence</span>';
  if (d.sampled) return '<span class="chip sample">Sample check</span>';
  return '<span class="chip">Awaiting review</span>';
}

const ACTION = {
  'batch.uploaded': 'Batch uploaded', 'document.received': 'Received', 'extraction.completed': 'Fields extracted', 'extraction.fallback': 'Reader fallback',
  'match.completed': 'Matched', 'rules.checked': 'Rules checked', 'rules.rerun': 'Rules re-run', 'queued.for.review': 'Queued for review',
  'fields.edited': 'Fields edited', 'review.approved': 'Approved', 'review.rejected': 'Rejected', 'review.reopened': 'Reopened',
  'signoff.completed': 'Signed off', 'register.updated': 'Register updated', 'settings.updated': 'Settings changed', 'processing.failed': 'Processing failed',
  'sample.selected': 'Sample selected', 'client.request.drafted': 'Client request drafted', 'client.request.sent': 'Client request sent',
  'register.check': 'Governance check', 'register.gate.blocked': 'Release gate held',
};
const fv = (v) => (v == null ? 'empty' : Array.isArray(v) ? v.map((s) => `${s.party}: ${s.signed ? 'signed' : 'unsigned'}`).join('; ') : typeof v === 'number' ? money(v) : String(v));
function describe(e) {
  const x = e.detail || {};
  switch (e.action) {
    case 'batch.uploaded': return `${x.files} file${x.files === 1 ? '' : 's'}`;
    case 'document.received': return `${x.file} · ${kb(x.bytes)} · sha256 ${String(x.sha256).slice(0, 12)}…`;
    case 'extraction.completed': return `${TYPE[x.fields?.doc_type] || 'Unknown'} · confidence ${pct(x.overall)} · ${x.ms} ms`;
    case 'extraction.fallback': return x.reason;
    case 'match.completed': return x.requestId ? `${x.requestId}${x.ledgerLine ? ` · ${x.ledgerLine}` : ''} · by ${String(x.basis).toLowerCase()}` : 'No match';
    case 'rules.checked': return x.flags?.length ? x.flags.join(', ') : 'All checks passed';
    case 'rules.rerun': return `${x.reason ? x.reason + ': ' : ''}${x.after?.length ? x.after.join(', ') : 'all checks pass'}`;
    case 'queued.for.review': return `${{ flagged: 'Needs attention', low_confidence: 'Low confidence warning', clean: 'Clean' }[x.lane]} · ${x.msFromUpload} ms from upload`;
    case 'fields.edited': return x.changes.map((c) => `${FIELD_LABEL[c.field] || c.field}: ${fv(c.from)} → ${fv(c.to)}`).join(' · ');
    case 'review.approved': return x.batch ? 'Approved in batch: clean and not selected in the sample' : x.exceptionsAccepted?.length ? `Exceptions accepted (${x.exceptionsAccepted.join(', ')}): ${x.note}` : x.note || 'No exceptions';
    case 'review.rejected': return x.reason;
    case 'review.reopened': return `Was ${x.previous}`;
    case 'signoff.completed': return `Review by ${x.reviewedBy}`;
    case 'register.updated': return `${x.useCase}: ${Object.entries(x.changes).map(([k, v]) => `${k} → ${v.to}`).join(', ')}`;
    case 'settings.updated': return Object.entries(x).map(([k, v]) => `${k} ${v.from} → ${v.to}`).join(', ');
    case 'processing.failed': return x.error;
    case 'sample.selected': return `${x.sampled.length} of ${x.eligible} clean documents held for individual review (${Math.round(x.rate * 100)}% random sample); ${x.batchApproved.length} approved in batch`;
    case 'client.request.drafted': return `${x.items} item${x.items === 1 ? '' : 's'} · ${x.subject}`;
    case 'client.request.sent': return `To ${x.to} · ${x.items} item${x.items === 1 ? '' : 's'}${x.editedFromDraft ? ' · edited before sending' : ''}`;
    case 'register.check': return `${x.useCase} · ${x.check}: ${x.done ? 'attested' : 'withdrawn'}${x.note ? ` · ${x.note}` : ''}`;
    case 'register.gate.blocked': return `${x.useCase} not moved to ${x.requested}: ${x.openChecks.join(', ')} open`;
    default: return JSON.stringify(x);
  }
}

// ---------------------------------------------------------------- data

async function loadState() {
  [S.state, S.docs] = await Promise.all([api('/api/state'), api('/api/documents')]);
  renderChrome();
}

function renderChrome() {
  const st = S.state;
  if (!st) return;
  $('#personas').innerHTML = Object.values(st.personas).map((p, i) => `
    <button class="${p.id === S.persona ? 'on' : ''}" data-persona="${p.id}" aria-pressed="${p.id === S.persona}" title="${esc(p.name)}, ${esc(p.role)}" style="--i:${i + 6}">
      <span class="av">${esc(p.name.replace(/[^A-Z]/g, '').slice(0, 2))}</span>
      <span class="who lbl" style="--i:${i + 6}"><b>${esc(p.name)}</b><span>${esc(p.role)}</span></span>
    </button>`).join('');
  const pending = st.counts.pending;
  $('#nav-pending').textContent = pending ? String(pending) : '';
  $('#nav-intake').textContent = st.counts.processing ? String(st.counts.processing) : '';
  const view = S.route.view === 'doc' ? 'queue' : S.route.view;
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === view));
  moveActive();
  engine.request('/api/client-requests').then((r) => { S.requests = r; const open = r.items.filter((x) => !x.sent).length; $('#nav-requests').textContent = open ? String(open) : ''; }).catch(() => {});
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-persona]');
  if (!b) return;
  S.persona = b.dataset.persona;
  safeSet('persona', S.persona);
  S.editing = false;
  renderChrome();
  render();
});

$('#reset').addEventListener('click', async () => {
  if (!(await confirmDialog('Reset demo data?', 'This deletes every uploaded document, decision and audit entry so the demo can run again from the start.', 'Reset', true))) return;
  try { await api('/api/reset', { method: 'POST' }); toast('Demo data cleared'); location.hash = '#/intake'; await loadState(); render(); }
  catch (err) { toast(err.message, true); }
});

// ---------------------------------------------------------------- navigation rail

const rail = $('#rail');
const peek = $('#peek');
const desktop = () => window.matchMedia('(min-width: 761px)').matches;
const pinned = () => document.body.classList.contains('rail-pinned');
function setPinned(on) {
  document.body.classList.toggle('rail-pinned', on);
  rail.classList.toggle('pinned', on);
  rail.classList.toggle('open', on);
  $('#pin').setAttribute('aria-pressed', String(on));
  $('#pin .lbl').textContent = on ? 'Collapse' : 'Keep open';
  $('#pin').title = on ? 'Collapse the sidebar' : 'Keep the sidebar open';
  safeSet('rail-pinned', on ? '1' : '0');
}
setPinned(safeGet('rail-pinned') === '1');
$('#pin').addEventListener('click', () => { setPinned(!pinned()); if (!pinned()) { rail.classList.remove('open'); hidePeek(); } });

let openTimer = null, closeTimer = null;
rail.addEventListener('mouseenter', () => { if (!desktop()) return; clearTimeout(closeTimer); openTimer = setTimeout(() => rail.classList.add('open'), 90); });
rail.addEventListener('mouseleave', () => {
  clearTimeout(openTimer);
  closeTimer = setTimeout(() => { if (!pinned() && !peek.matches(':hover')) rail.classList.remove('open'); }, 160);
  setTimeout(() => { if (!peek.matches(':hover')) hidePeek(); }, 160);
  $('.nav-hover').classList.remove('show');
});
rail.addEventListener('focusin', () => { if (desktop()) rail.classList.add('open'); });
rail.addEventListener('focusout', (e) => { if (!rail.contains(e.relatedTarget) && !pinned()) { rail.classList.remove('open'); hidePeek(); } });
peek.addEventListener('mouseleave', () => { setTimeout(() => { if (!rail.matches(':hover') && !peek.matches(':hover')) { hidePeek(); if (!pinned()) rail.classList.remove('open'); } }, 140); });
peek.addEventListener('click', () => { if (peek.dataset.view) { location.hash = `#/${peek.dataset.view}`; hidePeek(); if (!pinned()) rail.classList.remove('open'); } });

// The highlight glides to the hovered item; the active pill follows the route.
function moveActive() {
  const a = $('#nav a.on');
  const pill = $('.nav-active');
  if (!a) { pill.style.opacity = '0'; return; }
  pill.style.opacity = '1';
  pill.style.transform = `translateY(${a.offsetTop}px)`;
}
let peekTimer = null, peekFor = null;
$$('#nav a').forEach((a) => {
  const show = () => {
    const h = $('.nav-hover');
    h.style.transform = `translateY(${a.offsetTop}px)`;
    h.classList.add('show');
    if (!desktop()) return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => showPeek(a), peek.classList.contains('show') ? 60 : 260);
  };
  a.addEventListener('mouseenter', show);
  a.addEventListener('focus', show);
  a.addEventListener('click', () => { hidePeek(); if (!pinned()) setTimeout(() => rail.classList.remove('open'), 120); });
});

function hidePeek() { clearTimeout(peekTimer); peek.classList.remove('show'); peek.setAttribute('aria-hidden', 'true'); peekFor = null; }

async function showPeek(a) {
  const view = a.dataset.view;
  const railW = pinned() || rail.classList.contains('open') ? rail.offsetWidth : 260;
  const r = a.getBoundingClientRect();
  peek.style.left = `${12 + Math.max(railW, 260) + 14}px`;
  const fresh = peekFor !== view;
  peekFor = view;
  peek.dataset.view = view;
  let html;
  try { html = await peekHtml(view); } catch { html = '<div class="pk-empty">Preview unavailable.</div>'; }
  if (peekFor !== view) return;
  peek.innerHTML = `<div class="${fresh ? 'pk-anim' : ''}">${html}<div class="pk-foot">Open ${esc(a.querySelector('.lbl').textContent)} &rarr;</div></div>`;
  const top = Math.min(Math.max(12, r.top + r.height / 2 - 70), window.innerHeight - peek.offsetHeight - 12);
  peek.style.top = `${top}px`;
  peek.classList.add('show');
  peek.setAttribute('aria-hidden', 'false');
}

async function peekHtml(view) {
  const st = S.state, c = st.counts, d = S.docs;
  const stats = (arr) => `<div class="pk-stats">${arr.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>`;
  const list = (rows) => (rows.length ? `<ul class="pk-list">${rows.map(([m, x, r]) => `<li><span class="m">${esc(m)}</span><span class="x">${esc(x)}</span>${r ? `<span class="m">${esc(r)}</span>` : ''}</li>`).join('')}</ul>` : '');
  if (view === 'intake') {
    const total = c.total || 1;
    const bar = c.total ? `<div class="pk-bar"><i style="flex-grow:${c.flagged};background:var(--red)"></i><i style="flex-grow:${c.lowConfidence};background:var(--amber)"></i><i style="flex-grow:${c.clean};background:var(--blue)"></i><i style="flex-grow:${c.processing};background:var(--line-2)"></i></div>` : '';
    const done = st.requests.filter((r) => r.received >= r.expectedCount).length;
    return `<div class="pk-k">Intake</div><div class="pk-t">${esc(st.engagement.client)}</div>${stats([[c.total, 'received'], [c.processing, 'in progress'], [`${done}/${st.requests.length}`, 'items covered']])}${bar}${c.total ? `<div class="pk-empty">${c.flagged} flagged · ${c.lowConfidence} low confidence · ${c.clean} clean</div>` : '<div class="pk-empty">Nothing received yet. The client uploads here.</div>'}`;
  }
  if (view === 'queue') {
    const att = d.filter((x) => x.review_status === 'pending' && x.stage === 'queued' && x.lane !== 'clean').slice(0, 3);
    return `<div class="pk-k">Review queue</div><div class="pk-t">${c.pending} awaiting a decision</div>${stats([[c.flagged, 'flagged'], [c.lowConfidence, 'low conf.'], [c.approved, 'approved']])}${list(att.map((x) => [x.id.slice(-4), x.file_name, x.flags[0]?.code || '']))}`;
  }
  if (view === 'requests') {
    const r = S.requests || (await engine.request('/api/client-requests'));
    const open = r.items.filter((x) => !x.sent);
    const by = (k) => open.filter((x) => x.kind === k).length;
    return `<div class="pk-k">Client requests</div><div class="pk-t">${open.length} open item${open.length === 1 ? '' : 's'} for the client</div>${stats([[by('Query'), 'queries'], [by('Replacement'), 'replacements'], [by('Outstanding'), 'outstanding']])}${list(open.slice(0, 3).map((x) => [x.kind, x.file || x.requestId]))}`;
  }
  if (view === 'audit') {
    const [rows, chain] = await Promise.all([engine.request('/api/audit?limit=4'), engine.request('/api/audit/verify')]);
    return `<div class="pk-k">Audit trail</div><div class="pk-t">${chain.ok ? `Chain verified · ${chain.entries} entries` : `Chain broken at #${chain.brokenAt}`}</div>${rows.length ? list(rows.map((e) => [clock(e.ts), ACTION[e.action] || e.action, e.case_id ? e.case_id.slice(-4) : ''])) : '<div class="pk-empty">No entries yet.</div>'}`;
  }
  if (view === 'register') {
    const reg = await engine.request('/api/register');
    return `<div class="pk-k">Governance</div><div class="pk-t">${reg.rows.length} AI use cases on the register</div>${list(reg.rows.map((r) => [r.id, r.useCase, `${Object.values(r.checks).filter((x) => x.done).length}/5 · ${r.status}`]))}`;
  }
  if (view === 'results') {
    if (!c.total) return '<div class="pk-k">Results</div><div class="pk-t">No run yet</div><div class="pk-empty">Load the batch to score it against the answer sheet.</div>';
    const r = await engine.request('/api/results');
    return `<div class="pk-k">Results</div><div class="pk-t">Against the answer sheet</div>${stats([[r.accuracy.value == null ? '—' : `${(r.accuracy.value * 100).toFixed(0)}%`, 'accuracy'], [`${r.planted.caught}/${r.planted.total}`, 'errors caught'], [r.time.avgSeconds == null ? '—' : `${r.time.avgSeconds.toFixed(1)}s`, 'per document']])}<div class="pk-empty">${r.planted.falsePositives.length} false flags · ${r.matching.correct}/${r.matching.total} matched</div>`;
  }
  return '';
}
window.addEventListener('resize', () => { moveActive(); hidePeek(); });

// ---------------------------------------------------------------- router

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = parts[0] || 'intake';
  return { view, id: parts[1] ? decodeURIComponent(parts[1]) : null };
}
window.addEventListener('hashchange', () => { S.editing = false; S.animate = true; S.trace = null; S.route = parseRoute(); renderChrome(); render(); $('#view').focus({ preventScroll: true }); window.scrollTo(0, 0); });

const VIEWS = { intake: renderIntake, queue: renderQueue, doc: renderDoc, requests: renderRequests, audit: renderAudit, register: renderRegister, results: renderResults };
let renderSeq = 0;
async function render() {
  const token = ++renderSeq;
  const fn = VIEWS[S.route.view] || renderIntake;
  const animate = S.animate;
  S.animate = false;
  docKeys = null;
  try {
    await fn();
    if (animate && !reduceMotion()) { const pg = $('.page'); if (pg) { pg.classList.remove('enter'); void pg.offsetWidth; pg.classList.add('enter'); setTimeout(() => pg.classList.remove('enter'), 1000); } }
  } catch (err) {
    if (token !== renderSeq) return; // a newer render replaced this one
    $('#view').innerHTML = `<div class="page"><h1>Something went wrong</h1><p class="sub">${esc(err.message)}</p></div>`; }
}

// Live refresh: throttle, and never clobber a form the user is typing in.
let refreshTimer = null, pendingCases = new Set();
function scheduleRefresh(caseId) {
  if (caseId) pendingCases.add(caseId);
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    const cases = pendingCases; pendingCases = new Set();
    await loadState();
    const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const v = S.route.view;
    if (v === 'intake') updateIntake();
    else if (v === 'queue') renderQueueTable();
    else if (v === 'doc') { if (!S.editing && !typing && cases.has(S.route.id)) renderDoc(); }
    else if (v === 'audit') { if (!typing) renderAudit(); }
    else if (v === 'results' || v === 'register') { if (!typing) render(); }
    else if (v === 'requests') { if (!typing && !$('#draft')) render(); }
  }, 350);
}

function connectEvents() {
  engine.onChange((ev) => {
    if (ev.type === 'audit') { appendLog(ev.entry, true); scheduleRefresh(ev.entry.case_id); }
    else if (ev.type === 'reset') { S.docs = []; scheduleRefresh(); }
    else scheduleRefresh(ev.id);
  });
}

// ---------------------------------------------------------------- intake

function flowHtml() {
  const d = S.docs, c = S.state.counts;
  const n = (fn) => d.filter(fn).length;
  const extracted = n((x) => x.doc_type);
  const matched = n((x) => x.requestId);
  const flagged = n((x) => x.lane === 'flagged');
  const low = n((x) => x.lane === 'low_confidence');
  const decided = c.approved + c.rejected;
  const busy = S.state.processing > 0;
  const nodes = [
    { k: 'Trigger', t: 'Client upload', v: c.total, s: 'documents received' },
    { k: 'AI', cls: 'ai', t: 'Read document', v: extracted, s: 'fields extracted', live: busy },
    { k: 'System', t: 'Match to request', v: matched, s: 'linked to request list', live: busy },
    { k: 'Rules', t: 'Coded checks', v: flagged, s: 'documents flagged', live: busy },
    { k: 'Logic', t: 'Confident?', v: low, s: `below ${pct(S.state.threshold)} threshold` },
    { k: 'Human', cls: 'human', t: 'Reviewer decides', v: decided, s: `${c.approved} approved · ${c.rejected} rejected` },
    { k: 'Human', cls: 'human', t: 'Manager sign-off', v: c.signedOff, s: 'signed off' },
  ];
  return nodes.map((x, i) => `<div class="node${x.live ? ' live' : ''}"><div class="k ${x.cls || ''}">${x.k}</div><div class="t" title="${esc(x.t)}">${esc(x.t)}</div><div class="v" data-count="${x.v}" data-key="flow-${i}">${lastValues.get(`flow-${i}`) ?? 0}</div><div class="s">${esc(x.s)}</div></div>`).join('');
}
function animateCounts(scope = document) {
  $$('[data-count]', scope).forEach((n) => countUp(n, n.dataset.key, Number(n.dataset.count), n.dataset.fmt ? FORMATS[n.dataset.fmt] : undefined));
}
const FORMATS = { pct1: (v) => `${v.toFixed(1)}%`, s2: (v) => `${v < 10 ? v.toFixed(2) : v.toFixed(1)} s` };
function progressHtml() {
  const c = S.state.counts;
  const total = c.total, done = c.queued + c.errors;
  if (!total || done >= total) return '';
  const pctDone = Math.round((done / total) * 100);
  return `<div class="batchbar" role="status" aria-live="polite"><div class="spread"><span><span class="pulse"></span>Reading and checking documents</span><span class="num">${done} of ${total}</span></div><div class="track"><i style="width:${pctDone}%"></i></div></div>`;
}

function coverageHtml() {
  const chip = { Outstanding: 'plain', Partial: '', Received: '', Exceptions: 'flag', Complete: 'ok' };
  return `<table class="table tight"><thead><tr><th>Item</th><th>Requested</th><th class="r">Got</th><th>Status</th></tr></thead><tbody>
    ${S.state.requests.map((r) => `<tr data-r="${r.id}" data-s="${r.status}"><td class="mono">${r.id}</td><td>${esc(r.title)}</td><td class="r num">${r.received}/${r.expectedCount}</td><td><span class="chip ${chip[r.status]}">${r.status}</span></td></tr>`).join('')}
  </tbody></table>`;
}

function uploadHtml() {
  const client = S.state.personas.client;
  if (S.persona !== 'client') {
    return `<div class="gate spread"><span>Evidence comes from the client. Uploads are made as ${esc(client.name)}, ${esc(client.title)}.</span><button class="btn sm" data-persona="client">Act as client</button></div>`;
  }
  return `<div class="drop" id="drop">
      <div><div class="big">Drop the client's files here</div><div class="muted" style="margin-top:4px">PDF or image files up to 3 MB. Each gets a case ID; the original is stored untouched with its SHA-256.</div></div>
      <div class="row">
        <label class="btn primary">Choose files<input type="file" id="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" hidden></label>
        <button class="btn" id="sample">Load synthetic batch · 25 documents</button>
      </div>
      <label class="check"><input type="checkbox" id="pace" ${safeGet('pace') === '1' ? 'checked' : ''}> Pace each step for a live demo (turn off for the timed run)</label>
    </div>`;
}

async function renderIntake() {
  const e = S.state.engagement;
  $('#view').innerHTML = `<div class="page">
    <div class="head"><div>
      <div class="eyebrow">Engagement ${esc(e.id)}</div>
      <h1>${esc(e.client)}</h1>
      <div class="sub">Financial year ended ${dateFmt(e.yearEnd)} · ${S.state.requests.length} items on the request list</div>
    </div></div>
    <div class="flow" id="flow">${flowHtml()}</div>
    <div id="progress">${progressHtml()}</div>
    <div class="grid-intake section">
      <div>
        <h2>Upload</h2>
        <div id="upload">${uploadHtml()}</div>
        <div class="section">
          <h2>Request list</h2>
          <div id="coverage">${coverageHtml()}</div>
        </div>
      </div>
      <div>
        <div class="spread" style="margin-bottom:14px"><h2 style="margin:0">Intake log</h2><a href="#/audit">Full audit trail</a></div>
        <div class="log" id="log"><div class="empty">Nothing received yet.</div></div>
      </div>
    </div>
  </div>`;
  bindUpload();
  animateCounts($('#flow'));
  const entries = await api('/api/audit?limit=300');
  const log = $('#log');
  if (log && entries.length) { log.innerHTML = ''; entries.slice().reverse().forEach((x) => appendLog(x, false)); }
}

function updateIntake() {
  if (!$('#flow')) return;
  $('#flow').innerHTML = flowHtml();
  animateCounts($('#flow'));
  $('#progress').innerHTML = progressHtml();
  const prevStatus = Object.fromEntries($$('#coverage tr[data-r]').map((tr) => [tr.dataset.r, tr.dataset.s]));
  $('#coverage').innerHTML = coverageHtml();
  $$('#coverage tr[data-r]').forEach((tr) => { if (prevStatus[tr.dataset.r] && prevStatus[tr.dataset.r] !== tr.dataset.s) tr.classList.add('changed'); });
}

function appendLog(entry, fresh) {
  const log = $('#log');
  if (!log) return;
  const empty = $('.empty', log);
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = `e${fresh ? ' fresh' : ''}`;
  el.innerHTML = `<span class="ts">${clock(entry.ts)}</span><span class="act">${esc(entry.case_id || entry.batch_id || '—')}</span><span class="what"><b style="font-weight:500">${esc(ACTION[entry.action] || entry.action)}</b> · ${esc(describe(entry))}</span>`;
  log.prepend(el);
}

function bindUpload() {
  const drop = $('#drop');
  if (!drop) return;
  const send = async (files, sample = false) => {
    const pace = $('#pace')?.checked;
    safeSet('pace', pace ? '1' : '0');
    try {
      if (sample) {
        const r = await api('/api/load-sample', { method: 'POST', body: { pace } });
        toast(`${r.ids.length} documents received as batch ${r.batchId}`);
      } else {
        if (!files?.length) return;
        const r = await engine.uploadFiles(files, S.persona, pace);
        toast(`${r.ids.length} document${r.ids.length === 1 ? '' : 's'} received as batch ${r.batchId}`);
      }
    } catch (err) { toast(err.message, true); }
  };
  $('#file').addEventListener('change', (e) => { send(e.target.files); e.target.value = ''; });
  $('#sample').addEventListener('click', (e) => { e.currentTarget.disabled = true; send(null, true).finally(() => { const b = $('#sample'); if (b) b.disabled = false; }); });
  const label = "Drop the client's files here";
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); const n = e.dataTransfer?.items?.length; $('.big', drop).textContent = n ? `Release to upload ${n} file${n === 1 ? '' : 's'}` : label; }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => { $('.big', drop).textContent = label; }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => send(e.dataTransfer.files));
}

// ---------------------------------------------------------------- queue

const TABS = [
  ['review', 'To review', (d) => d.stage === 'queued' && d.review_status === 'pending'],
  ['flagged', 'Flagged', (d) => d.stage === 'queued' && d.review_status === 'pending' && d.lane === 'flagged'],
  ['low', 'Low confidence', (d) => d.stage === 'queued' && d.review_status === 'pending' && d.lane === 'low_confidence'],
  ['clean', 'Clean', (d) => d.stage === 'queued' && d.review_status === 'pending' && d.lane === 'clean'],
  ['decided', 'Decided', (d) => d.review_status !== 'pending'],
  ['all', 'All', () => true],
];
const laneRank = { flagged: 0, low_confidence: 1, clean: 2 };
function queueList(tab = S.queueTab) {
  const fn = TABS.find((t) => t[0] === tab)?.[2] || (() => true);
  const list = S.docs.filter(fn);
  if (tab === 'review') list.sort((a, b) => (laneRank[a.lane] ?? 3) - (laneRank[b.lane] ?? 3) || a.id.localeCompare(b.id));
  return list;
}

function renderQueue() {
  const awaiting = S.docs.filter((d) => d.review_status === 'approved' && !d.signoff_at).length;
  $('#view').innerHTML = `<div class="page">
    <div class="head">
      <div><div class="eyebrow">Reviewer queue</div><h1>Review queue</h1><div class="sub">Nothing leaves this queue until a named reviewer approves, edits or rejects it.</div></div>
      <div id="signall" class="row">${S.persona === 'reviewer' ? '<button class="btn" id="sample-approve">Approve clean with sample check</button>' : ''}${S.persona === 'approver' ? `<button class="btn navy" id="signoff-all" ${awaiting ? '' : 'disabled'}>Sign off approved (${awaiting})</button>` : ''}</div>
    </div>
    <div class="tabs" role="tablist" id="tabs"></div>
    <div class="table-wrap" id="qtable"></div>
  </div>`;
  $('#signoff-all')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Sign off approved documents?', `${awaiting} approved document${awaiting === 1 ? '' : 's'} will be signed off by ${S.state.personas.approver.name}. Each sign-off is logged.`, 'Sign off'))) return;
    try { const r = await api('/api/signoff-all', { method: 'POST' }); toast(`${r.signedOff} signed off`); await loadState(); renderQueue(); } catch (err) { toast(err.message, true); }
  });
  $('#sample-approve')?.addEventListener('click', sampleDialog);
  renderQueueTable();
}

async function sampleDialog() {
  const { count } = await api('/api/sample-eligible');
  const d = $('#dialog');
  if (!count) { toast('No clean documents are waiting. Flagged and low-confidence documents always need an individual decision.'); return; }
  const n = (r) => Math.max(1, Math.ceil(count * r));
  d.innerHTML = `<h3>Approve clean documents with a sample check</h3>
    <p>${count} document${count === 1 ? '' : 's'} passed every coded check with confidence above the threshold. A random sample stays in your queue for individual review; the rest are approved in one step. The sample and every approval are logged.</p>
    <div class="row" style="margin:-6px 0 18px" role="radiogroup" aria-label="Sample size">
      ${[0.1, 0.2, 0.3].map((r) => `<label class="check"><input type="radio" name="rate" value="${r}" ${r === 0.2 ? 'checked' : ''}> ${Math.round(r * 100)}% <span class="faint">(${n(r)})</span></label>`).join('')}
    </div>
    <div class="row" style="justify-content:flex-end"><button class="btn" value="no">Cancel</button><button class="btn primary" value="yes">Select sample and approve the rest</button></div>`;
  const ok = await new Promise((resolve) => { $$('button', d).forEach((b) => b.addEventListener('click', () => { d.close(); resolve(b.value === 'yes'); })); d.addEventListener('cancel', () => resolve(false), { once: true }); d.showModal(); });
  if (!ok) return;
  const rate = Number(($('input[name=rate]:checked', d) || {}).value || 0.2);
  try {
    const r = await api('/api/sample-approve', { method: 'POST', body: { rate } });
    toast(`${r.approved} approved in batch · ${r.sampled.length} held in the sample for your review`);
    S.queueTab = 'review';
    await loadState(); renderQueue();
  } catch (err) { toast(err.message, true); }
}

function renderQueueTable() {
  const tabs = $('#tabs');
  if (!tabs) return;
  tabs.innerHTML = TABS.map(([k, label, fn]) => `<button role="tab" aria-selected="${k === S.queueTab}" class="${k === S.queueTab ? 'on' : ''}" data-tab="${k}">${label}<span class="num">${S.docs.filter(fn).length}</span></button>`).join('');
  $$('[data-tab]', tabs).forEach((b) => b.addEventListener('click', () => { S.queueTab = b.dataset.tab; renderQueueTable(); }));
  const list = queueList();
  const awaiting = S.docs.filter((d) => d.review_status === 'approved' && !d.signoff_at).length;
  const sa = $('#signoff-all');
  if (sa) { sa.textContent = `Sign off approved (${awaiting})`; sa.disabled = !awaiting; }
  if (!S.docs.length) {
    $('#qtable').innerHTML = `<div class="empty-state">No documents yet.<br><a class="btn" href="#/intake">Go to intake</a></div>`;
    return;
  }
  if (!list.length) { $('#qtable').innerHTML = `<div class="empty-state">${S.queueTab === 'review' ? 'Everything here has been decided.' : 'Nothing in this view.'}</div>`; return; }
  $('#qtable').innerHTML = `<table class="table"><thead><tr>
      <th>Case</th><th>File</th><th>Type</th><th>Counterparty</th><th class="r">Amount</th><th>Request</th><th>Confidence</th><th>Checks</th><th>Status</th>
    </tr></thead><tbody>
    ${list.map((d, i) => `<tr class="click" data-id="${esc(d.id)}" tabindex="0" style="--i:${Math.min(i, 18)}">
      <td class="mono">${esc(d.id)}</td>
      <td><div class="ellipsis" title="${esc(d.file_name)}">${esc(d.file_name)}</div></td>
      <td>${esc(TYPE[d.doc_type] || '—')}</td>
      <td><div class="ellipsis" style="max-width:180px">${esc(d.counterparty || '—')}</div></td>
      <td class="r num">${d.amount == null ? '<span class="faint">—</span>' : money(d.amount, d.currency)}</td>
      <td class="mono">${esc(d.requestId || '—')}</td>
      <td>${confHtml(d.overall)}</td>
      <td>${d.stage === 'queued' ? codesHtml(d.flags) : '<span class="faint">…</span>'}</td>
      <td>${statusChip(d)}</td>
    </tr>`).join('')}
    </tbody></table>`;
  $$('tr.click', $('#qtable')).forEach((tr) => {
    const go = () => { location.hash = `#/doc/${encodeURIComponent(tr.dataset.id)}`; };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
      else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); tr.nextElementSibling?.focus(); }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); tr.previousElementSibling?.focus(); }
    });
  });
}

// ---------------------------------------------------------------- review screen

const SHOW_FIELDS = {
  invoice: ['doc_type', 'counterparty', 'entity', 'reference', 'date', 'amount', 'currency'],
  bank_statement: ['doc_type', 'counterparty', 'entity', 'reference', 'period_start', 'period_end', 'amount', 'currency'],
  contract: ['doc_type', 'entity', 'counterparty', 'reference', 'date', 'amount', 'currency', 'signatures'],
  confirmation: ['doc_type', 'counterparty', 'entity', 'reference', 'date', 'amount', 'currency'],
  board_minutes: ['doc_type', 'entity', 'reference', 'date'],
  other: ['doc_type', 'entity', 'counterparty', 'reference', 'date', 'amount', 'currency'],
};

function fieldValue(k, v, d) {
  if (v == null || (Array.isArray(v) && !v.length)) return '<span class="val null">Not found</span>';
  if (k === 'doc_type') return `<span class="val">${esc(TYPE[v] || v)}</span>`;
  if (k === 'amount') return `<span class="val num">${money(v, d.fields.currency)}</span>`;
  if (k === 'date' || k === 'period_start' || k === 'period_end') return `<span class="val">${dateFmt(v)} <span class="faint mono">${esc(v)}</span></span>`;
  if (k === 'signatures') return `<span class="val">${v.map((s) => `${esc(s.party)}: <span style="color:${s.signed ? 'var(--blue)' : 'var(--red)'}">${s.signed ? 'signed' : 'not signed'}</span>`).join('<br>')}</span>`;
  return `<span class="val">${esc(v)}</span>`;
}
function fieldInput(k, v) {
  if (k === 'doc_type') return `<select name="doc_type">${Object.entries(TYPE).map(([t, l]) => `<option value="${t}" ${t === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  if (k === 'signatures') return `<div class="sig">${(v || []).map((s, i) => `<label><input type="checkbox" name="sig-${i}" data-party="${esc(s.party)}" ${s.signed ? 'checked' : ''}> ${esc(s.party)}</label>`).join('') || '<span class="faint">None found</span>'}</div>`;
  const type = k === 'amount' ? 'text" inputmode="decimal' : 'text';
  const ph = k.includes('date') || k.startsWith('period') ? 'YYYY-MM-DD' : '';
  return `<input type="${type}" name="${k}" value="${esc(v ?? '')}" placeholder="${ph}" autocomplete="off">`;
}

async function renderDoc() {
  const rt = renderSeq;
  const id = S.route.id;
  const d = await api(`/api/documents/${encodeURIComponent(id)}`);
  const integrity = await api(`/api/documents/${encodeURIComponent(id)}/integrity`).catch(() => null);
  if (rt !== renderSeq) return;
  let list = queueList(S.queueTab);
  if (!list.some((x) => x.id === id)) list = S.docs;
  const idx = list.findIndex((x) => x.id === id);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
  const f = d.fields || {};
  const keys = SHOW_FIELDS[f.doc_type] || SHOW_FIELDS.other;
  const flags = d.flags || [];
  const hard = flags.filter((x) => x.severity === 'flag');
  const warns = flags.filter((x) => x.severity === 'warning');
  const changedKeys = new Set(d.trail.filter((e) => e.action === 'fields.edited').flatMap((e) => e.detail.changes.map((c) => c.field)));
  const canReview = S.persona === 'reviewer';
  const pending = d.review_status === 'pending' && d.stage === 'queued';
  const ledger = d.match?.ledger;
  const isImage = d.mime?.startsWith('image/');

  const flagCard = (x) => `<div class="flagcard${x.severity === 'warning' ? ' warn' : ''}">
      <div class="ft"><span>${esc(x.title)}</span><span class="mono" style="font-weight:500">${esc(x.code)}</span></div>
      <div class="fm">${esc(x.message)}</div>
      ${x.expected != null || x.found != null ? `<div class="evf"><div><div class="l">Expected</div><div class="v">${esc(x.expected ?? '—')}</div></div><div><div class="l">Found</div><div class="v">${diffHtml(x.expected, x.found)}</div></div></div>` : ''}
    </div>`;

  let decision = '';
  if (d.stage !== 'queued') decision = `<div class="decision">Still processing (${esc(d.stage)}).</div>`;
  else if (pending) {
    decision = canReview
      ? `<textarea class="note" id="note" placeholder="${hard.length ? 'Required to approve: why these exceptions are acceptable. Also used as the reason if you reject.' : 'Optional note. Required as the reason if you reject.'}"></textarea>
         <div class="row" style="margin-top:12px">
           <button class="btn primary" id="approve">${hard.length ? 'Approve with exception' : 'Approve'}</button>
           <button class="btn danger" id="reject">Reject</button>
         </div>
         <div class="err" id="derr"></div>
         ${hard.length ? `<div class="hint">Held: ${hard.length} open flag${hard.length > 1 ? 's' : ''}. Correct the fields if the extraction is wrong, or record why the exception is acceptable.</div>` : ''}`
      : `<div class="gate spread"><span>Only the reviewer, ${esc(S.state.personas.reviewer.name)}, can approve, edit or reject.</span><button class="btn sm" data-persona="reviewer">Act as reviewer</button></div>`;
  } else {
    const verb = d.review_status === 'approved' ? 'Approved' : 'Rejected';
    const just = S.just === d.id;
    decision = `<div class="decision${just ? ' just' : ''}">${just ? '<svg class="tick" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9"/><path d="M6 10.5l2.6 2.6L14 7.6"/></svg>' : ''}<b>${verb}</b> by ${esc(d.reviewed_by)} · ${stamp(d.reviewed_at)}${d.review_note ? `<div style="margin-top:6px">${esc(d.review_note)}</div>` : ''}</div>`;
    if (d.signoff_at) decision += `<div class="decision" style="margin-top:8px"><b>Signed off</b> by ${esc(d.signoff_by)} · ${stamp(d.signoff_at)}</div>`;
    const btns = [];
    if (!d.signoff_at && canReview) btns.push('<button class="btn sm" id="reopen">Reopen</button>');
    if (d.review_status === 'approved' && !d.signoff_at) {
      if (S.persona === 'approver') btns.push('<button class="btn navy sm" id="signoff">Sign off</button>');
      else btns.push(`<span class="hint" style="margin:0">Awaiting sign-off by ${esc(S.state.personas.approver.name)}.</span> <button class="btn sm" data-persona="approver">Act as approver</button>`);
    }
    if (btns.length) decision += `<div class="row" style="margin-top:12px">${btns.join('')}</div><div class="err" id="derr"></div>`;
  }

  $('#view').innerHTML = `<div class="page" style="max-width:none">
    <div class="spread" style="margin-bottom:18px">
      <div class="row muted" style="font-size:13px"><a href="#/queue">Review queue</a><span class="faint">/</span><span class="mono">${esc(d.id)}</span></div>
      <div class="pager">
        <span class="keys faint"><kbd>&larr;</kbd><kbd>&rarr;</kbd> move${pending && canReview ? ' · <kbd>E</kbd> edit' : ''}</span>
        <button class="btn sm" id="prev" ${prev ? '' : 'disabled'}>Previous</button>
        <button class="btn sm" id="next" ${next ? '' : 'disabled'}>Next</button>
      </div>
    </div>
    <div class="head" style="margin-bottom:24px">
      <div>
        <div class="eyebrow">Case ${esc(d.id)}</div>
        <h1>${esc(d.file_name)}</h1>
        <div class="sub">${esc(TYPE[f.doc_type] || 'Unrecognised')} · received ${stamp(d.received_at)} from ${esc(d.uploaded_by)} · batch <span class="mono">${esc(d.batch_id)}</span></div>
      </div>
      <div>${statusChip(d)}</div>
    </div>
    <div class="review">
      <div class="viewer">
        <div class="tabs" style="margin-bottom:12px">
          <button class="${S.viewerTab === 'original' ? 'on' : ''}" data-vt="original">Original</button>
          <button class="${S.viewerTab === 'text' ? 'on' : ''}" data-vt="text">Text layer</button>
        </div>
        <div class="frame">${S.viewerTab === 'text'
          ? (() => {
              if (!d.text) return '<pre>No text layer. This file is an image or a scanned PDF; check it against the original.</pre>';
              const tr = S.trace && S.trace.id === d.id ? highlightText(d.text, valueForms(S.trace.k, f[S.trace.k])) : null;
              const banner = tr ? `<div class="tracebar"><span>${FIELD_LABEL[S.trace.k]}: ${tr.hits ? `found ${tr.hits} time${tr.hits === 1 ? '' : 's'} in the document` : '<b>not found as written.</b> Check the original.'}</span><button class="linkish" id="clear-trace">Clear</button></div>` : '';
              return `${banner}<pre id="textlayer">${tr ? tr.html : esc(d.text)}</pre>`;
            })()
          : isImage ? `<img id="imgview" alt="${esc(d.file_name)}">` : `<div class="pdf" id="pdfview" aria-label="${esc(d.file_name)}"><div class="faint" style="padding:24px">Rendering…</div></div>`}</div>
        <div class="integrity">
          <span class="mono" title="${esc(d.sha256)}">SHA-256 ${esc(d.sha256.slice(0, 16))}…</span>
          ${integrity ? (integrity.ok ? '<span class="ok">Original unchanged since upload</span>' : '<span class="bad">Stored file does not match its upload hash</span>') : ''}
        </div>
      </div>

      <div class="panel">
        <section>
          <h2>Checks</h2>
          ${d.stage !== 'queued' ? '<div class="muted">Running…</div>' : ''}
          ${hard.map(flagCard).join('')}
          ${warns.map(flagCard).join('')}
          ${d.stage === 'queued' && !flags.length ? '<div class="clean">All coded checks passed</div>' : ''}
          ${d.sampled ? '<div class="note-box">Selected in the random sample. Clean documents not in the sample were approved in batch; this one needs your individual decision.</div>' : ''}
          ${(() => { const cleared = (d.extraction?.initialFlags || []).filter((c) => !flags.some((x) => x.code === c)); return cleared.length ? `<div class="note-box">Raised at intake and cleared after a reviewer edit: ${cleared.map((c) => `<span class="code${c === 'LOW_CONFIDENCE' ? ' warn' : ''}">${esc(c)}</span>`).join(' ')}. The edit is in the activity log below.</div>` : ''; })()}
        </section>

        <section>
          <h2>Match</h2>
          <dl class="kv">
            <dt>Request item</dt><dd>${d.request ? `<span class="mono">${esc(d.request.id)}</span> ${esc(d.request.title)}` : '<span style="color:var(--red)">No match</span>'}</dd>
            ${ledger ? `<dt>Ledger line</dt><dd><span class="mono">${esc(ledger.id)}</span> ${esc(ledger.vendor)} · ${esc(ledger.invoiceNo)} · <span class="num">${money(ledger.amount, ledger.currency)}</span></dd>` : ''}
            ${d.trialBalance ? `<dt>Trial balance</dt><dd><span class="mono">${esc(d.trialBalance.id)}</span> ${esc(d.trialBalance.name)} · <span class="num">${money(d.trialBalance.balance, d.trialBalance.currency)}</span></dd>` : ''}
            ${d.request?.period ? `<dt>Period requested</dt><dd>${dateFmt(d.request.period.start)} to ${dateFmt(d.request.period.end)}</dd>` : ''}
            <dt>Matched on</dt><dd>${esc(d.match?.basis || '—')}${d.match?.score ? ` <span class="faint">· ${pct(d.match.score)}</span>` : ''}</dd>
          </dl>
        </section>

        <section>
          <div class="spread" style="margin-bottom:10px">
            <h2 style="margin:0">Extracted fields</h2>
            ${pending && canReview && !S.editing ? '<button class="btn sm" id="edit">Edit</button>' : ''}
          </div>
          <div class="muted" style="font-size:12px;margin-bottom:8px">Overall confidence ${confHtml(d.overall)}${d.edited ? ' · <span style="color:var(--navy)">edited by reviewer</span>' : ''}${S.editing ? '' : ' · <span class="faint">click a field to trace it</span>'}</div>
          <form id="fields-form">
            <table class="fields"><tbody>
              ${keys.map((k) => { const tr = !S.editing && valueForms(k, f[k]).length; return `<tr class="${changedKeys.has(k) ? 'changed' : ''}${tr ? ' traceable' : ''}${S.trace?.id === d.id && S.trace.k === k ? ' sel' : ''}" data-k="${k}" ${tr ? 'tabindex="0" title="Show where this appears in the document"' : ''}><td>${FIELD_LABEL[k]}</td><td>${S.editing ? fieldInput(k, f[k]) : fieldValue(k, f[k], d)}</td><td>${S.editing ? '' : confHtml(d.confidence?.[k] ?? null)}</td></tr>`; }).join('')}
            </tbody></table>
            ${S.editing ? '<div class="row" style="margin-top:12px"><button class="btn primary sm" type="submit">Save and re-run checks</button><button class="btn sm" type="button" id="cancel-edit">Cancel</button></div><div class="err" id="ferr"></div>' : ''}
          </form>
          ${(d.extraction?.notes || []).length ? `<div class="note-box">${d.extraction.notes.map(esc).join('<br>')}</div>` : ''}
        </section>

        <section id="decision-sec">
          <h2>Decision</h2>
          ${decision}
        </section>

        <section>
          <div class="spread" style="margin-bottom:10px"><h2 style="margin:0">Activity</h2><a href="#/audit/${encodeURIComponent(d.id)}" style="font-size:13px">Open in audit trail</a></div>
          <ul class="timeline">
            ${d.trail.map((e) => `<li><span class="ts">${clock(e.ts)}</span><span><span class="act">${esc(ACTION[e.action] || e.action)}</span> <span class="who">· ${esc(e.actor)}</span><br><span class="muted">${esc(describe(e))}</span></span></li>`).join('')}
          </ul>
        </section>
      </div>
    </div>
  </div>`;

  const origUrl = await engine.originalUrl(d.id);
  if ($('#pdfview')) renderPdf($('#pdfview'), origUrl, d.file_name);
  if ($('#imgview')) $('#imgview').src = origUrl;
  $('#prev').addEventListener('click', () => { if (prev) location.hash = `#/doc/${encodeURIComponent(prev.id)}`; });
  $('#next').addEventListener('click', () => { if (next) location.hash = `#/doc/${encodeURIComponent(next.id)}`; });
  $$('[data-vt]').forEach((b) => b.addEventListener('click', () => { S.viewerTab = b.dataset.vt; if (b.dataset.vt === 'original') S.trace = null; renderDoc(); }));
  const trace = async (k) => {
    S.trace = S.trace?.id === id && S.trace.k === k ? null : { id, k };
    if (S.trace) S.viewerTab = 'text';
    await renderDoc();
    $('#textlayer mark.trace')?.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
  };
  $$('#fields-form tr.traceable').forEach((tr) => {
    tr.addEventListener('click', () => trace(tr.dataset.k));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trace(tr.dataset.k); } });
  });
  $('#clear-trace')?.addEventListener('click', () => { S.trace = null; renderDoc(); });
  docKeys = (e) => {
    if (S.route.view !== 'doc' || isTouring() || $('#dialog').open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowLeft' && prev) location.hash = `#/doc/${encodeURIComponent(prev.id)}`;
    else if (e.key === 'ArrowRight' && next) location.hash = `#/doc/${encodeURIComponent(next.id)}`;
    else if ((e.key === 'e' || e.key === 'E') && $('#edit')) { S.editing = true; renderDoc(); }
  };
  $('#edit')?.addEventListener('click', () => { S.editing = true; renderDoc(); });
  $('#cancel-edit')?.addEventListener('click', () => { S.editing = false; renderDoc(); });
  $('#fields-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const out = {};
    for (const k of keys) {
      if (k === 'signatures') out.signatures = (f.signatures || []).map((s, i) => ({ party: s.party, signed: !!fd.get(`sig-${i}`) }));
      else out[k] = fd.get(k);
    }
    try { await api(`/api/documents/${encodeURIComponent(id)}/edit`, { method: 'POST', body: { fields: out } }); S.editing = false; toast('Fields saved. Checks re-run.'); await loadState(); renderDoc(); }
    catch (err) { $('#ferr').textContent = err.message; }
  });
  const act = async (path, body, msg) => {
    try {
      await api(`/api/documents/${encodeURIComponent(id)}/${path}`, { method: 'POST', body });
      S.just = path === 'reopen' ? null : id;
      toast(msg); await loadState(); await renderDoc();
      setTimeout(() => { if (S.just === id) S.just = null; }, 1500);
    }
    catch (err) { const el = $('#derr'); if (el) el.textContent = err.message; else toast(err.message, true); }
  };
  $('#approve')?.addEventListener('click', () => act('approve', { note: $('#note').value.trim() }, `${id} approved`));
  $('#reject')?.addEventListener('click', () => act('reject', { reason: $('#note').value.trim() }, `${id} rejected`));
  $('#reopen')?.addEventListener('click', () => act('reopen', {}, `${id} reopened`));
  $('#signoff')?.addEventListener('click', () => act('signoff', {}, `${id} signed off`));
}


// PDF.js renders the stored original onto canvases, so the viewer works in any browser.
async function renderPdf(host, url, title) {
  try {
    const lib = await engine.loadPdfJs();
    const pdf = await lib.getDocument(url).promise;
    if (!host.isConnected) return;
    host.innerHTML = '';
    const width = host.clientWidth - 72;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(0.5, width / base.width);
      const vp = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.style.width = `${Math.floor(base.width * scale)}px`;
      canvas.setAttribute('aria-label', `${title}, page ${i}`);
      host.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      canvas.classList.add('ready');
    }
  } catch {
    if (host.isConnected) host.innerHTML = `<iframe src="${url}" title="${esc(title)}"></iframe>`;
  }
}

// ---------------------------------------------------------------- client requests

async function renderRequests() {
  const rt = renderSeq;
  const [r, messages] = await Promise.all([api('/api/client-requests'), api('/api/client-messages')]);
  if (rt !== renderSeq) return;
  S.requests = r;
  const isClient = S.persona === 'client';
  const canDraft = S.persona === 'reviewer';
  const open = r.items.filter((x) => !x.sent);
  if (!S.reqSel) S.reqSel = new Set(open.map((x) => x.key));
  for (const k of [...S.reqSel]) if (!open.some((x) => x.key === k)) S.reqSel.delete(k);

  const history = messages.length ? messages.map((m) => `<div class="msg"><div class="spread"><b style="color:var(--navy);font-weight:600">${esc(m.subject)}</b><span class="muted" style="font-size:12px">${stamp(m.at)}</span></div>
      <div class="muted" style="font-size:12.5px;margin-top:2px">From ${esc(m.by)} to ${esc(m.to)} · ${m.items} item${m.items === 1 ? '' : 's'}${m.edited ? ' · edited before sending' : ''}</div><pre>${esc(m.body)}</pre></div>`).join('') : '<div class="empty-state" style="padding:28px 0">No messages sent yet.</div>';

  if (isClient) {
    $('#view').innerHTML = `<div class="page">
      <div class="head"><div><div class="eyebrow">From your audit team</div><h1>Requests for you</h1>
      <div class="sub">What the audit team still needs. Reply by uploading documents on the intake page.</div></div>
      <a class="btn primary" href="#/intake">Upload documents</a></div>
      <div style="max-width:820px">${history}</div></div>`;
    return;
  }

  const draft = r.draft;
  $('#view').innerHTML = `<div class="page">
    <div class="head"><div><div class="eyebrow">Client follow-up</div><h1>Client requests</h1>
      <div class="sub">Open queries, replacements and outstanding items, gathered from the checks. AI drafts one message; a person edits and sends it.</div></div></div>
    ${open.length ? `<div class="table-wrap"><table class="table"><thead><tr><th style="width:28px"><input type="checkbox" id="req-all" aria-label="Select all" ${S.reqSel.size === open.length ? 'checked' : ''} ${canDraft ? '' : 'disabled'}></th><th>Type</th><th>Item</th><th>What we found</th><th>What we need</th></tr></thead><tbody>
      ${open.map((x, i) => `<tr style="--i:${Math.min(i, 18)}"><td><input type="checkbox" data-key="${esc(x.key)}" ${S.reqSel.has(x.key) ? 'checked' : ''} ${canDraft ? '' : 'disabled'} aria-label="Include ${esc(x.file || x.requestId)}"></td>
        <td><span class="req-kind ${x.kind}">${x.kind}</span></td>
        <td style="white-space:nowrap">${x.caseId ? `<a class="mono" href="#/doc/${encodeURIComponent(x.caseId)}">${esc(x.caseId)}</a><div class="faint ellipsis" style="font-size:12px;max-width:200px">${esc(x.file)}</div>` : `<span class="mono">${esc(x.requestId)}</span>`}</td>
        <td style="min-width:260px">${esc(x.fact)}</td><td style="min-width:200px" class="muted">${esc(x.ask)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="margin-top:16px">
      ${canDraft ? `<button class="btn primary" id="draft-btn" ${S.reqSel.size ? '' : 'disabled'}>Draft message for ${S.reqSel.size} item${S.reqSel.size === 1 ? '' : 's'}</button>` : `<div class="gate spread" style="flex:1"><span>The reviewer drafts and sends client requests.</span><button class="btn sm" data-persona="reviewer">Act as reviewer</button></div>`}
    </div>` : `<div class="empty-state">${S.docs.length ? 'Nothing open for the client. Every query has been sent or resolved.' : 'Load the batch first. Requests appear here when checks find something the client needs to answer.'}</div>`}
    ${draft ? `<div class="draft" id="draft">
      <div class="spread"><h2 style="margin:0">Draft to ${esc(r.client.name)}</h2><span class="chip ${draft.drafted === 'ai' ? 'ok' : 'plain'}">${draft.drafted === 'ai' ? 'Drafted by AI' : 'Drafted from template'}</span></div>
      <div class="meta">${draft.drafted === 'ai' ? 'Facts come from the checks and are verified word for word before the draft is shown. Edit anything before sending.' : 'The AI draft was unavailable or did not keep every fact exactly, so the template was used.'}</div>
      <label class="label" for="d-subject" style="display:block;margin-bottom:6px">Subject</label>
      <input id="d-subject" value="${esc(draft.subject)}">
      <label class="label" for="d-body" style="display:block;margin:14px 0 6px">Message</label>
      <textarea id="d-body">${esc(draft.body)}</textarea>
      <div class="row" style="margin-top:14px">
        ${canDraft ? `<button class="btn primary" id="send-btn">Send to ${esc(r.client.name)}</button><button class="btn" id="redraft-btn">Draft again</button>` : ''}
        <span class="muted" style="font-size:12.5px">Sending records the message in the audit trail and on the client's request page.</span>
      </div>
      <div class="err" id="send-err"></div>
    </div>` : ''}
    <div class="section"><h2>Sent</h2><div style="max-width:880px">${history}</div></div>
  </div>`;

  const updateBtn = () => { const b = $('#draft-btn'); if (b) { b.disabled = !S.reqSel.size; b.textContent = `Draft message for ${S.reqSel.size} item${S.reqSel.size === 1 ? '' : 's'}`; } };
  $$('input[data-key]').forEach((cb) => cb.addEventListener('change', () => { cb.checked ? S.reqSel.add(cb.dataset.key) : S.reqSel.delete(cb.dataset.key); $('#req-all').checked = S.reqSel.size === open.length; updateBtn(); }));
  $('#req-all')?.addEventListener('change', (e) => { $$('input[data-key]').forEach((cb) => { cb.checked = e.target.checked; e.target.checked ? S.reqSel.add(cb.dataset.key) : S.reqSel.delete(cb.dataset.key); }); updateBtn(); });
  const doDraft = async (btn) => {
    btn.disabled = true; const t = btn.textContent; btn.innerHTML = '<span class="pulse"></span>Drafting';
    try { await api('/api/client-requests/draft', { method: 'POST', body: { keys: [...S.reqSel] } }); await renderRequests(); $('#draft')?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); }
    catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = t; }
  };
  $('#draft-btn')?.addEventListener('click', (e) => doDraft(e.currentTarget));
  $('#redraft-btn')?.addEventListener('click', (e) => doDraft(e.currentTarget));
  $('#send-btn')?.addEventListener('click', async () => {
    try {
      const out = await api('/api/client-requests/send', { method: 'POST', body: { subject: $('#d-subject').value, body: $('#d-body').value } });
      S.reqSel = null;
      toast(`Sent to ${r.client.name} · ${out.sent} item${out.sent === 1 ? '' : 's'} logged`);
      await loadState(); renderRequests();
    } catch (err) { $('#send-err').textContent = err.message; }
  });
}

// ---------------------------------------------------------------- audit

async function renderAudit() {
  const rt = renderSeq;
  const caseId = S.route.id;
  const [rows, chain] = await Promise.all([api(caseId ? `/api/audit?case=${encodeURIComponent(caseId)}` : '/api/audit?limit=1000'), api('/api/audit/verify')]);
  if (rt !== renderSeq) return;
  const q = S.auditFilter.toLowerCase();
  const shown = q ? rows.filter((e) => `${e.case_id} ${e.actor} ${e.role} ${e.action} ${ACTION[e.action]} ${describe(e)}`.toLowerCase().includes(q)) : rows;
  const keepFocus = document.activeElement?.id === 'afilter';
  $('#view').innerHTML = `<div class="page">
    <div class="head">
      <div><div class="eyebrow">Every step logged</div><h1>Audit trail${caseId ? ` <span class="mono" style="font-size:18px;color:var(--ink-2)">${esc(caseId)}</span>` : ''}</h1>
      <div class="sub">Append-only. Each entry stores the hash of the entry before it, so any change to history breaks the chain.</div></div>
      <div class="row">
        <span id="chain" class="chip ${chain.ok ? 'ok' : 'flag'}">${chain.ok ? `Chain verified · ${chain.entries} entries` : `Chain broken at #${chain.brokenAt}`}</span>
        <button class="btn sm" id="export-audit">Export CSV</button>
      </div>
    </div>
    <div class="row" style="margin-bottom:18px">
      ${caseId ? `<a class="btn sm" href="#/doc/${encodeURIComponent(caseId)}">Open case</a><a class="btn sm" href="#/audit">All entries</a>` : ''}
      <input id="afilter" class="inline-input" style="width:320px;font-family:var(--sans)" placeholder="Filter by case, person or event" value="${esc(S.auditFilter)}">
      <span class="muted" style="font-size:12.5px">${shown.length} of ${rows.length}</span>
    </div>
    ${rows.length ? `<div class="table-wrap"><table class="table tight"><thead><tr><th>#</th><th>Time</th><th>Case</th><th>Who</th><th>Role</th><th>Event</th><th>Detail</th><th>Hash</th></tr></thead><tbody>
      ${shown.map((e) => `<tr>
        <td class="num faint">${e.seq}</td>
        <td class="num" style="white-space:nowrap">${clock(e.ts)}<span class="faint">.${String(new Date(e.ts).getMilliseconds()).padStart(3, '0')}</span></td>
        <td class="mono" style="white-space:nowrap">${e.case_id ? `<a href="#/doc/${encodeURIComponent(e.case_id)}">${esc(e.case_id)}</a>` : esc(e.batch_id || '—')}</td>
        <td style="white-space:nowrap">${esc(e.actor)}</td>
        <td class="muted" style="white-space:nowrap">${esc(e.role)}</td>
        <td style="white-space:nowrap;font-weight:500;color:var(--navy)">${esc(ACTION[e.action] || e.action)}</td>
        <td style="min-width:300px;max-width:520px;overflow-wrap:anywhere">${esc(describe(e))}</td>
        <td class="mono faint" title="${esc(e.hash)}">${esc(e.hash.slice(0, 8))}</td>
      </tr>`).join('')}
    </tbody></table></div>` : '<div class="empty-state">No entries yet.</div>'}
  </div>`;
  $('#export-audit').addEventListener('click', () => engine.exportAudit());
  const inp = $('#afilter');
  inp.addEventListener('input', () => { S.auditFilter = inp.value; clearTimeout(inp._t); inp._t = setTimeout(renderAudit, 180); });
  if (keepFocus) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}

// ---------------------------------------------------------------- register

async function renderRegister() {
  const rt = renderSeq;
  const [reg, sc] = await Promise.all([api('/api/register'), S.scenario ? Promise.resolve(S.scenario) : api('/api/scenario')]);
  if (rt !== renderSeq) return;
  S.scenario = sc;
  const can = S.persona === 'approver';
  $('#view').innerHTML = `<div class="page">
    <div class="head"><div><div class="eyebrow">Visibility, control, accountability</div><h1>Governance</h1>
      <div class="sub">The register of AI use cases, the five checks each must pass, and the release gate that holds Pilot and Live until they do.${can ? '' : ' Checks, owner and status are changed by the approver.'}</div></div></div>
    <div class="table-wrap" id="register-table"><table class="table"><thead><tr><th>ID</th><th>Use case</th><th>Five checks</th><th>Model</th><th>Data source</th><th>Owner</th><th>Human control</th><th>Status</th><th>Notes</th></tr></thead><tbody>
      ${reg.rows.map((r) => `<tr data-uc="${esc(r.id)}">
        <td class="mono">${esc(r.id)}</td>
        <td style="min-width:180px"><div style="font-weight:500;color:var(--navy)">${esc(r.useCase)}</div><div class="muted" style="font-size:12.5px">${esc(r.serviceLine)} · ${esc(r.family)}</div>
          ${r.live ? `<div class="faint" style="font-size:12px;margin-top:4px">${r.live.documents} documents · ${r.live.rules} rules · threshold ${pct(r.live.threshold)}${r.live.lastRun ? ` · last run ${stamp(r.live.lastRun)}` : ''}</div>` : ''}</td>
        <td style="min-width:150px"><div class="checks">${reg.fiveChecks.map((c) => { const v = r.checks[c.key]; const tip = `${c.name}: ${c.question}. ${v.done ? `Attested by ${v.by}${v.note ? `: ${v.note}` : ''}` : `Open${v.note ? `: ${v.note}` : ''}`}`; return can ? `<button class="ck${v.done ? ' done' : ''}" data-ck="${c.key}" title="${esc(tip)}" aria-label="${esc(tip)}">${c.name[0]}</button>` : `<span class="ck${v.done ? ' done' : ''}" title="${esc(tip)}">${c.name[0]}</span>`; }).join('')}</div>
          <div class="relgate ${r.gateOpen ? 'open' : ''}">${r.gateOpen ? 'Release gate open' : `Gate held · ${reg.fiveChecks.filter((c) => !r.checks[c.key].done).length} open`}</div></td>
        <td style="min-width:140px">${esc(r.model)}</td>
        <td style="min-width:200px;font-size:13px">${esc(r.dataSource)}</td>
        <td style="min-width:150px"><input class="reg-edit" data-k="owner" value="${esc(r.owner)}" ${can ? '' : 'disabled'}></td>
        <td style="min-width:200px;font-size:13px">${esc(r.humanControl)}</td>
        <td style="min-width:116px"><select class="reg-edit" data-k="status" ${can ? '' : 'disabled'}>${reg.statuses.map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
        <td style="min-width:180px"><input class="reg-edit" data-k="notes" value="${esc(r.notes)}" ${can ? '' : 'disabled'}></td>
      </tr>`).join('')}
    </tbody></table></div>

    <div class="section">
      <h2>Controls in the evidence intake workflow</h2>
      <div class="sub" style="margin:-8px 0 14px">Plain coded checks. The rules decide the flag, not the model.</div>
      <div class="table-wrap"><table class="table tight"><thead><tr><th>Code</th><th>Check</th><th>Applies to</th><th>Logic</th><th>Outcome</th></tr></thead><tbody>
        ${sc.rules.map((r) => `<tr><td><span class="code${r.severity === 'warning' ? ' warn' : ''}">${esc(r.code)}</span></td><td style="font-weight:500">${esc(r.name)}</td><td class="muted">${esc(r.applies)}</td><td>${esc(r.logic)}</td><td>${r.severity === 'warning' ? 'Warning, routed to reviewer' : 'Flag, held for reviewer'}</td></tr>`).join('')}
      </tbody></table></div>
    </div>

    <div class="section">
      <h2>Settings</h2>
      <div class="row">
        <label class="muted" for="thr">Confidence threshold</label>
        <input id="thr" class="inline-input" value="${S.state.threshold.toFixed(2)}" ${can ? '' : 'disabled'}>
        ${can ? '<button class="btn sm" id="save-thr">Save</button>' : ''}
        <span class="muted" style="font-size:12.5px">Extractions below this go to the reviewer with a warning. Applies to documents processed after a change.</span>
      </div>
    </div>
  </div>`;
  $$('button.ck').forEach((b) => b.addEventListener('click', () => checkDialog(b.closest('tr').dataset.uc, b.dataset.ck, reg)));
  $$('.reg-edit').forEach((el) => el.addEventListener('change', async () => {
    const uc = el.closest('tr').dataset.uc;
    try { await api(`/api/register/${uc}`, { method: 'POST', body: { [el.dataset.k]: el.value } }); toast('Register updated'); }
    catch (err) { toast(err.message, true); renderRegister(); }
  }));
  async function checkDialog(uc, key, regData) {
    const row = regData.rows.find((x) => x.id === uc);
    const def = regData.fiveChecks.find((c) => c.key === key);
    const cur = row.checks[key];
    const d = $('#dialog');
    d.innerHTML = `<h3>${esc(def.name)}: ${esc(def.question)}</h3>
      <p>${esc(uc)} · ${esc(row.useCase)}. ${cur.done ? `Attested by ${esc(cur.by)}.` : 'Not yet attested.'}</p>
      <label class="label" for="ck-note" style="display:block;margin-bottom:6px">${cur.done ? 'Reason for withdrawing (optional)' : 'Evidence for this check'}</label>
      <textarea id="ck-note" class="note" placeholder="${cur.done ? '' : 'For example: reviewed by the risk team on 12 November'}">${cur.done ? '' : esc(cur.note || '')}</textarea>
      <div class="err" id="ck-err"></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" value="no">Cancel</button><button class="btn ${cur.done ? 'danger' : 'primary'}" value="yes">${cur.done ? 'Withdraw' : 'Attest'}</button></div>`;
    const submit = async () => {
      try {
        await api(`/api/register/${uc}`, { method: 'POST', body: { check: key, done: !cur.done, note: $('#ck-note').value } });
        d.close(); toast(`${def.name} ${cur.done ? 'withdrawn' : 'attested'}`); renderRegister();
      } catch (err) { $('#ck-err').textContent = err.message; }
    };
    $$('button', d).forEach((b) => b.addEventListener('click', () => { if (b.value === 'yes') submit(); else d.close(); }));
    d.showModal();
  }
  $('#save-thr')?.addEventListener('click', async () => {
    try { await api('/api/settings', { method: 'POST', body: { threshold: Number($('#thr').value) } }); toast('Threshold saved'); await loadState(); }
    catch (err) { toast(err.message, true); }
  });
}

// ---------------------------------------------------------------- results

async function renderResults() {
  const rt = renderSeq;
  const r = await api('/api/results');
  if (rt !== renderSeq) return;
  const can = S.persona === 'approver';
  if (!r.documentsScored) {
    $('#view').innerHTML = `<div class="page"><div class="head"><div><div class="eyebrow">Success measures</div><h1>Results</h1></div></div>
      <div class="empty-state">Run the synthetic batch to score the workflow against the answer sheet.<br><a class="btn primary" href="#/intake">Go to intake</a></div></div>`;
    return;
  }
  const a = r.accuracy, p = r.planted, t = r.time;
  const met = (ok) => `<div class="met ${ok ? 'yes' : 'no'}">${ok ? 'Met' : 'Not met'}</div>`;
  const secs = (v) => (v == null ? '—' : v < 10 ? v.toFixed(2) : v.toFixed(1));
  $('#view').innerHTML = `<div class="page">
    <div class="head">
      <div><div class="eyebrow">Success measures</div><h1>Results</h1>
      <div class="sub">${r.documentsScored} of ${r.documentsExpected} answer-sheet documents scored</div></div>
      <button class="btn sm" id="export-results">Export CSV</button>
    </div>

    <div class="measures" id="measures">
      <div class="measure">
        <div><div class="name">Extraction accuracy</div><div class="how">Original extracted fields (type, entity, date, amount, reference) compared to the answer sheet, before any human edit.</div></div>
        <div class="target">Target<br>90% of fields</div>
        <div class="big"><span data-count="${(a.value || 0) * 100}" data-key="res-acc" data-fmt="pct1">${(lastValues.get('res-acc') ?? 0).toFixed(1)}%</span><small>${a.correct} of ${a.total} fields</small></div>
        ${met(a.value >= 0.9)}
      </div>
      <div class="measure">
        <div><div class="name">Planted errors caught</div><div class="how">Rule flags raised at intake, checked against the five planted errors.</div></div>
        <div class="target">Target<br>5 of 5 flagged</div>
        <div class="big"><span data-count="${p.caught}" data-key="res-caught">${lastValues.get('res-caught') ?? 0}</span><small>of ${p.total} flagged</small></div>
        ${met(p.caught === p.total && p.total === 5)}
      </div>
      <div class="measure">
        <div><div class="name">Time per document</div><div class="how">Average from upload to reviewer queue, from audit log timestamps, including any wait for the reader. Record this with demo pacing off.</div></div>
        <div class="target">Target<br>under 30 s</div>
        <div class="big"><span data-count="${t.avgSeconds ?? 0}" data-key="res-time" data-fmt="s2">${FORMATS.s2(lastValues.get('res-time') ?? 0)}</span><small>average · max ${secs(t.maxSeconds)} s</small></div>
        ${met(t.avgSeconds != null && t.avgSeconds < 30)}
      </div>
    </div>

    <div class="grid-2 section">
      <div>
        <h2>Planted errors</h2>
        <div class="table-wrap"><table class="table tight"><thead><tr><th>Error</th><th>Case</th><th>Expected rule</th><th>Raised</th><th class="r">Caught</th></tr></thead><tbody>
          ${p.items.map((x) => `<tr><td><div>${esc(x.description)}</div><div class="faint" style="font-size:12px">${esc(x.file)}</div></td>
            <td class="mono">${x.id ? `<a href="#/doc/${encodeURIComponent(x.id)}">${esc(x.id)}</a>` : '<span class="faint">not received</span>'}</td>
            <td><span class="code">${esc(x.code)}</span></td><td>${codesHtml(x.raised.map((c) => ({ code: c, severity: c === 'LOW_CONFIDENCE' ? 'warning' : 'flag' })))}</td>
            <td class="r" style="font-weight:600;color:${x.caught ? 'var(--green)' : 'var(--red)'}">${x.caught ? 'Yes' : 'No'}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="note-box">False-positive flags on clean documents: <b>${p.falsePositives.length}</b>${p.falsePositives.length ? ` (${p.falsePositives.map((x) => `${esc(x.code)} on ${esc(x.file)}`).join('; ')})` : ''}.
          Sent to the reviewer with a low-confidence warning: ${p.lowConfidence.length ? p.lowConfidence.map((x) => `<a href="#/doc/${encodeURIComponent(x.id)}">${esc(x.file)}</a> (${pct(x.overall)})`).join(', ') : 'none'}.</div>
      </div>
      <div>
        <h2>Accuracy by field</h2>
        <table class="table tight"><thead><tr><th>Field</th><th class="r">Correct</th><th class="r">Rate</th></tr></thead><tbody>
          ${a.perField.map((x) => `<tr><td>${esc(FIELD_LABEL[x.field])}</td><td class="r num">${x.correct}/${x.total}</td><td class="r num"><span class="minibar"><i style="width:${(x.rate || 0) * 100}%"></i></span>${pct(x.rate, 1)}</td></tr>`).join('')}
          <tr><td>Request matching</td><td class="r num">${r.matching.correct}/${r.matching.total}</td><td class="r num">${pct(r.matching.correct / r.matching.total, 1)}</td></tr>
        </tbody></table>
        ${a.misses.length ? `<h3 style="margin-top:20px">Fields that missed</h3><table class="table tight"><tbody>${a.misses.map((m) => `<tr><td class="mono"><a href="#/doc/${encodeURIComponent(m.id)}">${esc(m.id)}</a></td><td>${esc(FIELD_LABEL[m.field])}</td><td class="muted">expected <span class="mono">${esc(fv(m.expected))}</span>, got <span class="mono">${esc(fv(m.extracted))}</span></td></tr>`).join('')}</tbody></table>` : ''}
      </div>
    </div>

    <div class="section">
      <h2>Time against manual intake</h2>
      <table class="table tight" style="max-width:760px"><tbody>
        <tr><td>Average, upload to reviewer queue</td><td class="r num">${secs(t.avgSeconds)} s</td></tr>
        <tr><td>Median</td><td class="r num">${secs(t.medianSeconds)} s</td></tr>
        <tr><td>Slowest document</td><td class="r num">${secs(t.maxSeconds)} s</td></tr>
        <tr><td>Manual estimate per document <span class="faint">(assumption)</span></td><td class="r"><input id="mm" class="inline-input" style="width:56px;text-align:right" value="${t.manualMinutes}" ${can ? '' : 'disabled'}> min ${can ? '<button class="btn sm" id="save-mm">Save</button>' : ''}</td></tr>
        <tr><td>Manual sorting, reading and matching for ${t.documents} documents</td><td class="r num">${t.manualHours.toFixed(1)} h</td></tr>
      </tbody></table>
      <div class="note-box">The workflow time covers sorting, reading, matching and checking. Reviewer decision time is not included in either figure; it applies to both routes. The manual estimate is an assumption to agree with the service line.</div>
    </div>
  </div>`;
  animateCounts($('#measures'));
  $('#export-results').addEventListener('click', () => engine.exportResults());
  $('#save-mm')?.addEventListener('click', async () => {
    try { await api('/api/settings', { method: 'POST', body: { manualMinutes: Number($('#mm').value) } }); toast('Estimate saved'); renderResults(); }
    catch (err) { toast(err.message, true); }
  });
}

// ---------------------------------------------------------------- boot

(async function boot() {
  S.route = parseRoute();
  try { await loadState(); } catch (err) { $('#view').innerHTML = `<div class="page"><h1>Server not reachable</h1><p class="sub">${esc(err.message)}</p></div>`; return; }
  if (!S.state.personas[S.persona]) S.persona = 'client';
  renderChrome();
  await render();
  connectEvents();
  engine.resume();
  const tourCtx = {
    getDocs: () => S.docs,
    navigate: (h) => { location.hash = h; },
    loadSample: async () => { await engine.request('/api/load-sample', { method: 'POST', body: { pace: false }, as: 'client' }); await loadState(); },
  };
  $('#tour-btn').addEventListener('click', () => startTour(tourCtx));
  if (shouldAutoStart()) setTimeout(() => startTour(tourCtx), 500);
})();
