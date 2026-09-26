"""Platform-specific document delivery isolated from citation analysis."""
from __future__ import annotations

import sys
from pathlib import Path


def export_docx_to_pdf(input_path: str | Path, output_path: str | Path) -> Path:
    """Use desktop Word so pagination and fields match the user's document."""
    if sys.platform != "win32":
        raise RuntimeError("Word PDF export is available only on Windows with desktop Word installed.")
    try:
        import pythoncom
        import win32com.client
    except ImportError as exc:
        raise RuntimeError("Word PDF export requires pywin32 and desktop Microsoft Word.") from exc
    source, target = Path(input_path).resolve(), Path(output_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    pythoncom.CoInitialize()
    word = None
    document = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        document = word.Documents.Open(str(source), ReadOnly=True, AddToRecentFiles=False)
        document.Fields.Update()
        document.Repaginate()
        document.ExportAsFixedFormat(str(target), 17)
    except Exception as exc:
        raise RuntimeError(f"Microsoft Word could not export the marked document: {exc}") from exc
    finally:
        if document is not None:
            document.Close(False)
        if word is not None:
            word.Quit()
        pythoncom.CoUninitialize()
    if not target.is_file():
        raise RuntimeError("Microsoft Word did not create the requested PDF.")
    return target


def append_pdf(source_pdf: str | Path, appendix_pdf: str | Path, output_path: str | Path) -> Path:
    """Append one PDF atomically without mutating either input."""
    import fitz

    target = Path(output_path)
    partial = target.with_suffix(".part.pdf")
    partial.unlink(missing_ok=True)
    document = fitz.open()
    with fitz.open(source_pdf) as source:
        document.insert_pdf(source)
    with fitz.open(appendix_pdf) as appendix:
        document.insert_pdf(appendix)
    document.save(partial, garbage=3, deflate=True)
    document.close()
    partial.replace(target)
    return target
