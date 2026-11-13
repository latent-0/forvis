// POST /api/extract — the only server-side step. Reads one document and returns fields
// with confidence. Holds the reader key; keeps no state.
import { extractDocument } from '../lib/extract.js';

const MIME_OK = /^(application\/pdf|image\/(png|jpeg|webp|gif))$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { fileName, mime, data, images, final } = body;
    if (!MIME_OK.test(String(mime || ''))) return res.status(400).json({ error: 'Upload PDF or image files.' });
    if (!data && !images?.length) return res.status(400).json({ error: 'No file content received.' });
    if (images && (!Array.isArray(images) || images.some((u) => !/^data:image\/(png|jpeg|webp);base64,/.test(String(u))))) {
      return res.status(400).json({ error: 'Invalid page images.' });
    }
    const out = await extractDocument({ fileName: String(fileName || 'document'), mime, data, images, allowFallback: !!final });
    res.setHeader('Cache-Control', 'no-store');
    if (out.retryAfter) { res.setHeader('Retry-After', String(out.retryAfter)); return res.status(429).json({ error: 'Busy', retryAfter: out.retryAfter }); }
    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Extraction failed' });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };
