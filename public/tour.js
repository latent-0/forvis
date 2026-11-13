// Onboarding tour: a spotlight that walks through the workflow across pages.
// Keyboard: Right/Enter next, Left back, Esc close. Respects reduced motion.

const DONE_KEY = 'tour-done-v1';

const STEPS = [
  { route: 'intake', title: 'Evidence intake, end to end', body: 'A client sends documents against a request list. AI reads them, coded rules check them, a named reviewer decides, a manager signs off, and every step is logged. This tour takes about a minute.', center: true },
  { route: 'intake', target: '#rail', title: 'Find your way', body: 'Hover the rail to open it. Each section shows a live preview, so you can see what is waiting before you click. Pin it open from the bottom of the rail.', place: 'right' },
  { route: 'intake', target: '#flow', title: 'The workflow at a glance', body: 'Each box is one step. The numbers update live as documents move through, and a moving line shows which steps are working.' },
  { route: 'intake', target: '#personas', title: 'Who you are acting as', body: 'Three roles. The client uploads, the reviewer approves, edits or rejects, and the manager signs off. Buttons only work for the role allowed to use them.', place: 'right' },
  { route: 'intake', target: '#upload', title: 'Start with an upload', body: 'As the client, drop files here or load the synthetic batch of 25 documents. Each file gets a case ID, and the original is kept untouched with its fingerprint.', offerLoad: true },
  { route: 'intake', target: '#coverage', title: 'Request list coverage', body: 'Every document is matched to an item on the request list, so you can see what has arrived, what is missing and what needs attention.' },
  { route: 'intake', target: '#log', title: 'Intake log', body: 'Each step writes an entry with the time and who or what did it. This is the start of the audit trail.', place: 'left' },
  { route: 'queue', target: '#tabs', title: 'Review queue', body: 'Nothing leaves the queue without a named reviewer. Flagged documents come first. Clean documents can be approved together, with a random sample held back for individual checking, as auditors do.', needsDocs: true },
  { route: 'doc', pick: 'flagged', target: '.flagcard', title: 'Why a document is held', body: 'A coded rule raised this flag, not the model. Expected and found sit side by side, with the difference marked.', needsDocs: true },
  { route: 'doc', pick: 'flagged', target: '#fields-form', title: 'Trace every field', body: 'Click any extracted field to see where it appears in the document text. Values that cannot be traced lose confidence and go to the reviewer.', needsDocs: true, place: 'left' },
  { route: 'doc', pick: 'flagged', target: '#decision-sec', title: 'The decision', body: 'Approve, edit or reject. Approving a flagged document needs a written reason, and the manager then signs off.', needsDocs: true, place: 'left' },
  { route: 'requests', target: '#view .head', title: 'Client follow-up, drafted for you', body: 'Every query, rejection and missing item becomes a request to the client. AI drafts one message from the facts, the facts are checked word for word, and the reviewer edits and sends it.', needsDocs: true },
  { route: 'audit', target: '#chain', title: 'A trail that cannot be quietly changed', body: 'Each entry stores the fingerprint of the one before it, so any edit to history breaks the chain. Export it as CSV at any time.' },
  { route: 'register', target: '#register-table', title: 'Governance with a release gate', body: 'Each AI use case is on the register with five checks: lawful, explainable, protected, fair and owned. A use case cannot move to Pilot or Live until all five are attested.' },
  { route: 'results', target: '#measures', title: 'Did it work?', body: 'Three measures, scored against an answer sheet written before the build: field accuracy, planted errors caught, and time per document.', needsDocs: true },
  { route: 'queue', title: 'Your turn', body: () => (ctx.getDocs().length ? 'Act as the reviewer, open a flagged document, and approve it with a note or reject it. Then act as the manager and sign off. Replay this tour any time from the sidebar.' : 'Act as the client and load the synthetic batch, then open a flagged document as the reviewer. Replay this tour any time from the sidebar.'), center: true, last: true },
];

