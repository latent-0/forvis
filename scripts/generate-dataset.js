// Generates the synthetic evidence batch (25 PDFs), the engagement scenario
// (request list, ledger, trial balance) and the answer sheet, before any build runs.
// All names, numbers and bank details are invented.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PdfDoc, textWidth } from '../lib/pdf.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'dataset');
const DOCS = path.join(OUT, 'documents');
fs.rmSync(DOCS, { recursive: true, force: true });
fs.mkdirSync(DOCS, { recursive: true });

const ENTITY = 'Northwind Components Ltd';
const ENTITY_ADDR = ['Unit 4, Riverside Park', 'Leeds LS10 1QJ'];
const FY = { start: '2025-10-01', end: '2026-09-30' };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = MONTHS.map((m) => m.slice(0, 3));
const d = (iso) => { const [y, m, dd] = iso.split('-').map(Number); return { y, m, d: dd }; };
const fmt = {
  long: (iso) => { const x = d(iso); return `${x.d} ${MONTHS[x.m - 1]} ${x.y}`; },
  short: (iso) => { const x = d(iso); return `${String(x.d).padStart(2, '0')} ${MON[x.m - 1]} ${x.y}`; },
  uk: (iso) => { const x = d(iso); return `${String(x.d).padStart(2, '0')}/${String(x.m).padStart(2, '0')}/${x.y}`; },
  iso: (iso) => iso,
  dash: (iso) => { const x = d(iso); return `${String(x.d).padStart(2, '0')}-${MON[x.m - 1]}-${x.y}`; },
};
const money = (v) => v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (v) => Math.round(v * 100) / 100;

const NAVY = '#1f2a44';
const GREY = '#6b6b6b';
const RULE = '#c9c9c9';

// ---------------------------------------------------------------- Scenario

const ledger = [];
const requests = [
  { id: 'R01', title: 'Supplier invoices, purchases sample A', docType: 'invoice', expectedCount: 5, ledgerLines: ['L-2101', 'L-2102', 'L-2103', 'L-2104', 'L-2105'] },
  { id: 'R02', title: 'Supplier invoices, purchases sample B', docType: 'invoice', expectedCount: 4, ledgerLines: ['L-2106', 'L-2107', 'L-2108', 'L-2109'] },
  { id: 'R03', title: 'Bank statement, operating account, September 2026', docType: 'bank_statement', expectedCount: 1, account: '4417', period: { start: '2026-09-01', end: '2026-09-30' }, tbAccount: 'TB-1210' },
  { id: 'R04', title: 'Bank statement, payroll account, September 2026', docType: 'bank_statement', expectedCount: 1, account: '4425', period: { start: '2026-09-01', end: '2026-09-30' }, tbAccount: 'TB-1220' },
  { id: 'R05', title: 'Bank statement, deposit account, September 2026', docType: 'bank_statement', expectedCount: 1, account: '7781', period: { start: '2026-09-01', end: '2026-09-30' }, tbAccount: 'TB-1230' },
  { id: 'R06', title: 'Bank statement, USD account, September 2026', docType: 'bank_statement', expectedCount: 1, account: '9930', period: { start: '2026-09-01', end: '2026-09-30' }, tbAccount: 'TB-1240' },
  { id: 'R07', title: 'Master supply agreement, Halden Steel', docType: 'contract', expectedCount: 1, counterparty: 'Halden Steel Ltd' },
  { id: 'R08', title: 'Lease, Unit 4 Riverside Park', docType: 'contract', expectedCount: 1, counterparty: 'Riverside Estates Ltd' },
  { id: 'R09', title: 'Distribution agreement, Corvel Retail', docType: 'contract', expectedCount: 1, counterparty: 'Corvel Retail plc' },
  { id: 'R10', title: 'Software licence, Tessaly Systems', docType: 'contract', expectedCount: 1, counterparty: 'Tessaly Systems Ltd' },
  { id: 'R11', title: 'Loan facility agreement, Brightwater Bank', docType: 'contract', expectedCount: 1, counterparty: 'Brightwater Bank plc' },
  { id: 'R12', title: 'Bank confirmation, Brightwater Bank', docType: 'confirmation', expectedCount: 1, counterparty: 'Brightwater Bank plc', asAt: FY.end, tbAccount: 'TB-1210' },
  { id: 'R13', title: 'Customer balance confirmation, Corvel Retail', docType: 'confirmation', expectedCount: 1, counterparty: 'Corvel Retail plc', asAt: FY.end, tbAccount: 'TB-1100' },
  { id: 'R14', title: 'Supplier balance confirmation, Halden Steel', docType: 'confirmation', expectedCount: 1, counterparty: 'Halden Steel Ltd', asAt: FY.end, tbAccount: 'TB-2100' },
  { id: 'R15', title: 'Board minutes approving material transactions, FY2026', docType: 'board_minutes', expectedCount: 3, references: ['BR-2026-04', 'BR-2026-06', 'BR-2026-09'] },
];

