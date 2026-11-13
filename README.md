# Evidence Intake POC

AI reads and drafts, a rule checks, a named professional approves, and every step is logged.

A client uploads 25 documents against a 15-item request list. Each document gets a case ID and its original is stored untouched with a SHA-256 hash. Fields are extracted, each document is matched to a request item or ledger line, coded rules raise flags, and everything waits in a queue for a named reviewer to approve, edit or reject. A manager signs off. Every step goes into an append-only, hash-chained audit log.

## Run locally

Requires Node 20.12 or later.

```bash
cp .env.example .env      # then fill in the reader settings
npm start                 # http://localhost:4317
```

`npm run check` reads the whole synthetic batch from the command line and prints the three success measures. `npm run generate` rebuilds the synthetic dataset and answer sheet in `public/dataset/`.

## Deploy to Vercel

1. Import the folder as a Vercel project (or run `vercel` in it). No build step; `vercel.json` serves `public/` and deploys `api/extract.js` as a function.
2. In Project Settings → Environment Variables, add the five `EXTRACTION_*` variables from `.env.example` for Production and Preview.
3. Deploy (`vercel --prod`). The project is linked to GitHub, so every push to `main` deploys to production and other branches get preview deployments.

The key stays on the server. The browser never sees it.

## How it is built

| Piece | Where |
|---|---|
| Upload and intake: case IDs, untouched originals, SHA-256 | `public/engine.js` `ingest` |
| Extraction with per-field confidence, fixed field schema | `api/extract.js`, `lib/extract.js`, `lib/model-reader.js` |
| Source check: every extracted value must appear in the document, or confidence drops | `lib/model-reader.js` `applyGrounding` |
| Matching to request list and ledger | `public/shared/rules.js` `matchDocument` |
| Rule checks (the rules decide the flag) | `public/shared/rules.js` `runRules` |
| Reviewer screen: approve, edit, reject, sign-off | `public/app.js` `renderDoc` |
| Audit trail, hash-chained | `public/engine.js` `audit`, `verifyChain` |
| Use case register | Register page |
| Results table | `public/shared/metrics.js`, Results page, CSV export |

`/api/extract` is the only server step and keeps no state. Cases, originals, decisions and the audit log are held in the browser's IndexedDB, so each browser profile has its own workspace; *Reset demo data* clears it. Moving that store to a shared database is the step from POC to pilot.

If the reader is unavailable, extraction falls back to labelled-field rules and the fallback is written to the audit log.

## Roles

Switch in the sidebar.

- **J. Okafor, client uploader**: uploads only.
- **A. Lindqvist, audit associate (reviewer)**: approves, edits or rejects. Approving a document with open flags requires a note.
- **M. Reyes, audit manager (approver)**: signs off approved documents, edits the register and settings.

## Five-minute demo

1. Intake, as the client: tick *Pace each step*, then *Load synthetic batch*. The intake log fills and the workflow strip counts up.
2. Review queue, as the reviewer: open a clean invoice (`INV_HS-40917.pdf`). Fields, match to R01 and its ledger line, no flags. Approve.
3. Open `BVF-3093.pdf`: `AMOUNT_TOLERANCE`, expected GBP 14,780.00 against found GBP 14,870.00.
4. Open `Tessaly licence agreement.pdf`: `SIGNATURE`, held until the reviewer decides.
5. Open `IMG_7731.pdf`: low-confidence warning; the meeting date is not written as a date anywhere in the document.
6. On `BVF-3093.pdf`, approve with an exception note, switch to the approver and sign off. *Open in audit trail* shows upload, extraction, flag, approval and sign-off with names and times.
7. Register page.
8. Results page. Record the timed run with pacing off.

## Planted errors

| File | Error | Rule |
|---|---|---|
| `BVF-3093.pdf` | Invoice amount differs from the ledger line | `AMOUNT_TOLERANCE` |
| `USD_9930_statement.pdf` | Statement covers August, request is for September | `PERIOD` |
| `Tessaly licence agreement.pdf` | Counterparty signature missing | `SIGNATURE` |
| `scan_0042.pdf` | Duplicate of `KF-88310.pdf` under another name | `DUPLICATE` |
| `halden conf.pdf` | Confirmation is for Northwind Logistics Ltd | `WRONG_ENTITY` |

## Not included

Real client data, SSO and full permissions, integration with Forvis Mazars systems or a real ledger, any position on audit independence, production security review. The wordmark in the sidebar is set in type; use the official supplied logo artwork for anything beyond the POC.
