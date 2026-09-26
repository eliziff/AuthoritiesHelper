# Authorities-lite — local HTML + publisher PDF Worker

Paste citation/pinpoint instructions, acquire original PDFs, locate passages, review highlights, and export editable annotated PDFs. This prototype does not change Beaver Authorities or the original OCR application.

## Open the application

Download `Authorities-lite.html` from the latest `authorities-lite-v*` GitHub release (its only file; the Release workflow builds and publishes it from an `authorities-lite-v*` tag or a manual run). Authorities-lite is distinct from the full Authorities app, released as `Authorities.html` under `authorities-v*`, and open it in current desktop Chrome or Edge. The parser, quality OCR model, PDF.js workers/viewer and PDF writer are embedded. Uploaded-PDF processing needs no installation, account, local server or runtime download.

Paste instructions. **Find PDFs & highlight** resolves through A2AJ and retrieves original publisher PDFs through the configured Worker. CanLII is never automatically fetched: its direct PDF links and batch/per-row upload are the fallback. Filename hints are checked against opening document citations, including official English/French neutral-citation equivalents.

Review provides pinpoint navigation, text-selection and area highlighting, colour/opacity, delete, undo/redo. Scans use measured line geometry rather than invented word boxes. Export writes unlocked `/Highlight` annotations with `/QuadPoints` and printable appearances, not flattened page rectangles. **Download all** includes acquired, checked records; unresolved sources are not fabricated.

**Auto-fetch from folder** adds the PDFs you download from the rows' **CanLII PDF** links. Click it once and choose the folder your browser saves to: in Chrome and Edge the app then keeps watching that folder while the tab is open, checking every two seconds and binding each new PDF to its authority as it lands. The button reads **Watching <folder> · Stop** while active; click it to stop. Only top-level PDFs whose names follow CanLII's convention of year, court and number (`2019abqb666.pdf`, `2019abqb666 (1).pdf`) are taken; nothing else in the folder is read. Firefox and Safari have no folder-watching API, so there the button does a one-time folder upload. Chrome and Edge refuse to share the Downloads, Desktop and Documents folders themselves (and the home folder), so point the browser's download location at a subfolder such as `Downloads\Authorities` and pick that. To print three copies, open the exported PDFs in Acrobat, select **Document and Markups**, and set three copies in the print dialog.

## Cloudflare setup

The package's `worker.mjs` is already a single bundled ES module: no npm imports, database, storage, OCR service or model binding is needed.

1. Create your Cloudflare account and stay on **Workers Free**.
2. Under **Workers & Pages**, create a basic Worker/template, deploy it, then open **Edit Code**.
3. Replace the starter script with the complete bundled `worker.mjs` and deploy. The package pins the tested compatibility date `2026-06-24`; set that date under Worker Settings for an identical runtime contract.
4. The current prototype is pinned to `https://quiet-wildflower-ab0d.eliziffprofessional.workers.dev/`. If this deployment is replaced, update `DEFAULT_SERVICE_URL` in `authorities/client.mjs` and rebuild. End users configure nothing.

There is deliberately no application secret. The endpoint is public but narrowly constrained to approved public legal-publisher hosts and paths; a shared secret distributed to browser clients would not be secret. Do not put Cloudflare account credentials or API tokens in the HTML. No account is created, paid plan enabled, or public deployment performed by the repository build.

Alternatively, from the ready-built package directory on the administrator's computer:

```sh
npx wrangler login
npx wrangler deploy
```

End users run no CLI or local server. For Cloudflare Git integration, choose `codex/authorities-html-worker`, build command `npm ci && node authorities/prepare.mjs && node authorities/build-worker.mjs`, and deploy command `npx wrangler deploy --config dist/authorities/wrangler.jsonc`. The Worker-only build does not need Rust and does not host the HTML.

Current official setup: https://developers.cloudflare.com/workers/get-started/dashboard/ .

### Cost and limits

Workers Free currently permits 100,000 requests/day and 10 ms CPU/request. Network waiting is distinct from CPU. This implementation uses no R2, KV, database or Workers AI. Deployed Free-plan CPU use has not been measured; verify it before promising a zero-cost production service. No paid account changes are automated.

Official pricing and limits: https://developers.cloudflare.com/workers/platform/pricing/ ; https://developers.cloudflare.com/workers/platform/limits/ .

## Retrieval and privacy boundary

The Worker accepts only approved A2AJ publisher hosts and decision/PDF paths over HTTPS. Every redirect is checked before following, stays on the publisher's origin, and carries no client authorization/cookies upstream. Publisher-owned controls identify the original PDF; the response must have an accepted media type and `%PDF-` signature. Source HTML is limited to 2 MB, PDFs to 100 MiB, redirects to five and duration to 60 seconds. PDF bytes stream through the Worker rather than being buffered in full.

Endpoints: `GET /health`, `GET /pdf?source=<publisher URL>`, and OPTIONS. Every response, including unexpected failures, carries the CORS headers so the app shows the real error instead of "Failed to fetch". Default CORS origins are `null` for local files, `https://eliziff.github.io`, and the service's own origin. Set `ALLOWED_ORIGINS` to add a different hosted app. CORS is not authentication. The endpoint is intentionally public; an optional Cloudflare `RATE_LIMITER` binding is supported but not provisioned.

Only citations are sent to A2AJ; only public publisher URLs are sent to the Worker. It sees the request IP and public source PDF. Your pasted instructions, uploaded PDFs, OCR and annotations are not uploaded. The code writes no application storage/logs, returns `Cache-Control: no-store`, and disables configured Workers observability. That does not assert that infrastructure providers retain no operational records.

## Scope and verification

The citation/structure core is the actual shared Rust engine. PDF extraction is PDF.js plus a measured-geometry adapter, not complete native legal-pdf-parser parity. OCR uses the existing quality model/inference, layout and searchable-PDF code. No LLM is required.

Ambiguous paragraphs/items remain visible findings. Reporter-page pinpoints currently require review instead of silently becoming physical PDF pages. Poor scans, complex columns, encrypted PDFs or unreadable first-page identities may require a different source or manual adjustment. Per-file limits do not guarantee that an arbitrarily large batch fits device memory.

Independent PDF annotation editing is not manual Acrobat certification.

The integration is **MIT**-licensed, Copyright (c) 2026 Elias Ziff. The Beaver code it reuses was written by the same author and is included under the same MIT terms. The ready-built package contains the MIT license and `THIRD_PARTY_NOTICES.md`; components/models retain their own notices and licenses. Corresponding source: https://github.com/eliziff/AuthoritiesHelper/tree/main/modern/authorities-lite .