const trialBalance = [
  { id: 'TB-1100', name: 'Trade debtors: Corvel Retail plc', currency: 'GBP', balance: 186420.0 },
  { id: 'TB-1210', name: 'Cash at bank: operating account 4417', currency: 'GBP', balance: 412906.55 },
  { id: 'TB-1220', name: 'Cash at bank: payroll account 4425', currency: 'GBP', balance: 86210.0 },
  { id: 'TB-1230', name: 'Cash at bank: deposit account 7781', currency: 'GBP', balance: 250812.33 },
  { id: 'TB-1240', name: 'Cash at bank: USD account 9930', currency: 'USD', balance: 58440.12 },
  { id: 'TB-2100', name: 'Trade creditors: Halden Steel Ltd', currency: 'GBP', balance: 39565.2 },
];

// ---------------------------------------------------------------- Builders

function letterhead(pdf, name, addr, accent = NAVY) {
  pdf.rect(0, 0, 595.28, 6, { fill: accent });
  pdf.text(50, 56, name, { font: 'B', size: 16, color: accent });
  addr.forEach((a, i) => pdf.text(50, 74 + i * 12, a, { size: 9, color: GREY }));
  pdf.line(50, 74 + addr.length * 12 + 10, 545, 74 + addr.length * 12 + 10, { color: RULE });
  return 74 + addr.length * 12 + 34;
}
function kv(pdf, x, y, label, value, w = 110) {
  pdf.text(x, y, label, { size: 9, color: GREY });
  pdf.text(x + w, y, value, { size: 10 });
}
function footer(pdf, s) { pdf.text(50, 810, s, { size: 7.5, color: GREY }); }
function signature(pdf, y, forWhom, signer, signed, dateIso) {
  pdf.text(50, y, `Signed for and on behalf of ${forWhom}`, { size: 9.5 });
  pdf.text(50, y + 26, 'Signature:', { size: 9, color: GREY });
  if (signed) pdf.text(120, y + 24, signer.split(',')[0], { font: 'I', size: 15, color: '#1b2a6b' });
  pdf.line(118, y + 29, 330, y + 29, { color: '#777777' });
  pdf.text(50, y + 46, 'Name:', { size: 9, color: GREY });
  if (signed) pdf.text(120, y + 46, signer, { size: 9.5 });
  pdf.text(50, y + 62, 'Date:', { size: 9, color: GREY });
  if (signed) pdf.text(120, y + 62, fmt.long(dateIso), { size: 9.5 });
  return y + 92;
}

const files = [];
const answers = [];
function save(file, pdf, answer) {
  const buf = pdf.toBuffer();
  fs.writeFileSync(path.join(DOCS, file), buf);
  files.push(file);
  answers.push({ file, sha256: crypto.createHash('sha256').update(buf).digest('hex'), ...answer });
}

// ---------------------------------------------------------------- Invoices (10)

