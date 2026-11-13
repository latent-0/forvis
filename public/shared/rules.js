// Matching and rule checks. Plain code, no model: the rules decide the flag.
import { REQUIRED } from './schema.js';

export const RULES = [
  { code: 'REQUIRED_FIELDS', name: 'Required fields present', severity: 'flag', applies: 'All documents', logic: 'Every field the document type needs (for example invoice number, date, total) must be extracted.' },
  { code: 'NO_MATCH', name: 'Matched to a request item', severity: 'flag', applies: 'All documents', logic: 'The document must link to an open item on the request list (and to a ledger line for invoices).' },
  { code: 'WRONG_ENTITY', name: 'Belongs to the audited entity', severity: 'flag', applies: 'All documents', logic: 'The entity on the document must be the engagement entity. For contracts, one of the parties must be.' },
  { code: 'AMOUNT_TOLERANCE', name: 'Invoice agrees to ledger', severity: 'flag', applies: 'Invoices', logic: 'Invoice gross total must equal the ledger line amount within the set tolerance.' },
  { code: 'DUPLICATE', name: 'Not a duplicate', severity: 'flag', applies: 'All documents', logic: 'No earlier document may have the same file hash, or the same counterparty and reference.' },
  { code: 'PERIOD', name: 'Covers the requested period', severity: 'flag', applies: 'Bank statements, confirmations', logic: 'Statement period must equal the requested period; confirmation as-at date must equal the year end.' },
  { code: 'BALANCE', name: 'Agrees to trial balance', severity: 'flag', applies: 'Bank statements, confirmations', logic: 'Closing or confirmed balance must equal the trial balance account in the same currency.' },
  { code: 'SIGNATURE', name: 'Signed by all parties', severity: 'flag', applies: 'Contracts', logic: 'Every signature block on the contract must carry a signature.' },
  { code: 'DATE_IN_FY', name: 'Dated in the financial year', severity: 'flag', applies: 'Invoices, board minutes', logic: 'Date must fall inside the financial year under audit.' },
  { code: 'LOW_CONFIDENCE', name: 'Extraction confidence above threshold', severity: 'warning', applies: 'All documents', logic: 'Overall extraction confidence below the threshold sends the document to the reviewer with a warning.' },
];
const RULE_BY_CODE = Object.fromEntries(RULES.map((r) => [r.code, r]));

