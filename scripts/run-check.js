// Headless run of the batch: extraction (same function the app calls), matching, rules,
// then the three success measures against the answer sheet. Reads .env for the reader key.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* none */ }
const { extractDocument } = await import('../lib/extract.js');
const { matchDocument, runRules } = await import('../public/shared/rules.js');
const { computeResults } = await import('../public/shared/metrics.js');

const DS = path.join(ROOT, 'public', 'dataset');
const scenario = JSON.parse(fs.readFileSync(path.join(DS, 'scenario.json'), 'utf8'));
const answers = JSON.parse(fs.readFileSync(path.join(DS, 'answer-sheet.json'), 'utf8'));
const names = answers.documents.map((a) => a.file).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

const docs = [];
const pending = names.map((name, i) => ({ name, i }));
async function worker() {
  while (pending.length) {
    const { name, i } = pending.shift();
    const buf = fs.readFileSync(path.join(DS, 'documents', name));
    const received = Date.now();
    let ex, tries = 0;
    for (;;) {
      ex = await extractDocument({ fileName: name, mime: 'application/pdf', data: buf.toString('base64'), allowFallback: tries >= 6 });
      if (!ex.retryAfter) break;
      tries++;
      await new Promise((r) => setTimeout(r, ex.retryAfter * 1000));
    }
    const id = `EV-2026-${String(i + 1).padStart(4, '0')}`;
    docs[i] = { id, file_name: name, sha256: crypto.createHash('sha256').update(buf).digest('hex'), fields: ex.fields, confidence: { ...ex.confidence, overall: ex.overall }, overall: ex.overall, engine: ex.engine, notes: ex.notes, fallbackReason: ex.fallbackReason, received_at: new Date(received).toISOString(), queued_at: new Date().toISOString(), paced_ms: 0 };
  }
}
await Promise.all([worker(), worker(), worker()]);

for (const d of docs) {
  d.match = matchDocument(d.fields, scenario);
  const others = docs.filter((o) => o !== d);
  d.flags = runRules({ id: d.id, sha256: d.sha256, fields: d.fields, confidence: d.confidence, match: d.match }, scenario, { others, threshold: 0.8 });
  d.extraction = { engine: d.engine, fields: d.fields, confidence: d.confidence, initialMatch: d.match, initialFlags: d.flags.map((f) => f.code) };
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
console.log('Case           File                                 Type            Match  Conf  Reader  Flags');
for (const d of docs) console.log(`${pad(d.id, 14)} ${pad(d.file_name, 36)} ${pad(d.fields.doc_type, 15)} ${pad(d.match.requestId || '-', 6)} ${pad(Math.round(d.overall * 100) + '%', 5)} ${pad(d.engine, 7)} ${d.flags.map((f) => f.code).join(', ')}${d.fallbackReason ? `  [fallback: ${d.fallbackReason}]` : ''}`);
const r = computeResults(docs, answers, {});
const pct = (v) => `${(v * 100).toFixed(1)}%`;
console.log(`\nExtraction accuracy     ${pct(r.accuracy.value)} (${r.accuracy.correct}/${r.accuracy.total})  ${r.accuracy.value >= 0.9 ? 'MET' : 'NOT MET'}`);
console.log(`Planted errors caught   ${r.planted.caught} of ${r.planted.total}  ${r.planted.caught === 5 ? 'MET' : 'NOT MET'}`);
console.log(`Time per document       avg ${r.time.avgSeconds.toFixed(2)} s, max ${r.time.maxSeconds.toFixed(2)} s (3 in parallel, includes waits for the reader)  ${r.time.maxSeconds < 30 ? 'MET' : 'NOT MET'}`);
console.log(`Request matching        ${r.matching.correct} of ${r.matching.total}`);
console.log(`False positive flags    ${r.planted.falsePositives.length}${r.planted.falsePositives.length ? ': ' + r.planted.falsePositives.map((f) => `${f.code} on ${f.file}`).join('; ') : ''}`);
console.log(`Low confidence routed   ${r.planted.lowConfidence.map((l) => `${l.file} (${Math.round(l.overall * 100)}%)`).join(', ') || 'none'}`);
for (const m of r.accuracy.misses) console.log(`  miss ${m.file}  ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.extracted)}`);
for (const d of docs) if (d.notes?.length) console.log(`  note ${d.file_name}: ${d.notes.join(' | ')}`);