const LBL = {
  A: { no: 'Invoice No:', date: 'Invoice Date:', bill: 'Bill To:', total: 'Total Due' },
  B: { no: 'Invoice number', date: 'Date of issue', bill: 'Invoice to', total: 'Amount due' },
  C: { no: 'Inv. No.', date: 'Tax point', bill: 'Customer', total: 'TOTAL' },
};
const invoices = [
  { file: 'INV_HS-40917.pdf', ledger: 'L-2101', req: 'R01', vendor: 'Halden Steel Ltd', addr: ['Unit 9, Furnace Road', 'Sheffield S9 2RT', 'VAT GB 284 1190 37'], no: 'HS-40917', date: '2026-03-14', df: 'long', lb: 'A', lines: [['Hot rolled steel plate 6mm, grade S275 (tonne)', 15, 1025.0]] },
  { file: 'arbor packaging april.pdf', ledger: 'L-2102', req: 'R01', vendor: 'Arbor Packaging Ltd', addr: ['14 Mill Lane', 'Bradford BD4 7HE'], no: 'AP-2211', date: '2026-04-02', df: 'uk', lb: 'B', lines: [['Double-wall cartons 600x400x400', 900, 2.45], ['Pallet wrap, 23 micron (roll)', 25, 21.98]] },
  { file: 'KF-88310.pdf', ledger: 'L-2103', req: 'R01', vendor: 'Kestrel Freight Ltd', addr: ['Kestrel House, Dock Road', 'Hull HU9 1TA'], no: 'KF-88310', date: '2026-04-19', df: 'iso', lb: 'C', lines: [['Haulage Leeds to Rotterdam, 40ft (load)', 8, 720.0]] },
  { file: 'Lumen_Electrical_LES-5521.pdf', ledger: 'L-2104', req: 'R01', vendor: 'Lumen Electrical Supplies Ltd', addr: ['3 Beacon Way', 'Wakefield WF2 0XL'], no: 'LES-5521', date: '2026-05-07', df: 'long', lb: 'A', lines: [['Control panel enclosures IP66', 40, 168.5], ['Cable assemblies 2m, shielded', 310, 4.71]] },
  { file: 'pellham tooling 00764.pdf', ledger: 'L-2105', req: 'R01', vendor: 'Pellham Tooling Ltd', addr: ['Pellham Works, Station Road', 'Rotherham S60 1BN'], no: 'PT-00764', date: '2026-05-28', df: 'dash', lb: 'B', lines: [['CNC fixture plates, machined', 10, 1025.0]] },
  { file: 'TS-2026-118 invoice.pdf', ledger: 'L-2106', req: 'R02', vendor: 'Tessaly Systems Ltd', addr: ['Floor 6, 22 Quay Street', 'Manchester M3 3JE'], no: 'TS-2026-118', date: '2026-06-15', df: 'long', lb: 'A', lines: [['Plant scheduling software, annual licence', 1, 20000.0]] },
  { file: 'BVF-3093.pdf', ledger: 'L-2107', req: 'R02', vendor: 'Brook & Vane Facilities Ltd', addr: ['2 Canal Wharf', 'Leeds LS11 5PS'], no: 'BVF-3093', date: '2026-07-03', df: 'uk', lb: 'C', lines: [['Planned maintenance, Q3 (site visits)', 1, 9800.0], ['Reactive call-outs (11 visits)', 1, 2591.67]], planted: { code: 'AMOUNT_TOLERANCE', description: 'Invoice amount differs from the ledger line (GBP 14,870.00 on the invoice, GBP 14,780.00 in the ledger)' }, ledgerAmount: 14780.0 },
  { file: 'Halden HS-41388.pdf', ledger: 'L-2108', req: 'R02', vendor: 'Halden Steel Ltd', addr: ['Unit 9, Furnace Road', 'Sheffield S9 2RT', 'VAT GB 284 1190 37'], no: 'HS-41388', date: '2026-08-11', df: 'long', lb: 'A', lines: [['Cold rolled coil 1.5mm (tonne)', 16, 1099.75]] },
  { file: 'corran_cc77204.pdf', ledger: 'L-2109', req: 'R02', vendor: 'Corran Chemicals Ltd', addr: ['Unit 2, Saltaire Trading Estate', 'Shipley BD18 3LA'], no: 'CC-77204', date: '2026-09-02', df: 'short', lb: 'B', lines: [['Industrial degreaser, 200L drum', 6, 512.07], ['Corrosion inhibitor, 25L', 14, 56.08]] },
];

