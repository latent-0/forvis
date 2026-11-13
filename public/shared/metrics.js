// The three success measures, scored against the answer sheet written before the build.
import { norm, normRef } from './rules.js';

export const SCORED_FIELDS = ['doc_type', 'entity', 'date', 'amount', 'reference'];

function same(field, got, want) {
  if (want == null) return got == null;
  if (got == null) return false;
  if (field === 'amount') return Math.abs(Number(got) - Number(want)) < 0.005;
  if (field === 'reference') return normRef(got) === normRef(want);
  if (field === 'entity') return norm(got) === norm(want);
  return String(got) === String(want);
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function computeResults(docs, answerSheet, { manualMinutes = 6, threshold = 0.8 } = {}) {
  const bySha = new Map(answerSheet.documents.map((a) => [a.sha256, a]));
  const scored = docs.filter((d) => d.extraction && bySha.has(d.sha256));

  // 1. Extraction accuracy: the model's original output, before any human edit.
  const perField = Object.fromEntries(SCORED_FIELDS.map((f) => [f, { correct: 0, total: 0 }]));
  const misses = [];
  for (const d of scored) {
    const a = bySha.get(d.sha256);
    for (const f of SCORED_FIELDS) {
      perField[f].total++;
      const got = d.extraction.fields[f];
      if (same(f, got, a.expected[f])) perField[f].correct++;
      else misses.push({ id: d.id, file: d.file_name, field: f, expected: a.expected[f], extracted: got });
    }
  }
  const totalFields = SCORED_FIELDS.reduce((s, f) => s + perField[f].total, 0);
  const correctFields = SCORED_FIELDS.reduce((s, f) => s + perField[f].correct, 0);

  // 2. Planted errors caught: the rule flags raised before any human acted.
  const planted = answerSheet.documents.filter((a) => a.planted).map((a) => {
    const d = scored.find((x) => x.sha256 === a.sha256);
    const raised = d?.extraction?.initialFlags || [];
    return { file: a.file, code: a.planted.code, description: a.planted.description, id: d?.id || null, received: !!d, caught: raised.includes(a.planted.code), raised };
  });
  const plantedShas = new Set(answerSheet.documents.filter((a) => a.planted).map((a) => a.sha256));
  const flagSeverity = (code) => (code === 'LOW_CONFIDENCE' ? 'warning' : 'flag');
  const falsePositives = scored
    .filter((d) => !plantedShas.has(d.sha256))
    .flatMap((d) => (d.extraction.initialFlags || []).filter((c) => flagSeverity(c) === 'flag').map((code) => ({ id: d.id, file: d.file_name, code })));
  const lowConfidence = scored.filter((d) => (d.extraction.initialFlags || []).includes('LOW_CONFIDENCE')).map((d) => ({ id: d.id, file: d.file_name, overall: d.extraction.confidence.overall }));

  // Matching accuracy (supporting measure)
  let matchCorrect = 0;
  for (const d of scored) if (d.extraction.initialMatch?.requestId === bySha.get(d.sha256).request) matchCorrect++;

  // 3. Time per document: upload received -> reviewer queue, excluding optional demo pacing.
  const times = docs.filter((d) => d.queued_at).map((d) => (Date.parse(d.queued_at) - Date.parse(d.received_at) - (d.paced_ms || 0)) / 1000);
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;

  const engines = [...new Set(scored.map((d) => d.extraction.engine))];
  return {
    documentsScored: scored.length,
    documentsExpected: answerSheet.documents.length,
    engines,
    threshold,
    accuracy: {
      target: 0.9,
      value: totalFields ? correctFields / totalFields : null,
      correct: correctFields,
      total: totalFields,
      perField: SCORED_FIELDS.map((f) => ({ field: f, ...perField[f], rate: perField[f].total ? perField[f].correct / perField[f].total : null })),
      misses,
    },
    planted: {
      target: 5,
      caught: planted.filter((p) => p.caught).length,
      total: planted.length,
      items: planted,
      falsePositives,
      lowConfidence,
    },
    matching: { correct: matchCorrect, total: scored.length },
    time: {
      targetSeconds: 30,
      avgSeconds: avg,
      medianSeconds: median(times),
      maxSeconds: times.length ? Math.max(...times) : null,
      documents: times.length,
      manualMinutes,
      manualHours: (times.length * manualMinutes) / 60,
    },
  };
}
