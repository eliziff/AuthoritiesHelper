# Third-party notices and source provenance

This Authorities integration is MIT-licensed, Copyright (c) 2026 Elias Ziff; the MIT license text ships as `LICENSE` in every ready-built package. Corresponding integration source: https://github.com/eliziff/AuthoritiesHelper/tree/main/modern/authorities-lite . Retain these notices when redistributing.

## Reused components

- **Beaver**, eliziff/Beaver, revision `8512b629e01b5f596360ffde33feb56eb3126ba9`: the reused files are the author's (Elias Ziff's) own code and are included here under MIT. The pinned files supply PDF annotation and page-binding/navigation logic, CanLII URLs, A2AJ metadata and the provider PDF bridge. The publisher helper has separate source provenance below.
- **Legal Browser OCR**, eliziff/legal-browser-ocr, source revision `83122a28fc4901ea275a4aa165340917f9c2b85c`: MIT source; runtime/model components retain their own licenses. Its quality inference worker, preprocessing, layout, line ordering and searchable PDF export are reused, not reimplemented. The v0.1.4 runtime archive is checksum-verified by `prepare.mjs`.
- **Legal Structure Parser**: MIT. The Rust parser runs behind the browser ABI; its exact revision is recorded in `SOURCES.json`.
- **Common Law Cite**: the shared Rust citation engine. Its exact revision is recorded in `SOURCES.json`, and its own `NOTICE` is included in the package.
- **Legal Pinpointer**: MIT. Its reporter-alias data and notices are retained; the exact revision is recorded in `SOURCES.json`.
- **PDF.js**, Mozilla/pdf.js, bundled `pdfjs-dist` 4.10.38: Apache-2.0. https://github.com/mozilla/pdf.js/blob/master/LICENSE
- **pdf-lib**, Andrew Dillon and contributors, 1.17.1: MIT. https://github.com/Hopding/pdf-lib/blob/master/LICENSE.md
- **ONNX Runtime**, Microsoft Corporation and contributors, 1.22.0 and the supplied compact runtime build: MIT; third-party notices apply. https://github.com/microsoft/onnxruntime/blob/main/LICENSE ; https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt
- **Tesseract layout engine**: Apache-2.0; its supplied WASM layout binary is reused from the pinned Legal Browser OCR v0.1.4 runtime. https://github.com/tesseract-ocr/tesseract/blob/main/LICENSE
- **Kraken / CATMuS recognition lineage**: the legal-domain model bytes are reused unchanged from the user's published Legal Browser OCR v0.1.4 runtime. The source repository attributes CATMuS/Simon Gabay/Thibault Clerice and https://zenodo.org/records/10602357 . That record is titled CATMuS-Print [Tiny]; the original repository's Small wording is not new model provenance. Model assets are not relicensed by this integration; preserve their upstream notices/terms. This package does not assert that all third-party weights are MIT.

The archive includes `SOURCES.json` with exact source revisions and SHA-256 hashes of embedded inputs. Source judgments retain their publisher terms; A2AJ's `upstream_license` is retained where supplied. No legal text or source PDFs are relicensed here.

The publisher helper (`publisher.mjs`) and the folder matcher (`folder.mjs`) are
generated separately from Beaver's `backend/src/lib/legalSourcePresentation.ts` and
`shared/folder-pdf-match.mjs` and their imports by `sync-publisher.mjs`, under the
same MIT permission. Each generated header records the combined source SHA-256; they
are not adaptations of the older pinned snapshot.

## MIT permission notice

Copyright remains with the respective authors named by each upstream component.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