let ctx = null; // { getDocs, navigate }
let root, spot, card, idx = 0, active = false, raf = 0;
const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function build() {
  root = el('div', 'tour');
  root.setAttribute('aria-hidden', 'false');
  spot = el('div', 'tour-spot');
  card = el('div', 'tour-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'false');
  card.setAttribute('aria-labelledby', 'tour-title');
  card.tabIndex = -1;
  root.append(spot, card);
  document.body.appendChild(root);
  card.addEventListener('click', (e) => {
    const a = e.target.closest('[data-t]');
    if (!a) return;
    if (a.dataset.t === 'next') go(1);
    else if (a.dataset.t === 'back') go(-1);
    else if (a.dataset.t === 'load') {
      a.disabled = true;
      a.textContent = 'Loading…';
      Promise.resolve(ctx.loadSample()).then(() => { if (active) go(1); }, () => { a.disabled = false; a.textContent = 'Load it for me'; });
    }
    else close();
  });
}

function visibleSteps() {
  const hasDocs = ctx.getDocs().length > 0;
  return STEPS.filter((s) => !s.needsDocs || hasDocs);
}

function waitFor(selector, timeout = 3500) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const n = document.querySelector(selector);
      if (n && n.getBoundingClientRect().height > 0) return resolve(n);
      if (performance.now() - t0 > timeout) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

async function show(i) {
  const steps = visibleSteps();
  idx = Math.max(0, Math.min(i, steps.length - 1));
  const s = steps[idx];
  root.classList.add('busy');
  // Navigate to the step's page.
  let hash = `#/${s.route}`;
  if (s.route === 'doc') {
    const pick = () => { const docs = ctx.getDocs(); return docs.find((x) => x.lane === 'flagged' && x.review_status === 'pending') || docs.find((x) => x.lane === 'flagged'); };
    let d = pick();
    if (!d) {
      current = { s: { center: true }, target: null };
      card.innerHTML = `<div class="tour-step">${idx + 1} of ${steps.length}</div><h3 id="tour-title">Reading the batch</h3><p><span class="pulse"></span>The tour continues as soon as the first flagged document is ready for review.</p><div class="tour-actions"><button class="linkish" data-t="close">Skip tour</button></div>`;
      place();
      root.classList.remove('busy');
      const t0 = Date.now();
      while (active && !(d = pick()) && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 500));
      if (!active) return;
      d ||= ctx.getDocs()[0];
    }
    hash = `#/doc/${encodeURIComponent(d.id)}`;
  }
  if (!location.hash.startsWith(hash)) ctx.navigate(hash);
  const target = s.center ? null : await waitFor(s.target);
  if (!active) return;
  if (target) {
    target.scrollIntoView({ block: 'center', behavior: reduce() ? 'auto' : 'smooth' });
    await new Promise((r) => setTimeout(r, reduce() ? 0 : 260));
  }
  card.innerHTML = `
    <div class="tour-progress"><i style="width:${((idx + 1) / steps.length) * 100}%"></i></div>
    <div class="tour-step">${idx + 1} of ${steps.length}</div>
    <h3 id="tour-title">${s.title}</h3>
    <p>${typeof s.body === 'function' ? s.body() : s.body}</p>
    <div class="tour-actions">
      <button class="linkish" data-t="close">${s.last ? 'Close' : 'Skip tour'}</button>
      <span class="row">
        ${idx > 0 ? '<button class="btn sm" data-t="back">Back</button>' : ''}
        ${s.offerLoad && !ctx.getDocs().length ? '<button class="btn sm" data-t="load">Load it for me</button>' : ''}
        <button class="btn primary sm" data-t="${s.last ? 'close' : 'next'}">${s.last ? 'Done' : idx === 0 ? 'Start' : 'Next'}</button>
      </span>
    </div>`;
  current = { s, target };
  place();
  root.classList.remove('busy');
  card.classList.remove('in');
  void card.offsetWidth;
  card.classList.add('in');
  card.focus({ preventScroll: true });
}

let current = null;
function place() {
  if (!current) return;
  const { s, target } = current;
  const pad = 8;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = Math.min(360, vw - 32);
  card.style.width = `${cw}px`;
  if (!target || !target.isConnected) {
    spot.classList.add('none');
    Object.assign(spot.style, { left: `${vw / 2}px`, top: `${vh / 2}px`, width: '0px', height: '0px' });
    const ch = card.offsetHeight;
    Object.assign(card.style, { left: `${(vw - cw) / 2}px`, top: `${Math.max(16, (vh - ch) / 2)}px` });
    return;
  }
  spot.classList.remove('none');
  const r = target.getBoundingClientRect();
  const top = Math.max(8, r.top - pad), left = Math.max(8, r.left - pad);
  const w = Math.min(vw - 16, r.width + pad * 2), h = Math.min(vh - 16, r.height + pad * 2);
  Object.assign(spot.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  const ch = card.offsetHeight;
  const gap = 14;
  let x, y;
  const fitsRight = left + w + gap + cw < vw - 12;
  const fitsLeft = left - gap - cw > 12;
  if (s.place === 'right' && fitsRight) { x = left + w + gap; y = top; }
  else if (s.place === 'left' && fitsLeft) { x = left - gap - cw; y = top; }
  else if (top + h + gap + ch < vh - 12) { x = left; y = top + h + gap; }
  else if (top - gap - ch > 12) { x = left; y = top - gap - ch; }
  else if (fitsRight) { x = left + w + gap; y = top; }
  else if (fitsLeft) { x = left - gap - cw; y = top; }
  else { x = (vw - cw) / 2; y = vh - ch - 16; }
  x = Math.max(16, Math.min(x, vw - cw - 16));
  y = Math.max(16, Math.min(y, vh - ch - 16));
  Object.assign(card.style, { left: `${x}px`, top: `${y}px` });
}

function onFrame() { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); }
function onKey(e) {
  if (!active) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'ArrowRight' || (e.key === 'Enter' && document.activeElement === card)) { e.preventDefault(); const st = visibleSteps(); if (idx < st.length - 1) go(1); else close(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
}
function go(d) { show(idx + d); }

export function startTour(c, from = 0) {
  ctx = c;
  if (!root) build();
  active = true;
  document.body.classList.add('touring');
  root.classList.add('open');
  window.addEventListener('resize', onFrame);
  window.addEventListener('scroll', onFrame, true);
  document.addEventListener('keydown', onKey, true);
  show(from);
}

export function close() {
  active = false;
  current = null;
  try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ }
  root?.classList.remove('open');
  document.body.classList.remove('touring');
  window.removeEventListener('resize', onFrame);
  window.removeEventListener('scroll', onFrame, true);
  document.removeEventListener('keydown', onKey, true);
}

export function shouldAutoStart() {
  try { return !localStorage.getItem(DONE_KEY); } catch { return false; }
}
export const isTouring = () => active;
