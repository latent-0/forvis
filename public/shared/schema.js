// The fixed field schema shared by the extraction function and the workflow.
export const DOC_TYPES = ['invoice', 'bank_statement', 'contract', 'confirmation', 'board_minutes', 'other'];
export const FIELD_KEYS = ['doc_type', 'entity', 'counterparty', 'date', 'amount', 'currency', 'reference', 'period_start', 'period_end', 'signatures'];
export const REQUIRED = {
  invoice: ['doc_type', 'entity', 'counterparty', 'date', 'amount', 'reference'],
  bank_statement: ['doc_type', 'entity', 'date', 'amount', 'reference', 'period_start', 'period_end'],
  contract: ['doc_type', 'entity', 'counterparty', 'date', 'reference', 'signatures'],
  confirmation: ['doc_type', 'entity', 'counterparty', 'date', 'amount', 'reference'],
  board_minutes: ['doc_type', 'entity', 'date', 'reference'],
  other: ['doc_type'],
};

export function overallConfidence(fields, confidence) {
  const req = REQUIRED[fields.doc_type] || REQUIRED.other;
  const vals = req.map((k) => (fields[k] == null ? 0 : confidence[k] ?? 0));
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const missing = req.filter((k) => fields[k] == null);
  return Math.round((missing.length ? Math.min(avg, 0.5) : avg) * 100) / 100;
}