function renderInvoice(inv, { scanned = false } = {}) {
  const pdf = new PdfDoc({ title: scanned ? 'scan_0042' : `Invoice ${inv.no}`, author: scanned ? 'MFP-3F scanner' : inv.vendor, created: scanned ? new Date('2026-10-28T14:02:11Z') : new Date(`${inv.date}T09:00:00Z`) });
  const L = LBL[inv.lb];
  let y = letterhead(pdf, inv.vendor, inv.addr);
  pdf.text(545, 56, 'INVOICE', { font: 'B', size: 20, align: 'right', color: '#333333' });
  kv(pdf, 330, y, L.no, inv.no, 85);
  kv(pdf, 330, y + 16, L.date, fmt[inv.df](inv.date), 85);
  kv(pdf, 330, y + 32, 'Terms:', '30 days net', 85);
  pdf.text(50, y, L.bill, { size: 9, color: GREY });
  pdf.text(50, y + 16, ENTITY, { font: 'B', size: 10 });
  pdf.text(50, y + 30, ENTITY_ADDR[0], { size: 9.5 });
  pdf.text(50, y + 42, ENTITY_ADDR[1], { size: 9.5 });
  y += 84;
  pdf.rect(50, y - 13, 495, 20, { fill: '#f1f1f1' });
  pdf.text(58, y, 'Description', { font: 'B', size: 9 });
  pdf.text(360, y, 'Qty', { font: 'B', size: 9, align: 'right' });
  pdf.text(450, y, 'Unit price', { font: 'B', size: 9, align: 'right' });
  pdf.text(537, y, 'Line total', { font: 'B', size: 9, align: 'right' });
  y += 24;
  let net = 0;
  for (const [desc, qty, unit] of inv.lines) {
    const lt = r2(qty * unit);
    net = r2(net + lt);
    pdf.text(58, y, desc, { size: 9.5 });
    pdf.text(360, y, String(qty), { size: 9.5, align: 'right' });
    pdf.text(450, y, money(r2(unit)), { size: 9.5, align: 'right' });
    pdf.text(537, y, money(lt), { size: 9.5, align: 'right' });
    pdf.line(50, y + 8, 545, y + 8, { color: '#e2e2e2' });
    y += 22;
  }
  const vat = r2(net * 0.2);
  const total = r2(net + vat);
  y += 12;
  pdf.text(360, y, 'Subtotal', { size: 9, color: GREY }); pdf.text(537, y, `GBP ${money(net)}`, { size: 9.5, align: 'right' });
  pdf.text(360, y + 16, 'VAT at 20%', { size: 9, color: GREY }); pdf.text(537, y + 16, `GBP ${money(vat)}`, { size: 9.5, align: 'right' });
  pdf.line(360, y + 26, 545, y + 26, { color: '#888888' });
  pdf.text(360, y + 42, L.total, { font: 'B', size: 10.5 }); pdf.text(537, y + 42, `GBP ${money(total)}`, { font: 'B', size: 10.5, align: 'right' });
  pdf.text(50, y + 90, 'Payment by BACS to the account shown on your supplier record. Please quote the invoice number.', { size: 8.5, color: GREY });
  footer(pdf, scanned ? 'Scanned copy  |  MFP-3F  |  28/10/2026 14:02  |  Page 1 of 1' : `${inv.vendor}  |  Registered in England and Wales  |  Page 1 of 1`);
  return { pdf, total };
}

for (const inv of invoices) {
  const { pdf, total } = renderInvoice(inv);
  ledger.push({ id: inv.ledger, vendor: inv.vendor, invoiceNo: inv.no, date: inv.date, currency: 'GBP', amount: inv.ledgerAmount ?? total });
  save(inv.file, pdf, {
    request: inv.req, ledgerLine: inv.ledger,
    expected: { doc_type: 'invoice', entity: ENTITY, date: inv.date, amount: total, reference: inv.no },
    planted: inv.planted || null,
  });
}
// The duplicate: same invoice re-sent as a scan under a different name (different bytes).
{
  const inv = invoices[2];
  const { pdf, total } = renderInvoice(inv, { scanned: true });
  save('scan_0042.pdf', pdf, {
    request: inv.req, ledgerLine: inv.ledger,
    expected: { doc_type: 'invoice', entity: ENTITY, date: inv.date, amount: total, reference: inv.no },
    planted: { code: 'DUPLICATE', description: 'Duplicate of invoice KF-88310 sent again under a different file name' },
  });
}

// ---------------------------------------------------------------- Bank statements (4)

