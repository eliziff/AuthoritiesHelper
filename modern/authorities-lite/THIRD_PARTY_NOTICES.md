# Third-party notices and source provenance

This Authorities integration is MIT-licensed, Copyright (c) 2026 Elias Ziff; the MIT license text ships as `LICENSE` in every ready-built package. Corresponding integration source: https://github.com/eliziff/AuthoritiesHelper/tree/main/modern/authorities-lite . Retain these notices when redistributing.

## Reused components

- **Beaver**, eliziff/Beaver: the reused files are the author's (Elias Ziff's) own code, included under MIT. The owning checkout supplies PDF annotations, page binding/navigation, publisher rules and folder matching; actual bundled source hashes are recorded in `SOURCES.json`.
- **Legal Browser OCR**, eliziff/legal-browser-ocr, owning source checkout: MIT source; runtime/model components retain their own licenses. Its quality inference worker, preprocessing, layout, line ordering and searchable PDF export are reused, not reimplemented. The v0.1.4 runtime archive is checksum-verified by the shared OCR asset preparer.
- **Legal Structure Parser**: MIT. The Rust parser runs behind the browser ABI; its compiled artifact hash is recorded in `SOURCES.json`.
- **Common Law Cite**: the shared Rust citation engine. Its compiled artifact hash is recorded in `SOURCES.json`, and its own `NOTICE` is included in the package.
- **Legal Pinpointer**: MIT. Its reporter-alias data and notices are retained; the exact data hash is recorded in `SOURCES.json`.
- **PDF.js**, Mozilla/pdf.js, bundled `pdfjs-dist` 4.10.38: Apache-2.0. https://github.com/mozilla/pdf.js/blob/master/LICENSE
- **pdf-lib**, Andrew Dillon and contributors, 1.17.1: MIT. https://github.com/Hopding/pdf-lib/blob/master/LICENSE.md
- **ONNX Runtime**, Microsoft Corporation and contributors, 1.22.0 and the supplied compact runtime build: MIT; third-party notices apply. https://github.com/microsoft/onnxruntime/blob/main/LICENSE ; https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt
- **Tesseract layout engine**: Apache-2.0; its supplied WASM layout binary is reused from the pinned Legal Browser OCR v0.1.4 runtime. https://github.com/tesseract-ocr/tesseract/blob/main/LICENSE
- **Kraken / CATMuS recognition lineage**: the legal-domain model bytes are reused unchanged from the user's published Legal Browser OCR v0.1.4 runtime. The source repository attributes CATMuS/Simon Gabay/Thibault Clerice and https://zenodo.org/records/10602357 . That record is titled CATMuS-Print [Tiny]; the original repository's Small wording is not new model provenance. Model assets are not relicensed by this integration; preserve their upstream notices/terms. This package does not assert that all third-party weights are MIT.

The archive includes `SOURCES.json` with SHA-256 hashes of actual bundled sources and embedded inputs. Source judgments retain their publisher terms; A2AJ's `upstream_license` is retained where supplied. No legal text or source PDFs are relicensed here.

## MIT permission notice

Copyright remains with the respective authors named by each upstream component.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
