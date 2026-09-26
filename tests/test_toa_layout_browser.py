from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from toa_web import _new_job, _update_job, create_server

try:
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.support.ui import Select
    from selenium.webdriver.support.ui import WebDriverWait
except ImportError:  # Browser checks are optional in the managed Python runtime.
    webdriver = None


CHROME = next(
    (
        path
        for path in (
            Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        )
        if path.is_file()
    ),
    None,
)
CHROMEDRIVER = next(
    iter(
        sorted(
            Path.home().parent.glob(
                r"*/.cache/selenium/chromedriver/win64/*/chromedriver.exe"
            ),
            reverse=True,
        )
    ),
    None,
)


@unittest.skipUnless(webdriver and CHROME, "Chrome and Selenium are required")
class ToALayoutBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory(
            dir=Path(__file__).resolve().parents[1]
        )
        root = Path(cls.temporary.name)
        cls.state_root = root
        (root / "settings.json").write_text(
            json.dumps({"setup_version": 3}),
            encoding="utf-8",
        )
        job_id, job = _new_job(root, "Appellant factum — authorities.docx")
        from toa_maker import (
            DeterministicPart,
            ReviewState,
            TextUnit,
            _anchor_spans,
            _part_from,
        )

        units = [
            TextUnit(
                "footnote:12",
                "footnote",
                1,
                12,
                "R v Grant, 2009 SCC 32 at paras 25–27.",
            ),
            TextUnit("footnote:13", "footnote", 2, 13, "Ibid at para 29."),
        ]
        parts = []
        for unit in units:
            part = _part_from(
                unit,
                1,
                "manual",
                [],
                DeterministicPart(
                    0,
                    len(unit.text),
                    unit.text,
                    tuple(item[2] for item in _anchor_spans(unit.text)),
                ),
            )
            part.uid = f"{unit.key}:p1"
            parts.append(part)
        parts[1].supra_target = parts[0].part_id
        ReviewState("Appellant factum — authorities.docx", units, parts, "now").save(
            job / "review.json",
            compact=True,
        )
        (job / "manual" / "state.json").write_text(
            json.dumps(
                {
                    "book_title": "Appeal authorities",
                    "entries": [
                        {
                            "id": "e" * 32,
                            "filename": "R-v-Grant.pdf",
                            "title": "R v Grant, 2009 SCC 32",
                            "tab": "1",
                        },
                        {
                            "id": "f" * 32,
                            "filename": "Charter.pdf",
                            "title": "Canadian Charter of Rights and Freedoms",
                            "tab": "2",
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )
        _update_job(
            job,
            state="complete",
            operation="detection",
            progress=100,
            message="Citation review ready",
        )
        cls.job_id = job_id
        cls.job_path = job
        long_job_id, long_job = _new_job(root, "Long factum.docx")
        long_units = [
            TextUnit(
                f"footnote:{number}",
                "footnote",
                number - 1,
                number,
                (
                    f"R v Example {number}, 20{number:02d} SCC {number}. "
                    + "This deliberately long citation note must scroll inside the review surface. "
                    * 8
                    if number == 12
                    else f"R v Example {number}, 20{number:02d} SCC {number}."
                ),
            )
            for number in range(1, 13)
        ]
        long_parts = []
        for unit in long_units:
            part = _part_from(
                unit,
                1,
                "manual",
                [],
                DeterministicPart(
                    0,
                    len(unit.text),
                    unit.text,
                    tuple(item[2] for item in _anchor_spans(unit.text)),
                ),
            )
            part.uid = f"{unit.key}:p1"
            long_parts.append(part)
        ReviewState("Long factum.docx", long_units, long_parts, "now").save(
            long_job / "review.json",
            compact=True,
        )
        _update_job(
            long_job,
            state="complete",
            operation="detection",
            progress=100,
            message="Citation review ready",
        )
        cls.long_job_id = long_job_id
        cls.server = create_server(0, state_root=root)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        options = webdriver.ChromeOptions()
        options.binary_location = str(CHROME)
        options.add_argument("--headless=new")
        options.add_argument("--disable-gpu")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-crash-reporter")
        options.add_argument("--no-first-run")
        options.add_argument(f"--user-data-dir={root / 'chrome-profile'}")
        try:
            cls.driver = webdriver.Chrome(
                options=options,
                service=Service(str(CHROMEDRIVER)) if CHROMEDRIVER else None,
            )
            cls.driver.execute_cdp_cmd(
                "Page.addScriptToEvaluateOnNewDocument",
                {
                    "source": """
                        window.__toaCls = 0;
                        new PerformanceObserver((list) => {
                          for (const entry of list.getEntries()) {
                            if (!entry.hadRecentInput) window.__toaCls += entry.value;
                          }
                        }).observe({type: 'layout-shift', buffered: true});
                    """
                },
            )
        except Exception as exc:  # pragma: no cover - machine browser setup
            cls.server.shutdown()
            cls.server.server_close()
            cls.thread.join(timeout=2)
            cls.temporary.cleanup()
            raise unittest.SkipTest(f"Chrome driver is unavailable: {exc}") from exc

    @classmethod
    def tearDownClass(cls) -> None:
        cls.driver.quit()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.temporary.cleanup()

    def wait_for(self, script: str) -> None:
        WebDriverWait(self.driver, 5).until(lambda driver: driver.execute_script(script))

    def test_canlii_download_capture_uses_only_the_chosen_local_folder(self) -> None:
        self.driver.get(self.base)
        self.wait_for("return typeof captureCanliiDownload === 'function'")
        matching = self.driver.execute_script(
            """
            const url = 'https://www.canlii.org/en/ab/abkb/doc/2024/2024abkb123/2024abkb123.pdf';
            const expected = canliiPdfFilename(url);
            return {
              expected,
              exact: matchesCanliiDownload('2024abkb123.pdf', expected),
              duplicate: matchesCanliiDownload('2024abkb123 (1).pdf', expected),
              wrong: matchesCanliiDownload('2024abkb124.pdf', expected),
            };
            """
        )
        self.assertEqual(
            matching,
            {
                "expected": "2024abkb123.pdf",
                "exact": True,
                "duplicate": True,
                "wrong": False,
            },
        )

        captured = self.driver.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            const originalAttach = attachPdf;
            const originalDirectory = canliiDownloadDirectory;
            const originalJob = currentJob;
            let reads = 0;
            const handle = {
              kind: 'file',
              name: '2024abkb123 (1).pdf',
              async getFile() {
                reads += 1;
                return new File(
                  [reads === 1 ? 'old' : '%PDF-1.7\\nlocal browser download'],
                  this.name,
                  {
                    type: 'application/pdf',
                    lastModified: reads === 1 ? Date.now() - 60_000 : Date.now(),
                  },
                );
              },
            };
            canliiDownloadDirectory = {
              async *values() { yield handle; },
            };
            currentJob = 'cccccccccccccccccccccccccccccccc';
            attachPdf = async (key, file) => {
              window.__canliiCapture = {
                key,
                name: file.name,
                header: new TextDecoder('ascii').decode(await file.slice(0, 5).arrayBuffer()),
              };
              return true;
            };
            captureCanliiDownload({
              key: 'authority-1',
              manual_pdf_url: 'https://www.canlii.org/en/ab/abkb/doc/2024/2024abkb123/2024abkb123.pdf',
            }).then(() => {
              const result = {
                capture: window.__canliiCapture,
                reads,
                pending: canliiCaptures.size,
              };
              attachPdf = originalAttach;
              canliiDownloadDirectory = originalDirectory;
              currentJob = originalJob;
              done(result);
            }).catch((error) => done({error: String(error)}));
            """
        )
        self.assertEqual(
            captured,
            {
                "capture": {
                    "key": "authority-1",
                    "name": "2024abkb123 (1).pdf",
                    "header": "%PDF-",
                },
                "reads": 2,
                "pending": 0,
            },
        )

        self.driver.execute_cdp_cmd(
            "Emulation.setDeviceMetricsOverride",
            {"width": 1000, "height": 700, "deviceScaleFactor": 1, "mobile": False},
        )
        rendered = self.driver.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            const originalApi = api;
            const originalFetch = window.fetch;
            const originalJob = currentJob;
            const originalState = currentJobState;
            let requests = 0;
            window.fetch = (...args) => { requests += 1; return originalFetch(...args); };
            api = async () => ({
              can_finalize: true,
              placeholder_count: 1,
              authorities: [{
                key: 'authority-1',
                name: 'R v Grant',
                citation: '2009 SCC 32',
                tab: '1',
                needs_pdf: true,
                manual_pdf_url: 'https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.pdf',
              }],
            });
            currentJob = 'cccccccccccccccccccccccccccccccc';
            currentJobState = {state: 'waiting', files: []};
            document.querySelector('#build-card').classList.remove('hidden');
            loadManifest().then(() => {
              const root = document.querySelector('#authority-list');
              const link = root.querySelector('a');
              const add = root.querySelector('label button');
              link.addEventListener('click', (event) => event.preventDefault());
              link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
              const result = {
                href: link.href,
                target: link.target,
                rel: link.rel,
                openText: link.textContent,
                addText: add.textContent,
                note: document.querySelector('#canlii-handoff-note').textContent,
                requests,
                minTarget: Math.min(link.getBoundingClientRect().height, add.getBoundingClientRect().height),
                overflow: document.documentElement.scrollWidth - innerWidth,
              };
              window.fetch = originalFetch;
              api = originalApi;
              currentJob = originalJob;
              currentJobState = originalState;
              done(result);
            }).catch((error) => done({error: String(error)}));
            """
        )
        self.assertEqual(
            rendered["href"],
            "https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.pdf",
        )
        self.assertEqual(rendered["target"], "_blank")
        self.assertEqual(set(rendered["rel"].split()), {"noopener", "noreferrer"})
        self.assertEqual(rendered["openText"], "Open CanLII PDF")
        self.assertEqual(rendered["addText"], "Add downloaded PDF")
        self.assertEqual(
            rendered["note"],
            "CanLII opens separately. Save the PDF, then add it here or watch a folder to attach it automatically.",
        )
        self.assertEqual(rendered["requests"], 0)
        self.assertGreaterEqual(rendered["minTarget"], 24)
        self.assertLessEqual(rendered["overflow"], 0)

        screenshot_dir = os.environ.get("TOA_SCREENSHOT_DIR")
        if screenshot_dir:
            output = Path(screenshot_dir)
            output.mkdir(parents=True, exist_ok=True)
            self.driver.execute_script(
                "document.querySelector('#toast').classList.remove('show');"
                "document.querySelector('#insert-card').scrollIntoView({block: 'start'})"
            )
            (output / "toa-canlii-handoff.png").write_bytes(
                self.driver.get_screenshot_as_png()
            )

    def test_beaver_saves_pdf_inputs_and_generated_outputs_once(self) -> None:
        self.driver.get(self.base)
        self.driver.execute_script(
            """
            const frame = document.createElement('iframe');
            frame.id = 'beaver-authorities';
            frame.src = '/?mode=mike&session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
            document.body.append(frame);
            """
        )
        WebDriverWait(self.driver, 5).until(
            lambda driver: driver.execute_script(
                "return document.querySelector('#beaver-authorities')?.contentDocument"
                ".readyState === 'complete'"
            )
        )
        self.driver.switch_to.frame("beaver-authorities")
        try:
            result = self.driver.execute_async_script(
                """
                const done = arguments[arguments.length - 1];
                const originalFetch = window.fetch;
                const originalUpdateJob = updateJob;
                const originalStartPolling = startPolling;
                const requests = [];
                let failNextSave = true;
                const job = {id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'};
                const manual = {book_title: 'Book of Authorities', entries: []};
                window.fetch = async (input, options = {}) => {
                  const url = String(input);
                  const stored = options.body instanceof FormData
                    ? options.body.get('file')
                    : null;
                  requests.push({url, name: stored?.name || ''});
                  if (url === '/api/table-of-authorities/documents') {
                    if (stored?.name === 'retry.pdf' && failNextSave) {
                      failNextSave = false;
                      return new Response('Target unavailable', {status: 503});
                    }
                    return new Response('{}', {
                      status: 201,
                      headers: {'Content-Type': 'application/json'},
                    });
                  }
                  if (url.includes('/generated/')) {
                    return new Response('%PDF-1.7 generated', {
                      headers: {'Content-Type': 'application/pdf'},
                    });
                  }
                  const body = url.includes('/manual') ? manual : job;
                  return new Response(JSON.stringify(body), {
                    headers: {'Content-Type': 'application/json'},
                  });
                };
                updateJob = () => {};
                startPolling = () => {};
                currentJob = job.id;
                manualState = manual;
                const pdf = (name) => new File(
                  ['%PDF-1.7 input'], name, {type: 'application/pdf'}
                );
                (async () => {
                  await uploadDocument(pdf('direct.pdf'));
                  await uploadDocument(new File(['word'], 'brief.docx'));
                  await attachPdf('authority-1', pdf('downloaded.pdf'));
                  await uploadManual([pdf('manual.pdf')]);
                  const files = [{
                    name: 'book.pdf',
                    size: 18,
                    url: '/api/jobs/result/generated/book.pdf',
                  }];
                  renderFiles(files);
                  document.querySelector('.output-save button').click();
                  while (outputSavePending) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                  }
                  document.querySelector('.output-save button').click();
                  await saveGeneratedFiles(files);
                  const retryFiles = [{
                    name: 'retry.pdf',
                    size: 19,
                    url: '/api/jobs/result/generated/retry.pdf',
                  }];
                  renderFiles(retryFiles);
                  document.querySelector('.output-save button').click();
                  while (outputSavePending) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                  }
                  const retryError = document.querySelector(
                    '.output-save [role="status"]'
                  ).textContent;
                  const retryEnabled = !document.querySelector(
                    '.output-save button'
                  ).disabled;
                  document.querySelector('.output-save button').click();
                  while (outputSavePending) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                  }
                  const hostRequests = requests.filter(
                    (request) => request.url === '/api/table-of-authorities/documents'
                  );
                  done({
                    beaverMode,
                    hostPath: apiPath('/api/table-of-authorities/documents'),
                    helperPath: apiPath('/api/jobs/example'),
                    names: hostRequests.map((request) => request.name),
                    bookSaves: hostRequests.filter(
                      (request) => request.name === 'book.pdf'
                    ).length,
                    retryError,
                    retryEnabled,
                    outputLabel: document.querySelector('.output-save button').textContent,
                    outputDisabled: document.querySelector('.output-save button').disabled,
                    outputError: document.querySelector('.output-save [role="status"]').textContent,
                  });
                })().catch((error) => done({error: String(error)})).finally(() => {
                  window.fetch = originalFetch;
                  updateJob = originalUpdateJob;
                  startPolling = originalStartPolling;
                });
                """
            )
        finally:
            self.driver.switch_to.default_content()

        self.assertNotIn("error", result)
        self.assertTrue(result["beaverMode"])
        self.assertEqual(
            result["hostPath"], "/api/table-of-authorities/documents"
        )
        self.assertEqual(
            result["helperPath"],
            "/api/table-of-authorities/workspace/jobs/example",
        )
        self.assertEqual(
            result["names"],
            [
                "direct.pdf",
                "downloaded.pdf",
                "manual.pdf",
                "book.pdf",
                "retry.pdf",
                "retry.pdf",
            ],
        )
        self.assertEqual(result["bookSaves"], 1)
        self.assertEqual(result["retryError"], "Target unavailable")
        self.assertTrue(result["retryEnabled"])
        self.assertEqual(result["outputLabel"], "Saved")
        self.assertTrue(result["outputDisabled"])
        self.assertEqual(result["outputError"], "")

    def test_viewport_shell_uses_internal_overflow(self) -> None:
        screenshot_dir = os.environ.get("TOA_SCREENSHOT_DIR")
        for name, width, height in (
            ("full-hd", 1920, 1080),
            ("desktop", 1440, 900),
            ("mobile", 390, 844),
            ("embedded-320", 305, 640),
            ("zoom-equivalent", 800, 500),
        ):
            with self.subTest(viewport=name):
                self.driver.execute_cdp_cmd(
                    "Emulation.setDeviceMetricsOverride",
                    {
                        "width": width,
                        "height": height,
                        "deviceScaleFactor": 1,
                        "mobile": False,
                    },
                )
                self.driver.get(f"{self.base}/?mode=mike&session={'a' * 32}")
                self.wait_for("return document.querySelector('#build-output_mode')")
                self.driver.find_element(By.ID, "automatic-create").click()
                self.wait_for(
                    "return !document.querySelector('#build-card').classList.contains('hidden')"
                )
                metrics = self.driver.execute_script(
                    """
                    const html = document.documentElement;
                    const body = document.body;
                    const main = document.querySelector('main');
                    const pane = document.querySelector('#automatic.active');
                    const workflow = document.querySelector('.workflow-card');
                    const heading = document.querySelector('h1');
                    const mainRect = main.getBoundingClientRect();
                    const workflowRect = workflow.getBoundingClientRect();
                    const tabs = [...document.querySelectorAll('.primary-tabs .primary')];
                    const tabRects = tabs.map((node) => node.getBoundingClientRect());
                    return {
                      innerWidth,
                      innerHeight,
                      cls: window.__toaCls,
                      htmlOverflow: html.scrollHeight - html.clientHeight,
                      bodyOverflow: body.scrollHeight - body.clientHeight,
                      mainOverflow: main.scrollHeight - main.clientHeight,
                      horizontalOverflow: {
                        html: html.scrollWidth - html.clientWidth,
                        body: body.scrollWidth - body.clientWidth,
                        main: main.scrollWidth - main.clientWidth,
                        pane: pane.scrollWidth - pane.clientWidth,
                      },
                      panelOverflow: Math.max(0, ...[...pane.querySelectorAll(
                        '.card, .review-workspace, .citation-list, .settings-grid, .manual-list'
                      )].filter((node) => node.offsetParent !== null)
                        .map((node) => node.scrollWidth - node.clientWidth)),
                      htmlSize: [html.clientHeight, html.scrollHeight],
                      bodySize: [body.clientHeight, body.scrollHeight],
                      htmlOverflowStyle: getComputedStyle(html).overflowY,
                      bodyOverflowStyle: getComputedStyle(body).overflowY,
                      mainBottom: mainRect.bottom,
                      paneOverflowY: getComputedStyle(pane).overflowY,
                      workflowBottom: workflowRect.bottom,
                      workflowWidth: workflowRect.width,
                      tabStart: document.querySelector('.primary').getBoundingClientRect().left,
                      tabTextOverflow: Math.max(...tabs.map(
                        (node) => node.scrollWidth - node.clientWidth
                      )),
                      tabOverlap: Math.max(0, ...tabRects.slice(1).map(
                        (rect, index) => tabRects[index].right - rect.left
                      )),
                      tabFontSize: Number.parseFloat(getComputedStyle(tabs[0]).fontSize),
                      contentStart: workflowRect.left,
                      headingOverflow: heading.scrollWidth - heading.clientWidth,
                      topbarDisplay: getComputedStyle(document.querySelector('.topbar')).display,
                      clippedControls: [...document.querySelectorAll('button, input, select, textarea')]
                        .filter((node) => node.offsetParent !== null)
                        .filter((node) => {
                          const rect = node.getBoundingClientRect();
                          return rect.left < -1 || rect.right > innerWidth + 1;
                        }).length,
                    };
                    """
                )
                self.assertLessEqual(metrics["bodyOverflow"], 1, metrics)
                self.assertLessEqual(metrics["mainOverflow"], 1, metrics)
                self.assertTrue(
                    all(value <= 1 for value in metrics["horizontalOverflow"].values()),
                    metrics,
                )
                self.assertLessEqual(metrics["panelOverflow"], 1, metrics)
                self.assertEqual(metrics["htmlOverflowStyle"], "clip", metrics)
                self.assertEqual(metrics["bodyOverflowStyle"], "hidden", metrics)
                self.assertLessEqual(metrics["mainBottom"], metrics["innerHeight"] + 1, metrics)
                self.assertEqual(metrics["paneOverflowY"], "auto", metrics)
                self.assertLessEqual(metrics["cls"], 0.01, metrics)
                self.assertLessEqual(metrics["workflowBottom"], 400, metrics)
                self.assertLessEqual(metrics["workflowWidth"], 1041, metrics)
                self.assertLessEqual(
                    abs(metrics["tabStart"] - metrics["contentStart"]), 0.5, metrics
                )
                self.assertLessEqual(metrics["tabTextOverflow"], 1, metrics)
                self.assertLessEqual(metrics["tabOverlap"], 0, metrics)
                self.assertGreaterEqual(metrics["tabFontSize"], 13, metrics)
                self.assertLessEqual(metrics["headingOverflow"], 1, metrics)
                self.assertEqual(metrics["topbarDisplay"], "none", metrics)
                self.assertEqual(metrics["clippedControls"], 0, metrics)
                if os.environ.get("TOA_PRINT_METRICS"):
                    print(name, json.dumps(metrics, sort_keys=True))
                if screenshot_dir:
                    (Path(screenshot_dir) / f"toa-{name}.png").write_bytes(
                        self.driver.get_screenshot_as_png()
                    )

                select_metrics = self.driver.execute_script(
                    """
                    return [...document.querySelectorAll('#automatic select')].map((select) => ({
                      width: select.getBoundingClientRect().width,
                      paneWidth: document.querySelector('#automatic').getBoundingClientRect().width,
                      title: select.title,
                    }));
                    """
                )
                self.assertTrue(select_metrics)
                self.assertTrue(
                    all(
                        row["width"] <= min(484, row["paneWidth"]) and row["title"]
                        for row in select_metrics
                    ),
                    select_metrics,
                )

                status_metrics = self.driver.execute_script(
                    """
                    const status = document.querySelector('#job-status');
                    updateJob({
                      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                      state: 'running',
                      progress: 48,
                      has_review: true,
                      input_name: 'Short title.docx',
                      message: 'Finding citations',
                      files: [],
                    });
                    const before = status.getBoundingClientRect().height;
                    updateJob({
                      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                      state: 'running',
                      progress: 48,
                      has_review: true,
                      input_name: 'A deliberately long document title that must remain on one line without moving the workspace.docx',
                      message: 'Finding citations',
                      files: [],
                    });
                    const busy = status.getBoundingClientRect().height;
                    const title = document.querySelector('#active-document-name');
                    const titleOverflow = title.scrollWidth - title.clientWidth;
                    settings.output_mode = 'table';
                    syncSettings();
                    updateJob({
                      id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                      state: 'running',
                      progress: 90,
                      has_review: true,
                      input_name: 'Short title.docx',
                      message: 'Building the table',
                      output_mode: 'table',
                      files: [],
                    });
                    const runningState = {
                      label: document.querySelector('#job-message').textContent,
                      progress: document.querySelector('#job-progress').value,
                      output: document.querySelector('#build-output_mode').value,
                      outputDisabled: document.querySelector('#build-output_mode').disabled,
                    };
                    const positioned = document.querySelector('.workflow-primary')
                      .nextElementSibling.contains(status);
                    const progressCount = document.querySelectorAll('#build-card progress').length;
                    const labelCount = document.querySelectorAll('#build-card #job-message').length;
                    updateJob(null);
                    settings.output_mode = 'book';
                    syncSettings();
                    return {
                      before,
                      busy,
                      titleOverflow,
                      positioned,
                      progressCount,
                      labelCount,
                      runningState,
                      cls: window.__toaCls,
                    };
                    """
                )
                self.assertLessEqual(abs(status_metrics["before"] - status_metrics["busy"]), 1, status_metrics)
                self.assertGreater(status_metrics["titleOverflow"], 0, status_metrics)
                self.assertTrue(status_metrics["positioned"], status_metrics)
                self.assertEqual(status_metrics["progressCount"], 1, status_metrics)
                self.assertEqual(status_metrics["labelCount"], 1, status_metrics)
                self.assertEqual(
                    status_metrics["runningState"],
                    {
                        "label": "Building the table",
                        "progress": 90,
                        "output": "table",
                        "outputDisabled": True,
                    },
                )
                self.assertLessEqual(status_metrics["cls"], 0.01, status_metrics)

                self.driver.find_element(By.CSS_SELECTOR, '[data-view="settings"]').click()
                self.wait_for("return document.querySelector('#settings.active')")
                self.assertEqual(
                    len(self.driver.find_elements(By.CSS_SELECTOR, "#settings select")),
                    0,
                )
                self.assertEqual(
                    len(self.driver.find_elements(By.CSS_SELECTOR, "#settings input[type=checkbox]")),
                    3,
                )
                self.assertFalse(self.driver.find_elements(By.ID, "settings-save"))
                self.assertEqual(
                    self.driver.find_element(By.ID, "setup-open").text,
                    "Change workflow defaults",
                )
                if screenshot_dir:
                    (Path(screenshot_dir) / f"toa-{name}-settings.png").write_bytes(
                        self.driver.get_screenshot_as_png()
                    )
        self.driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})

    def test_history_preloads_without_activation_pop_in_and_rehydrates_selection(self) -> None:
        self.driver.set_window_size(1000, 700)
        self.driver.get(f"{self.base}/?mode=mike&session={'c' * 32}")
        self.wait_for("return document.querySelector('#automatic.active')")
        self.wait_for(
            """
            return performance.getEntriesByType('resource')
              .filter((entry) => new URL(entry.name).pathname === '/api/jobs').length === 1;
            """
        )
        initial_jobs = self.driver.execute_script(
            """
            return performance.getEntriesByType('resource')
              .filter((entry) => new URL(entry.name).pathname === '/api/jobs').length;
            """
        )
        self.assertEqual(initial_jobs, 1)
        self.driver.execute_script(
            """
            window.__historyFrames = [];
            document.querySelector('[data-view="history"]').addEventListener('click', () => {
              let remaining = 6;
              const sample = () => {
                const view = document.querySelector('#history');
                if (view.classList.contains('active')) {
                  const list = document.querySelector('#history-list');
                  window.__historyFrames.push({
                    height: list.getBoundingClientRect().height,
                    text: list.textContent,
                  });
                }
                if (remaining-- > 0) requestAnimationFrame(sample);
              };
              requestAnimationFrame(sample);
            }, {once: true});
            """
        )
        self.driver.find_element(By.CSS_SELECTOR, '[data-view="history"]').click()
        self.wait_for("return document.querySelectorAll('.history-item').length === 2")
        self.wait_for("return window.__historyFrames.length >= 3")
        requested_jobs = self.driver.execute_script(
            """
            return performance.getEntriesByType('resource')
              .filter((entry) => new URL(entry.name).pathname === '/api/jobs').length;
            """
        )
        self.assertEqual(requested_jobs, 1)
        frames = self.driver.execute_script("return window.__historyFrames")
        self.assertTrue(all(frame["height"] == frames[0]["height"] for frame in frames), frames)
        self.assertTrue(all("Loading" not in frame["text"] for frame in frames), frames)
        screenshot_dir = os.environ.get("TOA_SCREENSHOT_DIR")
        if screenshot_dir:
            for name, width, height in (
                ("desktop", 1440, 900),
                ("narrow", 320, 640),
            ):
                self.driver.execute_cdp_cmd(
                    "Emulation.setDeviceMetricsOverride",
                    {
                        "width": width,
                        "height": height,
                        "deviceScaleFactor": 1,
                        "mobile": False,
                    },
                )
                (Path(screenshot_dir) / f"toa-history-{name}.png").write_bytes(
                    self.driver.get_screenshot_as_png()
                )
            self.driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
        metrics = self.driver.execute_script(
            """
            const list = document.querySelector('.history-list');
            const item = document.querySelector('.history-item').getBoundingClientRect();
            return {
              overflow: list.scrollWidth - list.clientWidth,
              item: [item.x, item.y, item.width, item.height],
              selects: list.querySelectorAll('select').length,
              statuses: list.querySelectorAll('span').length,
              text: list.textContent,
            };
            """
        )
        self.assertLessEqual(metrics["overflow"], 1, metrics)
        self.assertGreaterEqual(metrics["item"][3], 40, metrics)
        self.assertLessEqual(metrics["item"][3], 48, metrics)
        self.assertEqual(metrics["selects"], 0)
        self.assertEqual(metrics["statuses"], 0)
        self.assertNotIn("Needs attention", metrics["text"])
        self.assertNotIn("Reviewed", metrics["text"])
        self.driver.execute_script(
            """
            [...document.querySelectorAll('.history-item')]
              .find((item) => item.textContent.includes('Appellant factum')).click();
            """
        )
        self.wait_for(
            "return document.querySelector('#automatic.active')"
            " && document.querySelector('#active-document-name').textContent.includes('Appellant factum')"
            " && !document.querySelector('#review-card').classList.contains('hidden')"
        )
        if screenshot_dir:
            (Path(screenshot_dir) / "toa-restored-review.png").write_bytes(
                self.driver.get_screenshot_as_png()
            )
        resources = self.driver.execute_script(
            "return performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname)"
        )
        self.assertIn(f"/api/jobs/{self.job_id}/review", resources)
        self.assertNotIn(f"/api/jobs/{self.job_id}/manual", resources)

    def test_automatic_and_manual_are_primary_modes(self) -> None:
        self.driver.set_window_size(1000, 700)
        self.driver.get(self.base)
        self.wait_for("return document.querySelector('#automatic.active')")
        labels = [
            button.text
            for button in self.driver.find_elements(By.CSS_SELECTOR, ".primary-tabs .primary")
        ]
        self.assertEqual(labels, ["Automatic", "Manual", "History", "Settings"])
        before_tabs = self.driver.execute_script(
            "return [...document.querySelectorAll('.primary-tabs .primary')]"
            ".map((node) => { const r=node.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; })"
        )
        self.driver.find_element(By.CSS_SELECTOR, '[data-view="manual"]').click()
        self.wait_for("return document.querySelector('#manual.active')")
        after_tabs = self.driver.execute_script(
            "return [...document.querySelectorAll('.primary-tabs .primary')]"
            ".map((node) => { const r=node.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; })"
        )
        self.assertEqual(before_tabs, after_tabs)
        self.assertEqual(
            self.driver.find_element(By.CSS_SELECTOR, '[data-view="manual"]').get_attribute(
                "aria-current"
            ),
            "page",
        )
        self.assertIsNone(
            self.driver.find_element(By.CSS_SELECTOR, '[data-view="automatic"]').get_attribute(
                "aria-current"
            )
        )
        self.assertTrue(self.driver.find_element(By.ID, "manual-create").is_displayed())
        self.assertFalse(self.driver.find_element(By.ID, "manual-build").is_displayed())
        self.driver.find_element(By.ID, "manual-create").click()
        self.wait_for("return document.querySelector('#manual-build').offsetParent !== null")
        self.assertTrue(self.driver.find_element(By.ID, "manual-build").is_displayed())
        self.assertFalse(self.driver.find_element(By.ID, "manual-build").is_enabled())
        progress = self.driver.execute_script(
            """
            const slot = document.querySelector('#manual-progress-slot');
            const before = slot.getBoundingClientRect().height;
            updateJob({
              id: 'dddddddddddddddddddddddddddddddd',
              state: 'running',
              operation: 'manual book',
              progress: 40,
              message: 'Building the book',
              files: [],
            });
            const after = slot.getBoundingClientRect().height;
            const result = {
              before,
              after,
              parent: document.querySelector('#job-status').parentElement.id,
              indicators: document.querySelectorAll('#job-progress').length,
              label: document.querySelector('#job-message').textContent,
            };
            updateJob(null);
            return result;
            """
        )
        self.assertLessEqual(abs(progress["before"] - progress["after"]), 1, progress)
        self.assertEqual(progress["parent"], "manual-progress-slot")
        self.assertEqual(progress["indicators"], 1)
        self.assertEqual(progress["label"], "Building the book")
        self.driver.find_element(By.CSS_SELECTOR, '[data-view="automatic"]').click()
        self.wait_for("return document.querySelector('#automatic.active')")

    def test_standalone_and_embedded_share_beaver_visual_tokens(self) -> None:
        self.driver.set_window_size(1000, 700)
        modes = []
        for path in ("", f"/?mode=mike&session={'f' * 32}"):
            self.driver.get(f"{self.base}{path}")
            self.wait_for("return document.querySelector('#automatic-create')")
            modes.append(
                self.driver.execute_script(
                    """
                    const body = getComputedStyle(document.body);
                    const card = getComputedStyle(document.querySelector('.card'));
                    const heading = getComputedStyle(document.querySelector('h2'));
                    const button = getComputedStyle(document.querySelector('#automatic-create'));
                    const tab = getComputedStyle(document.querySelector('.primary.active'));
                    const nav = getComputedStyle(document.querySelector('.primary-tabs'));
                    const main = document.querySelector('main').getBoundingClientRect();
                    return {
                      bodyBackground: body.backgroundColor,
                      cardBackground: card.backgroundColor,
                      cardBorder: card.borderTopColor,
                      cardRadius: card.borderTopLeftRadius,
                      sameHeadingFont: heading.fontFamily === body.fontFamily,
                      buttonBackground: button.backgroundColor,
                      buttonRadius: button.borderTopLeftRadius,
                      buttonFontSize: Number.parseFloat(button.fontSize),
                      buttonFontWeight: button.fontWeight,
                      tabBackground: tab.backgroundColor,
                      tabRadius: tab.borderTopLeftRadius,
                      tabFontSize: Number.parseFloat(tab.fontSize),
                      tabFontWeight: tab.fontWeight,
                      headingFontSize: Number.parseFloat(heading.fontSize),
                      headingFontWeight: heading.fontWeight,
                      navBackground: nav.backgroundColor,
                      mainWidth: main.width,
                    };
                    """
                )
            )
        main_widths = [mode.pop("mainWidth") for mode in modes]
        self.assertEqual(modes[0], modes[1])
        style = modes[0]
        self.assertEqual(style["bodyBackground"], "rgb(243, 244, 246)")
        self.assertEqual(style["cardBackground"], "rgb(255, 255, 255)")
        self.assertEqual(style["cardBorder"], "rgb(209, 213, 219)")
        self.assertEqual(style["cardRadius"], "10px")
        self.assertTrue(style["sameHeadingFont"])
        self.assertEqual(style["buttonBackground"], "rgb(17, 24, 39)")
        self.assertEqual(style["buttonRadius"], "8px")
        self.assertGreaterEqual(style["buttonFontSize"], 14.5)
        self.assertLessEqual(style["buttonFontSize"], 15.2)
        self.assertEqual(style["buttonFontWeight"], "500")
        self.assertEqual(style["tabBackground"], "rgb(213, 43, 30)")
        self.assertEqual(style["tabRadius"], "8px")
        self.assertGreaterEqual(style["tabFontSize"], 14.5)
        self.assertLessEqual(style["tabFontSize"], 15.2)
        self.assertEqual(style["tabFontWeight"], "500")
        self.assertGreaterEqual(style["headingFontSize"], 16)
        self.assertLessEqual(style["headingFontSize"], 18)
        self.assertEqual(style["headingFontWeight"], "650")
        self.assertEqual(style["navBackground"], "rgb(243, 244, 246)")
        self.assertLessEqual(main_widths[0], 960)
        self.assertLessEqual(main_widths[1], 1000)

    def test_settings_auto_save_latest_change_wins_without_save_button(self) -> None:
        settings_path = self.state_root / "settings.json"
        settings_path.write_text(
            json.dumps({"setup_version": 3, "offline": False}),
            encoding="utf-8",
        )
        try:
            self.driver.get(self.base)
            self.wait_for("return document.querySelector('#all-offline')")
            self.driver.find_element(By.CSS_SELECTOR, '[data-view="settings"]').click()
            self.assertFalse(self.driver.find_elements(By.ID, "settings-save"))
            self.assertEqual(
                self.driver.find_element(By.ID, "setup-open").text,
                "Change workflow defaults",
            )
            self.driver.execute_script(
                """
                window.__settingsCompleted = 0;
                window.__originalFetch = window.fetch;
                let delayFirst = true;
                window.fetch = (input, options = {}) => {
                  const isSettingsWrite = String(input).endsWith('/api/settings')
                    && options.method === 'PUT';
                  const send = () => window.__originalFetch(input, options).then((response) => {
                    if (isSettingsWrite) window.__settingsCompleted += 1;
                    return response;
                  });
                  if (isSettingsWrite && delayFirst) {
                    delayFirst = false;
                    return new Promise((resolve) => setTimeout(() => resolve(send()), 250));
                  }
                  return send();
                };
                const input = document.querySelector('#all-offline');
                input.click();
                input.click();
                """
            )
            self.wait_for("return window.__settingsCompleted === 2")
            self.assertFalse(
                json.loads(settings_path.read_text(encoding="utf-8"))["offline"]
            )
        finally:
            settings_path.write_text(
                json.dumps({"setup_version": 3}),
                encoding="utf-8",
            )

    def test_manual_settings_done_persists_and_renders_book_title(self) -> None:
        state_path = self.job_path / "manual" / "state.json"
        original_state = state_path.read_text(encoding="utf-8")
        try:
            _update_job(
                self.job_path,
                state="complete",
                operation="manual book",
                progress=100,
                message="Manual book ready",
            )
            self.driver.get(
                f"{self.base}/?mode=mike&session={'9' * 32}&job={self.job_id}"
            )
            self.wait_for(
                "return document.querySelector('#manual.active')"
                " && document.querySelectorAll('.manual-row').length === 2"
            )
            self.driver.find_element(By.CSS_SELECTOR, '[data-view="settings"]').click()
            self.driver.find_element(By.ID, "setup-open").click()
            self.wait_for("return document.querySelector('#setup-dialog').open")
            title = self.driver.find_element(By.ID, "setup-manual-title")
            title.clear()
            title.send_keys("Revised appeal authorities")
            self.driver.find_element(By.ID, "setup-submit").click()
            self.wait_for(
                "return !document.querySelector('#setup-dialog').open"
                " && document.querySelector('#manual-title').value"
                " === 'Revised appeal authorities'"
            )
            WebDriverWait(self.driver, 5).until(
                lambda _: json.loads(state_path.read_text(encoding="utf-8"))[
                    "book_title"
                ]
                == "Revised appeal authorities"
            )
        finally:
            state_path.write_text(original_state, encoding="utf-8")
            _update_job(
                self.job_path,
                state="complete",
                operation="detection",
                progress=100,
                message="Citation review ready",
            )

    def test_manual_and_running_progress_screenshots(self) -> None:
        screenshot_dir = os.environ.get("TOA_SCREENSHOT_DIR")
        if not screenshot_dir:
            self.skipTest("TOA_SCREENSHOT_DIR is required for visual evidence")
        output = Path(screenshot_dir)
        try:
            for name, width, height in (
                ("desktop", 1440, 900),
                ("narrow", 390, 844),
            ):
                with self.subTest(viewport=name):
                    self.driver.execute_cdp_cmd(
                        "Emulation.setDeviceMetricsOverride",
                        {
                            "width": width,
                            "height": height,
                            "deviceScaleFactor": 1,
                            "mobile": False,
                        },
                    )
                    _update_job(
                        self.job_path,
                        state="complete",
                        operation="manual book",
                        progress=100,
                        message="Manual book ready",
                    )
                    self.driver.get(
                        f"{self.base}/?mode=mike&session={'d' * 32}&job={self.job_id}"
                    )
                    self.wait_for(
                        "return document.querySelector('#manual.active')"
                        " && document.querySelectorAll('.manual-row').length === 2"
                    )
                    overflow = self.driver.execute_script(
                        """
                        const pane = document.querySelector('#manual');
                        const nodes = [document.documentElement, document.body, pane,
                          document.querySelector('.manual-card'),
                          document.querySelector('.manual-list'),
                          ...document.querySelectorAll('.manual-row')];
                        return nodes.map((node) => node.scrollWidth - node.clientWidth);
                        """
                    )
                    self.assertTrue(all(value <= 1 for value in overflow), overflow)
                    (output / f"toa-manual-{name}.png").write_bytes(
                        self.driver.get_screenshot_as_png()
                    )
                    idle_height = self.driver.execute_script(
                        "return document.querySelector('#manual-progress-slot')"
                        ".getBoundingClientRect().height"
                    )

                    _update_job(
                        self.job_path,
                        state="running",
                        operation="manual book",
                        progress=45,
                        message="raw worker detail",
                    )
                    self.driver.refresh()
                    self.wait_for(
                        "return document.querySelector('#manual.active')"
                        " && document.querySelector('#job-message').textContent === 'Building the book'"
                        " && Number(document.querySelector('#job-progress').value) === 45"
                    )
                    manual = self.driver.execute_script(
                        """
                        const slot = document.querySelector('#manual-progress-slot');
                        return {
                          parent: document.querySelector('#job-status').parentElement.id,
                          indicators: document.querySelectorAll('#job-progress').length,
                          labels: document.querySelectorAll('#job-message').length,
                          slotHeight: slot.getBoundingClientRect().height,
                          afterBuild: document.querySelector('.manual-controls')
                            .nextElementSibling === slot,
                          bottomDuplicates: document.querySelectorAll('.status-strip').length,
                        };
                        """
                    )
                    self.assertEqual(manual["parent"], "manual-progress-slot", manual)
                    self.assertEqual(manual["indicators"], 1, manual)
                    self.assertEqual(manual["labels"], 1, manual)
                    self.assertTrue(manual["afterBuild"], manual)
                    self.assertEqual(manual["bottomDuplicates"], 0, manual)
                    self.assertLessEqual(
                        abs(manual["slotHeight"] - idle_height), 1, manual
                    )
                    (output / f"toa-manual-running-{name}.png").write_bytes(
                        self.driver.get_screenshot_as_png()
                    )

                    _update_job(
                        self.job_path,
                        state="running",
                        operation="build",
                        output_mode="book",
                        progress=64,
                        message="raw worker detail",
                    )
                    self.driver.refresh()
                    self.wait_for(
                        "return document.querySelector('#automatic.active')"
                        " && document.querySelector('#job-message').textContent === 'Matching PDFs'"
                        " && Number(document.querySelector('#job-progress').value) === 64"
                    )
                    automatic = self.driver.execute_script(
                        """
                        const slot = document.querySelector('#automatic-progress-slot');
                        return {
                          parent: document.querySelector('#job-status').parentElement.id,
                          indicators: document.querySelectorAll('#job-progress').length,
                          labels: document.querySelectorAll('#job-message').length,
                          afterBuild: document.querySelector('.workflow-primary')
                            .nextElementSibling === slot,
                          bottomDuplicates: document.querySelectorAll('.status-strip').length,
                          outputDisabled: document.querySelector('#build-output_mode').disabled,
                        };
                        """
                    )
                    self.assertEqual(
                        automatic["parent"], "automatic-progress-slot", automatic
                    )
                    self.assertEqual(automatic["indicators"], 1, automatic)
                    self.assertEqual(automatic["labels"], 1, automatic)
                    self.assertTrue(automatic["afterBuild"], automatic)
                    self.assertEqual(automatic["bottomDuplicates"], 0, automatic)
                    self.assertTrue(automatic["outputDisabled"], automatic)
                    if name == "narrow":
                        self.driver.execute_script(
                            "const pane = document.querySelector('#automatic');"
                            " pane.scrollTop = pane.scrollHeight"
                        )
                    (output / f"toa-automatic-running-{name}.png").write_bytes(
                        self.driver.get_screenshot_as_png()
                    )
        finally:
            _update_job(
                self.job_path,
                state="complete",
                operation="detection",
                progress=100,
                message="Citation review ready",
            )
            self.driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})

    def test_review_surface_matches_python_workflow_without_horizontal_scroll(self) -> None:
        for width, height in ((1440, 900), (390, 844)):
            with self.subTest(width=width):
                self.driver.execute_cdp_cmd(
                    "Emulation.setDeviceMetricsOverride",
                    {
                        "width": width,
                        "height": height,
                        "deviceScaleFactor": 1,
                        "mobile": False,
                    },
                )
                self.driver.get(
                    f"{self.base}/?mode=mike&session={'b' * 32}&job={self.job_id}"
                )
                self.wait_for("return document.querySelectorAll('.citation-item').length === 2")
                before = self.driver.execute_script(
                    """
                    const workspace = document.querySelector('.review-workspace').getBoundingClientRect();
                    const surface = document.querySelector('.review-surface').getBoundingClientRect();
                    return [[workspace.x, workspace.y, workspace.width, workspace.height],
                            [surface.x, surface.y, surface.width, surface.height]];
                    """
                )
                self.driver.execute_script(
                    "document.querySelectorAll('.citation-item')[1].click()"
                )
                after = self.driver.execute_script(
                    """
                    const workspace = document.querySelector('.review-workspace').getBoundingClientRect();
                    const surface = document.querySelector('.review-surface').getBoundingClientRect();
                    return [[workspace.x, workspace.y, workspace.width, workspace.height],
                            [surface.x, surface.y, surface.width, surface.height]];
                    """
                )
                self.assertEqual(before, after)
                screenshot_dir = os.environ.get("TOA_SCREENSHOT_DIR")
                if screenshot_dir:
                    name = "desktop" if width == 1440 else "narrow"
                    (Path(screenshot_dir) / f"toa-review-{name}.png").write_bytes(
                        self.driver.get_screenshot_as_png()
                    )
                metrics = self.driver.execute_script(
                    """
                    const card = document.querySelector('#review-card').getBoundingClientRect();
                    const workspace = document.querySelector('.review-workspace');
                    const controls = [...workspace.querySelectorAll('button, input')];
                    const name = document.querySelector('.citation-name');
                    const location = document.querySelector('.citation-location');
                    return {
                      cardWidth: card.width,
                      workspaceHeight: workspace.getBoundingClientRect().height,
                      overflow: workspace.scrollWidth - workspace.clientWidth,
                      clipped: controls.filter((node) => {
                        const rect = node.getBoundingClientRect();
                        return rect.left < card.left - 1 || rect.right > card.right + 1;
                      }).length,
                      actions: [...document.querySelectorAll('.review-actions button')]
                        .map((button) => button.textContent.trim()),
                      link: document.querySelector('.review-link').textContent.trim(),
                      source: document.querySelector('.review-surface').getAttribute('aria-label'),
                      sourceText: document.querySelector('.review-surface').textContent,
                      activeDocument: document.querySelector('#active-document-name').textContent,
                      selected: document.querySelectorAll('.citation-item[aria-selected="true"]').length,
                      saveButtons: document.querySelectorAll('#review-save').length,
                      listItems: document.querySelectorAll('.citation-item').length,
                      genericFields: workspace.querySelectorAll('.review-fields, [data-field]').length,
                      actionHeights: [...document.querySelectorAll('.review-actions button')]
                        .map((button) => button.getBoundingClientRect().height),
                      nameSize: Number.parseFloat(getComputedStyle(name).fontSize),
                      locationSize: Number.parseFloat(getComputedStyle(location).fontSize),
                      authorityColor: (() => {
                        const node = document.createElement('span');
                        node.className = 'review-authority';
                        document.body.append(node);
                        const value = getComputedStyle(node).backgroundColor;
                        node.remove();
                        return value;
                      })(),
                      pinpointColor: (() => {
                        const node = document.createElement('span');
                        node.className = 'review-pinpoint';
                        document.body.append(node);
                        const value = getComputedStyle(node).backgroundColor;
                        node.remove();
                        return value;
                      })(),
                    };
                    """
                )
                self.assertLessEqual(metrics["cardWidth"], 1041, metrics)
                self.assertLessEqual(metrics["overflow"], 1, metrics)
                self.assertEqual(metrics["clipped"], 0, metrics)
                self.assertEqual(
                    metrics["actions"],
                    [
                        "Use selection as authority",
                        "Use selection as pinpoint",
                        "Split at cursor",
                        "Merge with previous",
                    ],
                )
                self.assertEqual(metrics["source"], "Footnote 13 full citation text")
                self.assertEqual(metrics["sourceText"], "Ibid at para 29.")
                self.assertIn("Appellant factum", metrics["activeDocument"])
                self.assertEqual(metrics["selected"], 1)
                self.assertEqual(metrics["saveButtons"], 0)
                self.assertEqual(metrics["listItems"], 2)
                self.assertEqual(metrics["genericFields"], 0)
                self.assertTrue(all(value >= 38 for value in metrics["actionHeights"]), metrics)
                self.assertGreater(metrics["nameSize"], metrics["locationSize"])
                self.assertEqual(metrics["authorityColor"], "rgb(255, 215, 211)")
                self.assertEqual(metrics["pinpointColor"], "rgb(246, 170, 163)")
                self.assertNotEqual(metrics["authorityColor"], metrics["pinpointColor"])
                self.assertIn("Linked to R v Grant", metrics["link"])
                self.assertNotIn("footnote:", metrics["link"])
                if width > 800:
                    self.assertEqual(metrics["workspaceHeight"], 300, metrics)

        self.driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
        self.driver.execute_script("document.querySelectorAll('.citation-item')[1].click()")
        self.driver.execute_script("document.querySelector('#link-citation').click()")
        self.driver.execute_script("document.querySelectorAll('.citation-item')[0].click()")
        WebDriverWait(self.driver, 5).until(
            lambda _driver: json.loads(
                (self.job_path / "review.json").read_text(encoding="utf-8")
            )["parts"][1]["supra_target"]
            == "footnote:12:p1"
        )
        self.wait_for("return linkingReviewPartId === ''")
        self.driver.execute_script("document.querySelectorAll('.citation-item')[0].click()")
        self.wait_for(
            "return document.querySelector('#review-surface').textContent.includes('R v Grant')"
        )
        self.driver.execute_script(
            """
            const root = document.querySelector('#review-surface');
            const range = document.createRange();
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            let offset = 0;
            let startNode;
            let endNode;
            let startOffset = 0;
            let endOffset = 0;
            const end = 'R v Grant, 2009 SCC 32'.length;
            while ((node = walker.nextNode())) {
              const next = offset + node.data.length;
              if (!startNode && offset <= 0 && 0 <= next) {
                startNode = node;
                startOffset = 0;
              }
              if (!endNode && offset <= end && end <= next) {
                endNode = node;
                endOffset = end - offset;
                break;
              }
              offset = next;
            }
            range.setStart(startNode, startOffset);
            range.setEnd(endNode, endOffset);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            """
        )
        self.driver.execute_script("document.querySelector('#mark-authority').click()")
        WebDriverWait(self.driver, 5).until(
            lambda _driver: json.loads(
                (self.job_path / "review.json").read_text(encoding="utf-8")
            )["parts"][0]["reviewed"]
        )

    def test_review_list_reaches_every_footnote(self) -> None:
        for width, height in ((1440, 900), (800, 500), (390, 844), (305, 640)):
            with self.subTest(width=width):
                self.driver.execute_cdp_cmd(
                    "Emulation.setDeviceMetricsOverride",
                    {
                        "width": width,
                        "height": height,
                        "deviceScaleFactor": 1,
                        "mobile": False,
                    },
                )
                self.driver.get(
                    f"{self.base}/?mode=mike&session={'e' * 32}&job={self.long_job_id}"
                )
                self.wait_for(
                    "return document.querySelectorAll('.citation-item').length === 12"
                )
                metrics = self.driver.execute_script(
                    """
                    const list = document.querySelector('#review-list');
                    const items = [...list.querySelectorAll('.citation-item')];
                    const rects = () => ['.review-workspace', '.review-surface',
                      '.review-actions', '#build-card'].map((selector) => {
                        const rect = document.querySelector(selector).getBoundingClientRect();
                        return [rect.x, rect.y, rect.width, rect.height];
                      });
                    const before = rects();
                    items.at(-1).scrollIntoView({block: 'nearest'});
                    items.at(-1).click();
                    const surface = document.querySelector('#review-surface');
                    const listRect = list.getBoundingClientRect();
                    const lastRect = items.at(-1).getBoundingClientRect();
                    return {
                      before,
                      after: rects(),
                      count: items.length,
                      scrollTop: list.scrollTop,
                      lastVisible: lastRect.top >= listRect.top - 1
                        && lastRect.bottom <= listRect.bottom + 1,
                      selected: items.at(-1).getAttribute('aria-selected'),
                      label: surface.getAttribute('aria-label'),
                      surfaceScrolls: surface.scrollHeight > surface.clientHeight,
                      overflowX: list.scrollWidth - list.clientWidth,
                    };
                    """
                )
                if width <= 480:
                    self.assertEqual(metrics["before"], metrics["after"], metrics)
                self.assertEqual(metrics["count"], 12)
                self.assertGreater(metrics["scrollTop"], 0, metrics)
                self.assertTrue(metrics["lastVisible"], metrics)
                self.assertEqual(metrics["selected"], "true")
                self.assertEqual(metrics["label"], "Footnote 12 full citation text")
                if width <= 480:
                    self.assertTrue(metrics["surfaceScrolls"], metrics)
                self.assertLessEqual(metrics["overflowX"], 1, metrics)
        self.driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})

    def test_select_and_list_rows_are_not_clipped(self) -> None:
        screenshot_dir = os.environ.get("TOA_SCREENSHOT_DIR")
        for name, width, height in (("desktop", 1440, 900), ("narrow", 390, 844)):
            with self.subTest(viewport=name):
                self.driver.execute_cdp_cmd(
                    "Emulation.setDeviceMetricsOverride",
                    {
                        "width": width,
                        "height": height,
                        "deviceScaleFactor": 1,
                        "mobile": False,
                    },
                )
                self.driver.get(
                    f"{self.base}/?mode=mike&session={'c' * 32}&job={self.job_id}"
                )
                self.wait_for("return document.querySelectorAll('.citation-item').length === 2")
                self.driver.find_element(By.CSS_SELECTOR, ".build-options summary").click()
                metrics = self.driver.execute_script(
                    """
                    const number = (value) => Number.parseFloat(value) || 0;
                    const selects = [...document.querySelectorAll('#automatic select')]
                      .filter((node) => node.offsetParent !== null)
                      .map((select) => {
                        const style = getComputedStyle(select);
                        const optionStyle = getComputedStyle(select.options[0]);
                        return {
                          id: select.id || select.dataset.field,
                          height: select.getBoundingClientRect().height,
                          contentHeight: select.clientHeight
                            - number(style.paddingTop) - number(style.paddingBottom),
                          lineHeight: number(style.lineHeight),
                          fontSize: number(style.fontSize),
                          optionLineHeight: number(optionStyle.lineHeight),
                          optionFontSize: number(optionStyle.fontSize),
                        };
                      });
                    const rows = [...document.querySelectorAll('.citation-item')].map((row) => {
                      const bottom = row.getBoundingClientRect().bottom;
                      return {
                        clientHeight: row.clientHeight,
                        scrollHeight: row.scrollHeight,
                        childrenInside: [...row.children].every(
                          (child) => child.getBoundingClientRect().bottom <= bottom + 0.5
                        ),
                      };
                    });
                    return {selects, rows};
                    """
                )
                self.assertTrue(metrics["selects"], metrics)
                for select in metrics["selects"]:
                    self.assertGreaterEqual(select["height"], 40, select)
                    self.assertGreaterEqual(
                        select["contentHeight"] + 0.5,
                        select["lineHeight"],
                        select,
                    )
                    self.assertGreaterEqual(
                        select["optionLineHeight"] + 0.5,
                        select["optionFontSize"] * 1.3,
                        select,
                    )
                self.assertTrue(
                    all(
                        row["scrollHeight"] <= row["clientHeight"] + 1
                        and row["childrenInside"]
                        for row in metrics["rows"]
                    ),
                    metrics,
                )
                pdf_source = self.driver.find_element(By.ID, "build-pdf_mode")
                pdf_source.click()
                if screenshot_dir:
                    (Path(screenshot_dir) / f"toa-select-{name}.png").write_bytes(
                        self.driver.get_screenshot_as_png()
                    )
                pdf_source.send_keys(Keys.ESCAPE)
        self.driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})

    def test_textless_pdf_decision_is_compact_and_escape_closes(self) -> None:
        for width, height in ((800, 700), (390, 844)):
            with self.subTest(width=width):
                self.driver.execute_cdp_cmd(
                    "Emulation.setDeviceMetricsOverride",
                    {
                        "width": width,
                        "height": height,
                        "deviceScaleFactor": 1,
                        "mobile": False,
                    },
                )
                self.driver.get(self.base)
                self.wait_for("return document.querySelector('#scanned-pdf-dialog')")
                before = self.driver.execute_script(
                    "const r=document.querySelector('main').getBoundingClientRect(); return [r.x,r.y,r.width,r.height]"
                )
                self.driver.execute_script(
                    "document.querySelector('#scanned-pdf-dialog').showModal()"
                )
                metrics = self.driver.execute_script(
                    """
                    const dialog = document.querySelector('#scanned-pdf-dialog');
                    const rect = dialog.getBoundingClientRect();
                    const main = document.querySelector('main').getBoundingClientRect();
                    return {
                      dialog: [rect.left, rect.top, rect.right, rect.bottom],
                      main: [main.x, main.y, main.width, main.height],
                      overflow: dialog.scrollWidth - dialog.clientWidth,
                      steps: dialog.querySelectorAll('.scan-flow li').length,
                      choices: dialog.querySelectorAll('input[name="scanned-policy"]').length,
                      choiceSizes: [...dialog.querySelectorAll('.choice')].map((label) => {
                        const input = label.querySelector('input');
                        return [input.getBoundingClientRect().width,
                                input.getBoundingClientRect().height,
                                label.getBoundingClientRect().height];
                      }),
                    };
                    """
                )
                self.assertEqual(metrics["main"], before)
                self.assertGreaterEqual(metrics["dialog"][0], 0)
                self.assertGreaterEqual(metrics["dialog"][1], 0)
                self.assertLessEqual(metrics["dialog"][2], width)
                self.assertLessEqual(metrics["dialog"][3], height)
                self.assertLessEqual(metrics["overflow"], 1, metrics)
                self.assertEqual(metrics["steps"], 3)
                self.assertEqual(metrics["choices"], 3)
                self.assertTrue(
                    all(
                        16 <= input_width <= 18
                        and 16 <= input_height <= 18
                        and label_height >= 40
                        for input_width, input_height, label_height in metrics["choiceSizes"]
                    ),
                    metrics,
                )
                self.driver.switch_to.active_element.send_keys(Keys.ESCAPE)
                self.wait_for(
                    "return !document.querySelector('#scanned-pdf-dialog').open"
                )
        self.driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})

    def test_setup_explains_real_source_outcomes_and_reopens(self) -> None:
        settings_path = self.state_root / "settings.json"
        settings_path.write_text(
            json.dumps({"setup_version": 0, "highlight_style": "margin"}),
            encoding="utf-8",
        )
        screenshot_dir = os.environ.get("TOA_SCREENSHOT_DIR")
        try:
            self.driver.set_window_size(900, 760)
            self.driver.get(f"{self.base}/?mode=mike&session={'d' * 32}")
            self.wait_for("return document.querySelector('#automatic-create')")
            before_setup = self.driver.execute_script(
                """
                return ['main', '.primary-tabs', '#automatic-start'].map((selector) => {
                  const rect = document.querySelector(selector).getBoundingClientRect();
                  return [rect.x, rect.y, rect.width, rect.height];
                });
                """
            )
            self.driver.find_element(By.ID, "automatic-create").click()
            self.wait_for("return document.querySelector('#setup-dialog').open")
            after_setup = self.driver.execute_script(
                """
                return ['main', '.primary-tabs', '#automatic-start'].map((selector) => {
                  const rect = document.querySelector(selector).getBoundingClientRect();
                  return [rect.x, rect.y, rect.width, rect.height];
                });
                """
            )
            self.assertEqual(before_setup, after_setup)
            state = self.driver.execute_script(
                """
                const dialog = document.querySelector('#setup-dialog');
                const rect = dialog.getBoundingClientRect();
                return {
                  title: dialog.querySelector('h2').textContent,
                  workflows: dialog.querySelectorAll('input[name="setup-workflow"]').length,
                  sources: [...dialog.querySelectorAll('input[name="setup-pdf-mode"]')]
                    .map((node) => node.value),
                  markings: [...dialog.querySelectorAll('input[name="setup-highlight-style"]')]
                    .map((node) => node.value),
                  labels: [...dialog.querySelectorAll('.source-choice strong')]
                    .map((node) => node.textContent),
                  markingLabels: [...dialog.querySelectorAll('.setup-mark-options strong')]
                    .map((node) => node.textContent),
                  sourceVisible: document.querySelector('#setup-source-fieldset').offsetParent !== null,
                  markingVisible: document.querySelector('#setup-marking-fieldset').offsetParent !== null,
                  manualVisible: document.querySelector('#setup-manual-fieldset').offsetParent !== null,
                  rect: [rect.left, rect.top, rect.right, rect.bottom],
                  overflow: dialog.scrollWidth - dialog.clientWidth,
                };
                """
            )
            self.assertEqual(state["title"], "Setup")
            self.assertEqual(state["workflows"], 0)
            self.assertEqual(state["sources"], ["auto", "originals", "render"])
            self.assertEqual(state["markings"], ["margin", "sidelined", "paragraph", "text", "none"])
            self.assertEqual(
                state["labels"],
                [
                    "Use originals; rebuild missing sources",
                    "Use originals; add a page for missing sources",
                    "Rebuild all sources from text",
                ],
            )
            self.assertEqual(
                state["markingLabels"],
                [
                    "Right-margin marker + exact quote",
                    "Black paragraph line",
                    "Highlight the whole cited paragraph",
                    "Highlight exact quotes only",
                    "No passage marks",
                ],
            )
            self.assertTrue(state["sourceVisible"])
            self.assertTrue(state["markingVisible"])
            self.assertFalse(state["manualVisible"])
            self.assertGreaterEqual(state["rect"][0], 0)
            self.assertGreaterEqual(state["rect"][1], 0)
            self.assertLessEqual(state["rect"][2], 900)
            self.assertLessEqual(state["rect"][3], 760)
            self.assertLessEqual(state["overflow"], 1)
            choice_rects = self.driver.execute_script(
                """
                return [...document.querySelectorAll('.source-choice, .setup-mark-options .mark-option')].map((node) => {
                  const rect = node.getBoundingClientRect();
                  return [rect.x, rect.y, rect.width, rect.height];
                });
                """
            )
            self.driver.find_elements(
                By.CSS_SELECTOR, 'input[name="setup-pdf-mode"]'
            )[1].click()
            self.driver.find_elements(
                By.CSS_SELECTOR, 'input[name="setup-highlight-style"]'
            )[1].click()
            self.assertEqual(
                choice_rects,
                self.driver.execute_script(
                    """
                    return [...document.querySelectorAll('.source-choice, .setup-mark-options .mark-option')].map((node) => {
                      const rect = node.getBoundingClientRect();
                      return [rect.x, rect.y, rect.width, rect.height];
                    });
                    """
                ),
            )
            if screenshot_dir:
                (Path(screenshot_dir) / "toa-setup.png").write_bytes(
                    self.driver.get_screenshot_as_png()
                )
            self.driver.switch_to.active_element.send_keys(Keys.ESCAPE)
            self.wait_for("return !document.querySelector('#setup-dialog').open")

            self.driver.find_element(By.CSS_SELECTOR, '[data-view="manual"]').click()
            self.driver.find_element(By.ID, "manual-create").click()
            self.wait_for("return document.querySelector('#setup-dialog').open")
            self.assertFalse(
                self.driver.find_element(By.ID, "setup-source-fieldset").is_displayed()
            )
            self.assertTrue(
                self.driver.find_element(By.ID, "setup-manual-fieldset").is_displayed()
            )
            self.assertFalse(
                self.driver.find_element(By.ID, "setup-marking-fieldset").is_displayed()
            )
            self.driver.switch_to.active_element.send_keys(Keys.ESCAPE)

            self.driver.execute_cdp_cmd(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": 320,
                    "height": 844,
                    "deviceScaleFactor": 1,
                    "mobile": False,
                },
            )
            self.driver.find_element(By.CSS_SELECTOR, '[data-view="automatic"]').click()
            self.driver.find_element(By.ID, "automatic-create").click()
            self.wait_for("return document.querySelector('#setup-dialog').open")
            narrow = self.driver.execute_script(
                """
                const dialog = document.querySelector('#setup-dialog');
                const rect = dialog.getBoundingClientRect();
                return {
                  rect: [rect.left, rect.top, rect.right, rect.bottom],
                  overflow: dialog.scrollWidth - dialog.clientWidth,
                };
                """
            )
            self.assertGreaterEqual(narrow["rect"][0], 0)
            self.assertGreaterEqual(narrow["rect"][1], 0)
            self.assertLessEqual(narrow["rect"][2], 320)
            self.assertLessEqual(narrow["rect"][3], 844)
            self.assertLessEqual(narrow["overflow"], 1)
            if screenshot_dir:
                self.driver.execute_script(
                    "document.querySelector('#setup-marking-fieldset')"
                    ".scrollIntoView({block: 'center'})"
                )
                (Path(screenshot_dir) / "toa-setup-narrow.png").write_bytes(
                    self.driver.get_screenshot_as_png()
                )
            self.driver.find_element(
                By.CSS_SELECTOR, 'input[name="setup-highlight-style"][value="text"]'
            ).click()
            self.driver.find_element(By.ID, "setup-remember").click()
            self.driver.find_element(
                By.CSS_SELECTOR, '#setup-dialog button[value="continue"]'
            ).click()
            self.wait_for(
                "return !document.querySelector('#setup-dialog').open"
                " && document.querySelector('#build-card').offsetParent !== null"
            )
            saved = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["highlight_style"], "text")
            self.assertEqual(saved["setup_version"], 3)
            self.driver.execute_script("newSession(false)")
            self.driver.find_element(By.CSS_SELECTOR, '[data-view="manual"]').click()
            self.driver.find_element(By.ID, "manual-create").click()
            self.wait_for("return document.querySelector('#manual-build').offsetParent !== null")
            self.assertFalse(
                self.driver.find_element(By.ID, "setup-dialog").get_attribute("open")
            )
        finally:
            settings_path.write_text(json.dumps({"setup_version": 3}), encoding="utf-8")
            self.driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})

    def test_output_choice_keeps_controls_stable(self) -> None:
        all_settings = [
            "pdf_mode",
            "tab_style",
            "highlight_style",
            "scanned_pdf_policy",
            "table_delivery",
            "table_location",
        ]
        for width, height in ((1440, 900), (800, 500), (390, 844), (305, 640)):
            with self.subTest(width=width):
                self.driver.execute_cdp_cmd(
                    "Emulation.setDeviceMetricsOverride",
                    {
                        "width": width,
                        "height": height,
                        "deviceScaleFactor": 1,
                        "mobile": False,
                    },
                )
                self.driver.get(self.base)
                self.wait_for("return document.querySelector('#build-output_mode')")
                self.driver.find_element(By.ID, "automatic-create").click()
                self.wait_for(
                    "return document.querySelector('.build-options').offsetParent !== null"
                )
                stable_before = self.driver.execute_script(
                    """
                    return ['#build-card', '.workflow-primary', '.build-options summary']
                      .map((selector) => {
                      const rect = document.querySelector(selector).getBoundingClientRect();
                      return [rect.x, rect.y, rect.width, rect.height];
                    });
                    """
                )
                self.driver.find_element(By.CSS_SELECTOR, ".build-options summary").click()
                stable_after = self.driver.execute_script(
                    """
                    const summary = document.querySelector('.build-options summary');
                    const result = ['#build-card', '.workflow-primary', '.build-options summary']
                      .map((selector) => {
                      const rect = document.querySelector(selector).getBoundingClientRect();
                      return [rect.x, rect.y, rect.width, rect.height];
                    });
                    summary.focus();
                    const focus = summary.getBoundingClientRect();
                    return {result, focus: [focus.x, focus.y, focus.width, focus.height]};
                    """
                )
                self.assertEqual(stable_before, stable_after["result"])
                self.assertEqual(stable_before[2], stable_after["focus"])
                output = Select(self.driver.find_element(By.ID, "build-output_mode"))
                geometry = []
                for mode, enabled in (
                    ("book", all_settings[:4]),
                    ("table", all_settings[4:]),
                    ("both", all_settings),
                ):
                    output.select_by_value(mode)
                    state = self.driver.execute_script(
                        """
                        const card = document.querySelector('#build-card').getBoundingClientRect();
                        const controls = [...document.querySelectorAll('#build-settings select, #build-settings input')]
                          .filter((node) => node.offsetParent !== null);
                        const panel = document.querySelector('#build-settings');
                        const panelRect = panel.getBoundingClientRect();
                        const blocks = [...panel.querySelectorAll('.mark-option, select')]
                          .filter((node) => node.offsetParent !== null)
                          .map((node) => ({node, rect: node.getBoundingClientRect()}));
                        const overlap = blocks.some((first, index) =>
                          blocks.slice(index + 1).some((second) =>
                            !first.node.contains(second.node)
                            && !second.node.contains(first.node)
                            && Math.min(first.rect.right, second.rect.right)
                              - Math.max(first.rect.left, second.rect.left) > 0.5
                            && Math.min(first.rect.bottom, second.rect.bottom)
                              - Math.max(first.rect.top, second.rect.top) > 0.5
                          )
                        );
                        return {
                          card: [card.x, card.y, card.width, card.height],
                          enabled: [...new Set(controls.filter((node) => !node.disabled)
                            .map((node) => node.closest('[data-setting]').dataset.setting))],
                          selectSizes: controls.filter((node) => node.tagName === 'SELECT').map((node) => {
                            const rect = node.getBoundingClientRect();
                            return [rect.width, rect.height];
                          }),
                          radioSizes: controls.filter((node) => node.type === 'radio').map((node) => {
                            const rect = node.getBoundingClientRect();
                            return [rect.width, rect.height];
                          }),
                          markOptions: document.querySelectorAll('#build-settings .mark-option').length,
                          overlap,
                          panelOverflowX: panel.scrollWidth - panel.clientWidth,
                          panelOverflowY: getComputedStyle(panel).overflowY,
                          panelBounds: [panelRect.left, panelRect.right,
                            document.documentElement.clientWidth],
                          wrappedLabels: [...panel.querySelectorAll(
                            '.setting-field[data-value-label]'
                          )].every((field) =>
                            getComputedStyle(field, '::after').content
                              .includes(field.dataset.valueLabel)
                          ),
                          overflow: Math.max(
                            document.documentElement.scrollWidth - document.documentElement.clientWidth,
                            document.body.scrollWidth - document.body.clientWidth,
                            document.querySelector('#automatic').scrollWidth
                              - document.querySelector('#automatic').clientWidth,
                            document.querySelector('#build-card').scrollWidth
                              - document.querySelector('#build-card').clientWidth,
                            0,
                          ),
                        };
                        """
                    )
                    self.assertEqual(state["enabled"], enabled)
                    self.assertTrue(
                        all(size[0] > 0 and 40 <= size[1] <= (56 if width <= 480 else 44)
                            for size in state["selectSizes"]),
                        state,
                    )
                    self.assertTrue(
                        all(16 <= size[0] <= 18 and 16 <= size[1] <= 18 for size in state["radioSizes"]),
                        state,
                    )
                    self.assertEqual(state["markOptions"], 5)
                    self.assertFalse(state["overlap"], state)
                    self.assertLessEqual(state["panelOverflowX"], 1, state)
                    self.assertEqual(state["panelOverflowY"], "auto")
                    self.assertGreaterEqual(state["panelBounds"][0], -1, state)
                    self.assertLessEqual(
                        state["panelBounds"][1], state["panelBounds"][2] + 1, state
                    )
                    if width <= 480:
                        self.assertTrue(state["wrappedLabels"], state)
                    self.assertLessEqual(state["overflow"], 1, state)
                    geometry.append(state["card"])
                self.assertTrue(all(rect == geometry[0] for rect in geometry), geometry)
                screenshot_dir = os.environ.get("TOA_SCREENSHOT_DIR")
                if screenshot_dir and width in {1440, 390}:
                    self.driver.execute_script(
                        "document.querySelector('[data-setting=\"highlight_style\"]').scrollIntoView({block: 'center'})"
                    )
                    name = "desktop" if width == 1440 else "narrow"
                    (Path(screenshot_dir) / f"toa-mark-options-{name}.png").write_bytes(
                        self.driver.get_screenshot_as_png()
                    )
        self.driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})


if __name__ == "__main__":
    unittest.main()
