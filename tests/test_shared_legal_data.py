import json
import sys
from pathlib import Path

from shared_legal_data import SharedA2AJCorpus, a2aj_status, isolated_process_env
from toa_maker import A2AJClient, Authority, _download_pdf
from toa_web import _dependency_status


def test_isolated_process_env_excludes_unrelated_credentials(monkeypatch):
    monkeypatch.setattr(
        "shared_legal_data.os.environ",
        {
            "PATH": "bin",
            "LEGALPDF_ENGINE_DIR": "engine",
            "DATABASE_URL": "postgres://secret",
            "OPENAI_API_KEY": "secret",
        },
    )

    env = isolated_process_env("LEGALPDF_*")

    assert env == {"PATH": "bin", "LEGALPDF_ENGINE_DIR": "engine"}


def test_paice_reporter_uses_shared_metadata_index_and_native_pdf(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("OPEN_LEGAL_DATA_HOME", str(tmp_path / "shared"))
    source = tmp_path / "a2aj.jsonl"
    source.write_text(
        json.dumps(
            {
                "doc_type": "cases",
                "dataset": "SCC",
                "citation_en": "2005 SCC 22",
                "citation2_en": "[2005] 1 SCR 339",
                "name_en": "R. v. Paice",
                "url_en": "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/2222/index.do",
            }
        ),
        encoding="utf-8",
    )
    from open_legal_data.bulk import import_a2aj

    import_a2aj([source], metadata_only=True)

    assert a2aj_status()["available"] is True
    result = SharedA2AJCorpus().fetch("[2005] 1 SCR 339", "cases")
    assert result["json"]["results"][0]["source_url_en"].endswith(
        "/item/2222/index.do"
    )

    monkeypatch.setitem(sys.modules, "duckdb", None)
    client = A2AJClient(cache_dir=tmp_path / "cache", offline=True)
    client.cache_dir.mkdir(parents=True)
    stale = client.cache_dir / (
        client._key(
            "/fetch",
            {
                "citation": "[2005] 1 SCR 339",
                "doc_type": "cases",
                "output_language": "en",
            },
        )
        + ".json"
    )
    stale.write_text(
        json.dumps({"status": 200, "json": {}, "error": ""}),
        encoding="utf-8",
    )
    lookup = client.lookup("[2005] 1 SCR 339", "case")
    assert lookup.status == "found"
    assert lookup.document and lookup.document.url.endswith("/item/2222/index.do")

    import fitz

    source_pdf = fitz.open()
    source_pdf.new_page()
    pdf_data = source_pdf.tobytes()
    source_pdf.close()

    class Response:
        status_code = 200
        headers = {"content-type": "application/pdf"}
        encoding = "utf-8"

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def iter_content(self, chunk_size):
            yield pdf_data

    class Session:
        def __init__(self):
            self.urls = []

        def get(self, url, **_):
            self.urls.append(url)
            return Response()

    authority = Authority(
        "paice",
        "case",
        lookup.document.citation,
        lookup.document.name,
        source_url=lookup.document.url,
        tab="Tab 1",
    )
    session = Session()
    _download_pdf(authority, tmp_path / "pdfs", "auto", session)
    assert session.urls[0].endswith("/2222/1/document.do")
    assert authority.pdf_origin == "original"

    runtime = _dependency_status()
    assert "duckdb" not in runtime["dependencies"]
    assert "data_root" not in runtime