const BANK = 'Brightwater Bank plc';
const BANK_ADDR = ['Commercial Banking, 1 Exchange Square', 'Leeds LS1 4BW', 'Sort code 30-91-77'];
const statements = [
  { file: 'Statement_Sep26_4417.pdf', req: 'R03', acct: '4417', name: 'Business Current Account', ccy: 'GBP', start: '2026-09-01', end: '2026-09-30', open: 398115.4,
    tx: [['2026-09-02', 'Receipt Corvel Retail plc', 92400.0], ['2026-09-05', 'BACS Halden Steel Ltd', -21115.2], ['2026-09-12', 'Transfer to payroll 4425', -84000.0], ['2026-09-19', 'Receipt Marlow Hydraulics', 41210.0], ['2026-09-26', 'BACS Corran Chemicals Ltd', -4628.9], ['2026-09-29', 'Card settlements', -9074.75]] },
  { file: 'payroll acct sept.pdf', req: 'R04', acct: '4425', name: 'Payroll Account', ccy: 'GBP', start: '2026-09-01', end: '2026-09-30', open: 79430.0,
    tx: [['2026-09-12', 'Transfer from operating 4417', 84000.0], ['2026-09-25', 'Salaries September', -71890.0], ['2026-09-28', 'HMRC PAYE/NIC', -5330.0]] },
  { file: 'Brightwater deposit 7781 Sep 2026.pdf', req: 'R05', acct: '7781', name: '95-Day Notice Deposit', ccy: 'GBP', start: '2026-09-01', end: '2026-09-30', open: 250000.0,
    tx: [['2026-09-30', 'Gross interest', 812.33]] },
  { file: 'USD_9930_statement.pdf', req: 'R06', acct: '9930', name: 'Currency Account USD', ccy: 'USD', start: '2026-08-01', end: '2026-08-31', open: 47115.62,
    tx: [['2026-08-06', 'Receipt Atlas Fabrication Inc', 18640.0], ['2026-08-14', 'Payment Ohio Bearing Co', -6320.15], ['2026-08-27', 'Receipt Atlas Fabrication Inc', 1567.0]],
    planted: { code: 'PERIOD', description: 'Statement covers August 2026; the request is for September 2026' } },
];
for (const st of statements) {
  const close = r2(st.open + st.tx.reduce((a, t) => a + t[2], 0));
  const pdf = new PdfDoc({ title: `Statement ${st.acct}`, author: BANK, created: new Date(`${st.end}T23:00:00Z`) });
  let y = letterhead(pdf, BANK, BANK_ADDR, '#0b4f6c');
  pdf.text(545, 56, 'STATEMENT OF ACCOUNT', { font: 'B', size: 12, align: 'right', color: '#333333' });
  kv(pdf, 50, y, 'Account name', ENTITY); kv(pdf, 50, y + 16, 'Account', `${st.name}`);
  kv(pdf, 50, y + 32, 'Account number', `30-91-77 ****${st.acct}`); kv(pdf, 50, y + 48, 'Currency', st.ccy);
  kv(pdf, 50, y + 64, 'Statement period', `${fmt.short(st.start)} to ${fmt.short(st.end)}`);
  y += 100;
  pdf.rect(50, y - 13, 495, 20, { fill: '#eef3f5' });
  pdf.text(58, y, 'Date', { font: 'B', size: 9 }); pdf.text(140, y, 'Description', { font: 'B', size: 9 });
  pdf.text(450, y, 'Amount', { font: 'B', size: 9, align: 'right' }); pdf.text(537, y, 'Balance', { font: 'B', size: 9, align: 'right' });
  y += 22;
  let bal = st.open;
  pdf.text(58, y, fmt.short(st.start), { size: 9 }); pdf.text(140, y, 'Opening balance', { size: 9 }); pdf.text(537, y, money(bal), { size: 9, align: 'right' });
  y += 18;
  for (const [dt, desc, amt] of st.tx) {
    bal = r2(bal + amt);
    pdf.text(58, y, fmt.short(dt), { size: 9 }); pdf.text(140, y, desc, { size: 9 });
    pdf.text(450, y, (amt < 0 ? '-' : '') + money(Math.abs(amt)), { size: 9, align: 'right' }); pdf.text(537, y, money(bal), { size: 9, align: 'right' });
    y += 18;
  }
  pdf.line(50, y - 6, 545, y - 6, { color: '#888888' });
  y += 10;
  pdf.text(50, y, 'Opening balance', { size: 9, color: GREY }); pdf.text(537, y, `${st.ccy} ${money(st.open)}`, { size: 9.5, align: 'right' });
  pdf.text(50, y + 18, 'Closing balance', { font: 'B', size: 10 }); pdf.text(537, y + 18, `${st.ccy} ${money(close)}`, { font: 'B', size: 10, align: 'right' });
  footer(pdf, `${BANK} is authorised by the Prudential Regulation Authority. Synthetic document for testing.`);
  save(st.file, pdf, {
    request: st.req,
    expected: { doc_type: 'bank_statement', entity: ENTITY, date: st.end, amount: close, reference: st.acct },
    planted: st.planted || null,
  });
}

// ---------------------------------------------------------------- Contracts (5)

