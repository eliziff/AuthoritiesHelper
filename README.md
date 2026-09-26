# AuthoritiesHelper

AuthoritiesHelper turns citations in a Word document or PDF into a reviewable
Table or Book of Authorities. Its local browser workspace lets you correct
citations, resolve sources and review pinpoints before generating documents.

This repository contains both maintained implementations: the Python
application documented below and the [modern standalone application](modern/README.md),
which owns the local deployment and packaging adapter for Beaver's shared
TypeScript Authorities core.

## Run the Python application

From this repository's root, with Python available:

```sh
python -X utf8 bootstrap.py --check
python -X utf8 bootstrap.py
```

The first launch installs dependencies into a managed runtime keyed by the
requirements/constraints hash beneath the shared OpenLegalData application-data
root. `--check` reports the interpreter and dependency availability without
installing or launching. The browser opens on localhost; `--port` and
`--no-browser` control the launcher. PDF/OCR capabilities additionally require
their compatible parser/runtime assets; a successful Python dependency check
alone does not validate those capabilities.

[bootstrap.py](bootstrap.py), [requirements.txt](requirements.txt) and
[requirements.lock.txt](requirements.lock.txt) define setup. An installed A2AJ
snapshot enables offline resolution; the application does not need a second
legal-data database service.

## Review and output

Import a DOCX/PDF, correct authority and pinpoint spans, resolve ambiguous
identities and `Ibid`/`supra` links, then choose Table, Book or both. Review PDF
sources, marking options and ordering before building. Pinpoints belong to
individual occurrences, not the authority identity. Manual books can instead
start from an ordered list of PDFs.

The application supports split/merge/relink/reorder/exclude/rename operations,
original-PDF preference with reconstruction fallback, explicit OCR and passage
marking, missing-source pages, and lightweight `.toa-project.json` review files.
Project files retain decisions and paths; they are not self-contained copies of
all source documents.

Selected outputs include annotated DOCX, table/book DOCX or PDF, source PDFs and
a `.toa-manifest.json` recording reviewed occurrences, links, tabs and unresolved
references. Inspect actual outputs, authority identities, versions, pinpoints,
missing sources and tab order. Neither a successful build nor a placeholder page
certifies filing readiness; renderer fidelity and court requirements differ.

## Command line

Use an interpreter with the locked dependencies installed (the `managedPython`
path reported by `bootstrap.py --check` identifies the managed interpreter).
Examples below assume `python` selects that environment:

```sh
python -X utf8 toa_maker.py build input.docx --output output --pdf-mode auto
python -X utf8 toa_maker.py lookup "2015 SCC 5" --kind case
python -X utf8 toa_maker.py manual-book manual-project.json --output "Book of Evidence.pdf"
```

PDF input can use `--output-mode book`. `--offline` uses the installed index and
cached responses; `--pdf-mode auto` prefers a validated original PDF. The CLI
contract is in [toa_maker.py](toa_maker.py), the browser host in
[toa_web.py](toa_web.py), and regression cases in [tests/](tests/).

## Data handling and license

Original PDFs are not modified in place. Online legal-source resolution sends
lookup requests; local processing is not a promise that every configured operation
is offline. OCR and marking are explicit choices.

[MIT](LICENSE). Third-party components, parser/model assets and legal data retain
their own licenses and notices.
