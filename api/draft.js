// POST /api/draft — drafts a client follow-up letter from open items. Keeps no state.
import { draftRequest } from '../lib/drafter.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
    if (!items.length || !body.client?.name || !body.from?.name || !body.engagement?.client) return res.status(400).json({ error: 'Nothing to draft.' });
    const clean = (v) => (v == null ? null : String(v).slice(0, 400));
    const input = {
      client: { name: clean(body.client.name), title: clean(body.client.title) },
      from: { name: clean(body.from.name), title: clean(body.from.title) },
      engagement: { client: clean(body.engagement.client), yearEnd: clean(body.engagement.yearEnd), id: clean(body.engagement.id) },
      items: items.map((x) => ({ kind: clean(x.kind), fact: clean(x.fact), ask: clean(x.ask) })).filter((x) => x.fact && x.ask),
    };
    let out = await draftRequest(input);
    if (out.retryAfter) {
      await new Promise((r) => setTimeout(r, Math.min(8, out.retryAfter) * 1000));
      out = await draftRequest(input);
      if (out.retryAfter) out = { ...(await import('../lib/drafter.js')).templateDraft(input), drafted: 'template' };
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Drafting failed' });
  }
}