const contracts = [
  { file: 'MSA Halden Steel signed.pdf', req: 'R07', title: 'MASTER SUPPLY AGREEMENT', cp: 'Halden Steel Ltd', cpAddr: 'Unit 9, Furnace Road, Sheffield S9 2RT', date: '2025-11-03', ref: 'MSA-HS-2025-01', value: 240000.0,
    body: ['The Supplier agrees to supply steel plate and coil to the Customer on the terms set out', 'in Schedule 1 for an initial term of 24 months from the date of this Agreement.', 'Estimated contract value over the initial term is stated below for reference.'],
    signers: ['D. Harrow, Finance Director', 'P. Ashdown, Commercial Director'], signed: [true, true] },
  { file: 'Lease_Unit4_Riverside.pdf', req: 'R08', title: 'LEASE OF UNIT 4, RIVERSIDE PARK', cp: 'Riverside Estates Ltd', cpAddr: '40 Park Row, Leeds LS1 5JL', date: '2024-01-15', ref: 'LSE-RP-0004', value: 1080000.0,
    body: ['The Landlord lets the Premises to the Tenant for a term of ten years at an annual rent', 'of GBP 108,000 payable quarterly in advance, subject to five-yearly upward-only review.', 'Total rent over the term is stated below for reference.'],
    signers: ['D. Harrow, Finance Director', 'G. Whitcombe, Director'], signed: [true, true] },
  { file: 'Corvel distribution agreement.pdf', req: 'R09', title: 'DISTRIBUTION AGREEMENT', cp: 'Corvel Retail plc', cpAddr: '1 Market Street, Nottingham NG1 6HY', date: '2026-02-20', ref: 'DA-CRV-2026', value: null,
    body: ['The Distributor is appointed as non-exclusive distributor of the Products in the', 'Territory. Prices are set by the Price List in force from time to time.', 'No minimum purchase commitment applies.'],
    signers: ['K. Oyelaran, Managing Director', 'S. Brennan, Head of Procurement'], signed: [true, true] },
  { file: 'Tessaly licence agreement.pdf', req: 'R10', title: 'SOFTWARE LICENCE AGREEMENT', cp: 'Tessaly Systems Ltd', cpAddr: 'Floor 6, 22 Quay Street, Manchester M3 3JE', date: '2026-06-01', ref: 'TSL-2026-031', value: 60000.0,
    body: ['The Licensor grants the Licensee a non-transferable licence to use the Software at', 'the Site for a term of three years. Annual licence fees are invoiced in advance.', 'Total licence fees over the term are stated below for reference.'],
    signers: ['D. Harrow, Finance Director', 'R. Malik, Chief Operating Officer'], signed: [true, false],
    planted: { code: 'SIGNATURE', description: 'Contract is missing the Tessaly Systems signature' } },
  { file: 'Brightwater facility letter.pdf', req: 'R11', title: 'TERM LOAN FACILITY AGREEMENT', cp: BANK, cpAddr: '1 Exchange Square, Leeds LS1 4BW', date: '2026-04-30', ref: 'BWB-TLF-55120', value: 1500000.0,
    body: ['The Lender makes available to the Borrower a term loan facility in the amount stated', 'below, repayable in 20 equal quarterly instalments. Interest at SONIA plus 2.75%.', 'Financial covenants are set out in Schedule 3.'],
    signers: ['K. Oyelaran, Managing Director', 'H. Castell, Relationship Director'], signed: [true, true] },
];
for (const c of contracts) {
  const pdf = new PdfDoc({ title: c.title, author: 'Synthetic', created: new Date(`${c.date}T10:00:00Z`) });
  pdf.rect(0, 0, 595.28, 6, { fill: '#333333' });
  pdf.text(297.6 - textWidth(c.title, 15, 'B') / 2, 70, c.title, { font: 'B', size: 15 });
  pdf.text(50, 110, `This Agreement is dated ${fmt.long(c.date)}`, { size: 10 });
  pdf.text(50, 128, `Agreement reference: ${c.ref}`, { size: 10 });
  pdf.text(50, 160, 'BETWEEN', { font: 'B', size: 10 });
  pdf.text(50, 180, `(1)  ${ENTITY.toUpperCase()}, ${ENTITY_ADDR.join(', ')} (company number 08841276); and`, { size: 9.5 });
  pdf.text(50, 198, `(2)  ${c.cp.toUpperCase()}, ${c.cpAddr}.`, { size: 9.5 });
  pdf.text(50, 232, 'TERMS', { font: 'B', size: 10 });
  c.body.forEach((l, i) => pdf.text(50, 252 + i * 15, l, { size: 9.5 }));
  let y = 252 + c.body.length * 15 + 14;
  if (c.value) { pdf.text(50, y, `Contract value: GBP ${money(c.value)}`, { size: 9.5 }); y += 15; }
  pdf.text(50, y + 6, 'This Agreement has been entered into on the date stated at the beginning of it.', { size: 9.5 });
  y += 50;
  y = signature(pdf, y, ENTITY, c.signers[0], c.signed[0], c.date);
  y = signature(pdf, y + 6, c.cp, c.signers[1], c.signed[1], c.date);
  footer(pdf, `${c.ref}  |  Execution version  |  Page 1 of 1`);
  save(c.file, pdf, {
    request: c.req,
    expected: { doc_type: 'contract', entity: ENTITY, date: c.date, amount: c.value, reference: c.ref },
    planted: c.planted || null,
  });
}

// ---------------------------------------------------------------- Confirmations (3)

const confs = [
  { file: 'Brightwater bank confirmation.pdf', req: 'R12', from: BANK, addr: BANK_ADDR.slice(0, 2), re: ENTITY, ref: 'BWB-AC-26-1187', bal: 412906.55, kind: 'bank',
    text: ['In response to your request, we confirm that the balance held for the above customer', 'on Business Current Account 30-91-77 ****4417 was as stated below.'] },
  { file: 'Corvel_confirmation_signed.pdf', req: 'R13', from: 'Corvel Retail plc', addr: ['1 Market Street', 'Nottingham NG1 6HY'], re: ENTITY, ref: 'CRV-AP-0930', bal: 186420.0, kind: 'customer',
    text: ['We confirm that the balance owed by us to the above supplier according to our records', 'was as stated below. No amounts are in dispute.'] },
  { file: 'halden conf.pdf', req: 'R14', from: 'Halden Steel Ltd', addr: ['Unit 9, Furnace Road', 'Sheffield S9 2RT'], re: 'Northwind Logistics Ltd', ref: 'HS-CONF-0930', bal: 39565.2, kind: 'supplier',
    text: ['We confirm that the balance owed to us by the above customer according to our ledger', 'was as stated below, comprising invoices dated July to September 2026.'],
    planted: { code: 'WRONG_ENTITY', description: 'Confirmation is for Northwind Logistics Ltd, not the audited entity' } },
];
for (const c of confs) {
  const pdf = new PdfDoc({ title: 'Balance confirmation', author: c.from, created: new Date('2026-10-14T11:00:00Z') });
  let y = letterhead(pdf, c.from, c.addr, '#34495e');
  pdf.text(50, y, 'The Engagement Partner', { size: 9.5 });
  pdf.text(50, y + 13, 'Audit and Assurance, Forvis Mazars LLP (synthetic test address)', { size: 9.5 });
  pdf.text(545, y, fmt.long('2026-10-14'), { size: 9.5, align: 'right' });
  y += 48;
  pdf.text(50, y, c.kind === 'bank' ? 'BANK CONFIRMATION' : 'BALANCE CONFIRMATION', { font: 'B', size: 12 });
  y += 24;
  kv(pdf, 50, y, 'Re:', c.re, 90);
  kv(pdf, 50, y + 16, 'Our reference:', c.ref, 90);
  kv(pdf, 50, y + 32, 'As at:', fmt.long('2026-09-30'), 90);
  y += 64;
  c.text.forEach((l, i) => pdf.text(50, y + i * 15, l, { size: 10 }));
  y += c.text.length * 15 + 20;
  pdf.rect(50, y - 14, 495, 26, { fill: '#f3f3f3' });
  pdf.text(60, y + 2, 'Confirmed balance', { font: 'B', size: 10 });
  pdf.text(535, y + 2, `GBP ${money(c.bal)}`, { font: 'B', size: 10, align: 'right' });
  y += 50;
  signature(pdf, y, c.from, c.kind === 'bank' ? 'L. Fenwick, Audit Confirmations Team' : c.kind === 'customer' ? 'S. Brennan, Head of Procurement' : 'M. Okoro, Credit Controller', true, '2026-10-14');
  footer(pdf, 'Reply sent directly to the auditor. Synthetic document for testing.');
  save(c.file, pdf, {
    request: c.req,
    expected: { doc_type: 'confirmation', entity: c.re, date: '2026-09-30', amount: c.bal, reference: c.ref },
    planted: c.planted || null,
  });
}

// ---------------------------------------------------------------- Board minutes (3)