export const norm = (s) => String(s || '').toLowerCase().replace(/\blimited\b/g, 'ltd').replace(/\bpublic limited company\b/g, 'plc').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
export const normRef = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtMoney = (v, c = '') => (v == null ? 'none' : `${c ? c + ' ' : ''}${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// ------------------------------------------------------------ matching

export function matchDocument(f, scenario) {
  const reqs = scenario.requests;
  const none = { requestId: null, basis: 'No request item matched', score: 0 };
  const tol = scenario.tolerance.amountAbs;
  switch (f.doc_type) {
    case 'invoice': {
      let line = scenario.ledger.find((l) => normRef(l.invoiceNo) === normRef(f.reference));
      let basis = 'Invoice number', score = 1;
      if (!line) { line = scenario.ledger.find((l) => norm(l.vendor) === norm(f.counterparty) && f.amount != null && Math.abs(l.amount - f.amount) <= tol); basis = 'Supplier and amount'; score = 0.8; }
      if (!line) { line = scenario.ledger.find((l) => norm(l.vendor) === norm(f.counterparty) && l.date === f.date); basis = 'Supplier and date'; score = 0.6; }
      if (!line) return none;
      const req = reqs.find((r) => r.ledgerLines?.includes(line.id));
      return { requestId: req?.id || null, requestTitle: req?.title, ledgerLine: line.id, ledger: line, basis, score };
    }
    case 'bank_statement': {
      const req = reqs.find((r) => r.docType === 'bank_statement' && r.account && String(f.reference || '').endsWith(r.account));
      if (!req) return none;
      return { requestId: req.id, requestTitle: req.title, tbAccount: req.tbAccount, basis: 'Account number', score: 1 };
    }
    case 'contract':
    case 'confirmation': {
      const names = [norm(f.counterparty), norm(f.entity)];
      const req = reqs.find((r) => r.docType === f.doc_type && names.includes(norm(r.counterparty)));
      if (!req) return none;
      return { requestId: req.id, requestTitle: req.title, tbAccount: req.tbAccount, basis: 'Counterparty', score: 0.95 };
    }
    case 'board_minutes': {
      const req = reqs.find((r) => r.docType === 'board_minutes');
      if (!req) return none;
      const known = req.references?.some((x) => normRef(x) === normRef(f.reference));
      return { requestId: req.id, requestTitle: req.title, basis: known ? 'Resolution reference' : 'Document type', score: known ? 1 : 0.7 };
    }
    default:
      return none;
  }
}

// ------------------------------------------------------------ rules

export function runRules({ id, sha256, fields: f, confidence, match }, scenario, { others = [], threshold = 0.8 } = {}) {
  const flags = [];
  const eng = scenario.engagement;
  const add = (code, message, expected = null, found = null) => flags.push({ code, severity: RULE_BY_CODE[code].severity, title: RULE_BY_CODE[code].name, message, expected, found });

  const req = REQUIRED[f.doc_type] || REQUIRED.other;
  const missing = req.filter((k) => f[k] == null || (Array.isArray(f[k]) && !f[k].length));
  if (f.doc_type === 'other' || !f.doc_type) add('REQUIRED_FIELDS', 'Document type not recognised.', 'A known evidence type', f.doc_type || 'none');
  else if (missing.length) add('REQUIRED_FIELDS', `Missing: ${missing.join(', ').replace(/_/g, ' ')}.`, 'All required fields', `${missing.length} missing`);

  if (!match?.requestId) add('NO_MATCH', 'No request item or ledger line matches this document.', 'An open request item', 'none');

  if (f.doc_type && f.doc_type !== 'other' && f.entity) {
    const parties = f.doc_type === 'contract' ? [f.entity, f.counterparty] : [f.entity];
    if (!parties.some((p) => norm(p) === norm(eng.entity))) add('WRONG_ENTITY', 'The document names a different entity from the one under audit.', eng.entity, f.entity);
  }

  if (f.doc_type === 'invoice' && match?.ledger && f.amount != null) {
    const diff = Math.round((f.amount - match.ledger.amount) * 100) / 100;
    if (Math.abs(diff) > scenario.tolerance.amountAbs) add('AMOUNT_TOLERANCE', `Invoice differs from ledger line ${match.ledger.id} by ${fmtMoney(diff, 'GBP')}.`, fmtMoney(match.ledger.amount, 'GBP'), fmtMoney(f.amount, f.currency || 'GBP'));
  }

  const dup = others.filter((o) => o.id < id).find((o) =>
    o.sha256 === sha256 ||
    (o.fields && f.doc_type === o.fields.doc_type && f.reference && normRef(o.fields.reference) === normRef(f.reference) && norm(o.fields.counterparty) === norm(f.counterparty)));
  if (dup) add('DUPLICATE', dup.sha256 === sha256 ? `Identical file already received as ${dup.id}.` : `Same counterparty and reference as ${dup.id} (${dup.fileName}).`, 'A document not already received', `Duplicate of ${dup.id}`);

  const reqItem = scenario.requests.find((r) => r.id === match?.requestId);
  if (f.doc_type === 'bank_statement' && reqItem?.period) {
    if (f.period_start !== reqItem.period.start || f.period_end !== reqItem.period.end) add('PERIOD', 'Statement period differs from the period requested.', `${reqItem.period.start} to ${reqItem.period.end}`, `${f.period_start || '?'} to ${f.period_end || '?'}`);
  }
  if (f.doc_type === 'confirmation' && reqItem?.asAt && f.date && f.date !== reqItem.asAt) add('PERIOD', 'Confirmation is not as at the year end.', reqItem.asAt, f.date);

  if ((f.doc_type === 'bank_statement' || f.doc_type === 'confirmation') && reqItem?.tbAccount && f.amount != null) {
    const tb = scenario.trialBalance.find((t) => t.id === reqItem.tbAccount);
    if (tb && (Math.abs(tb.balance - f.amount) > scenario.tolerance.amountAbs || (f.currency && f.currency !== tb.currency))) {
      add('BALANCE', `Balance does not agree to ${tb.id} (${tb.name}).`, fmtMoney(tb.balance, tb.currency), fmtMoney(f.amount, f.currency));
    }
  }

  if (f.doc_type === 'contract' && Array.isArray(f.signatures) && f.signatures.length) {
    const unsigned = f.signatures.filter((s) => !s.signed);
    if (unsigned.length) add('SIGNATURE', `Unsigned: ${unsigned.map((s) => s.party).join(', ')}.`, `${f.signatures.length} of ${f.signatures.length} signed`, `${f.signatures.length - unsigned.length} of ${f.signatures.length} signed`);
  }

  if ((f.doc_type === 'invoice' || f.doc_type === 'board_minutes') && f.date && (f.date < eng.fy.start || f.date > eng.fy.end)) {
    add('DATE_IN_FY', 'Date falls outside the financial year.', `${eng.fy.start} to ${eng.fy.end}`, f.date);
  }

  const overall = confidence?.overall ?? 1;
  if (overall < threshold) add('LOW_CONFIDENCE', 'The extraction is uncertain. Check every field against the original.', `≥ ${Math.round(threshold * 100)}%`, `${Math.round(overall * 100)}%`);

  return flags;
}
