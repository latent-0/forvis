// Drafts a client follow-up letter from open queries. The model drafts; the reviewer
// edits and decides whether to send. Facts come only from the items passed in.
import { chatJson, modelAvailable, RateLimited } from './model-reader.js';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
};

const INSTRUCTIONS = `You draft a short, courteous evidence request from an audit team to a client's finance manager.
Each item has a "fact" and an "ask". Copy every fact and every ask word for word; do not change, reorder or add to them.
Your job is only the framing: a greeting, one opening sentence, a numbered list with one point per item in the order given ("fact" followed by "ask"), one closing sentence asking for a reply without naming a date, and the sign-off with the sender's name and title.
Subject: "<client>: evidence follow-up for the year ended <year end>".
Plain British English. No marketing language, no exclamation marks.`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const subjectFor = (e) => `${e.client}: evidence follow-up for the year ended ${longDate(e.yearEnd)}`;

export function templateDraft({ client, from, engagement, items }) {
  const lines = items.map((x, i) => `${i + 1}. ${x.fact} ${x.ask}`);
  return {
    subject: subjectFor(engagement),
    body: `Dear ${client.name},

Thank you for the documents. A few items need your help before we can complete our review:

${lines.join('\n')}

Could you reply with the documents or explanations when you can?

Kind regards,
${from.name}
${from.title}`,
  };
}

// Every fact and ask must survive verbatim, and the draft may not introduce new numbers.
const squash = (t) => String(t).replace(/\s+/g, ' ').trim();
function faithful(body, items, context = '') {
  const b = squash(body);
  if (!items.every((x) => b.includes(squash(x.fact)) && b.includes(squash(x.ask)))) return false;
  const nums = (t) => (String(t).match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[.,]+$/, ''));
  const allowed = new Set([...items.flatMap((x) => nums(`${x.fact} ${x.ask}`)), ...nums(context)]);
  return nums(b).every((n) => allowed.has(n) || /^\d{1,2}$/.test(n));
}

export async function draftRequest(input) {
  if (modelAvailable()) {
    try {
      const out = await chatJson([
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: JSON.stringify({ to: input.client, from: input.from, client: input.engagement.client, yearEnd: longDate(input.engagement.yearEnd), items: input.items.map(({ fact, ask }) => ({ fact, ask })) }) },
      ], SCHEMA, 'client_request');
      if (out?.body && faithful(out.body, input.items, `${longDate(input.engagement.yearEnd)} ${input.engagement.yearEnd}`)) return { subject: subjectFor(input.engagement), body: out.body.trim(), drafted: 'ai' };
    } catch (e) {
      if (e instanceof RateLimited) return { retryAfter: e.retryAfter };
    }
  }
  return { ...templateDraft(input), drafted: 'template' };
}