const minutes = [
  { file: 'Board minutes 22 Apr 2026.pdf', date: '2026-04-22', ref: 'BR-2026-04', item: 'RESOLVED that the Company enter into the term loan facility of GBP 1,500,000 with Brightwater Bank plc', item2: 'on the terms presented, and that any one director be authorised to sign it on behalf of the Company.' },
  { file: 'Minutes_2026-06-10.pdf', date: '2026-06-10', ref: 'BR-2026-06', item: 'RESOLVED that the Company enter into the three-year software licence with Tessaly Systems Ltd', item2: 'at a total cost of GBP 60,000, and that the Finance Director be authorised to sign it.' },
];
for (const m of minutes) {
  const pdf = new PdfDoc({ title: 'Board minutes', author: ENTITY, created: new Date(`${m.date}T17:00:00Z`) });
  pdf.rect(0, 0, 595.28, 6, { fill: NAVY });
  pdf.text(50, 60, ENTITY.toUpperCase(), { font: 'B', size: 13 });
  pdf.text(50, 76, 'Company number 08841276', { size: 9, color: GREY });
  pdf.text(50, 110, 'MINUTES OF A MEETING OF THE BOARD OF DIRECTORS', { font: 'B', size: 11 });
  kv(pdf, 50, 134, 'Date of meeting', fmt.long(m.date));
  kv(pdf, 50, 150, 'Place', 'Registered office, Unit 4, Riverside Park, Leeds');
  kv(pdf, 50, 166, 'Present', 'K. Oyelaran (Chair), D. Harrow, R. Malik');
  kv(pdf, 50, 182, 'Resolution reference', m.ref);
  pdf.text(50, 216, '1.  Quorum and declarations', { font: 'B', size: 10 });
  pdf.text(66, 232, 'A quorum being present, the Chair opened the meeting. No conflicts were declared.', { size: 9.5 });
  pdf.text(50, 258, '2.  Approval', { font: 'B', size: 10 });
  pdf.text(66, 274, m.item, { size: 9.5 });
  pdf.text(66, 288, m.item2, { size: 9.5 });
  pdf.text(50, 314, '3.  Close', { font: 'B', size: 10 });
  pdf.text(66, 330, 'There being no further business the meeting closed.', { size: 9.5 });
  pdf.text(50, 380, 'Chair:', { size: 9, color: GREY });
  pdf.text(96, 378, 'K. Oyelaran', { font: 'I', size: 14, color: '#1b2a6b' });
  pdf.line(94, 384, 280, 384, { color: '#777777' });
  footer(pdf, `${ENTITY}  |  Board minutes  |  ${m.ref}`);
  save(m.file, pdf, {
    request: 'R15',
    expected: { doc_type: 'board_minutes', entity: ENTITY, date: m.date, amount: null, reference: m.ref },
    planted: null,
  });
}
// Third minutes: a poor typed copy with no field labels. Built to test the
// confidence threshold, not a planted error.
{
  const pdf = new PdfDoc({ title: 'IMG_7731', author: 'Phone scan', created: new Date('2026-10-02T08:12:00Z') });
  const lines = [
    'northwind components ltd',
    'minutes of mtg of the directors held at the registered office',
    'on the twenty-fourth day of september two thousand and twenty six',
    '',
    'present - k oyelaran (chair), d harrow, r malik',
    'it was resolved that the cos fy2026 year-end close timetable and the interim',
    'dividend recommendation be approved as tabled  (ref br 2026/09)',
    '',
    'no other business',
  ];
  lines.forEach((l, i) => { if (l) pdf.text(62 + (i % 2), 90 + i * 19, l, { font: 'M', size: 10.5, color: '#2e2e2e' }); });
  pdf.text(62, 290, 'k oyelaran', { font: 'I', size: 13, color: '#3a3a3a' });
  save('IMG_7731.pdf', pdf, {
    request: 'R15',
    expected: { doc_type: 'board_minutes', entity: ENTITY, date: '2026-09-24', amount: null, reference: 'BR-2026-09' },
    planted: null,
    note: 'Low-quality copy without field labels; expected to fall below the confidence threshold.',
  });
}

// ---------------------------------------------------------------- Write scenario + answer sheet

const scenario = {
  version: 'synthetic-v1',
  generatedAt: new Date().toISOString(),
  engagement: { id: 'ENG-2026-NWC', client: ENTITY, entity: ENTITY, companyNumber: '08841276', yearEnd: FY.end, fy: FY, currency: 'GBP' },
  tolerance: { amountAbs: 0.5, amountPct: 0 },
  requests,
  ledger,
  trialBalance,
  apBalances: [{ counterparty: 'Halden Steel Ltd', tbAccount: 'TB-2100' }],
};
fs.writeFileSync(path.join(OUT, 'scenario.json'), JSON.stringify(scenario, null, 2));
fs.writeFileSync(path.join(OUT, 'answer-sheet.json'), JSON.stringify({ version: scenario.version, fields: ['doc_type', 'entity', 'date', 'amount', 'reference'], documents: answers }, null, 2));

const csv = ['file,request,doc_type,entity,date,amount,reference,planted_error,sha256'];
for (const a of answers) {
  const e = a.expected;
  csv.push([a.file, a.request, e.doc_type, e.entity, e.date, e.amount ?? '', e.reference, a.planted?.code || '', a.sha256].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
}
fs.writeFileSync(path.join(OUT, 'answer-sheet.csv'), csv.join('\n') + '\n');

console.log(`Generated ${files.length} documents in dataset/documents`);
console.log(`Planted errors: ${answers.filter((a) => a.planted).map((a) => `${a.planted.code} (${a.file})`).join(', ')}`);
