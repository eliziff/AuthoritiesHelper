// Authority Linker from file://, in both link modes: a body citation with a paragraph range and a statute's sections,
// and footnotes with a quotation and an ibid. Checks the copy keeps its text, emphasis and existing link, links each
// written pinpoint on its own (41 and 43 of 41–43), puts a quotation's fragment on the lead pinpoint only, fits a phone
// screen and makes no network request.
//   node test-authority-linker-browser.mjs "out/Authority Linker.html" [out-dir]
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const require = createRequire(path.join(import.meta.dirname, "../../package.json"));
const { chromium } = require("@playwright/test");
const JSZip = require("jszip");
const [html, out = path.join(tmpdir(), "authority-linker-test")] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const zip = async (parts) => { const archive = new JSZip(); for (const [name, text] of Object.entries(parts)) archive.file(name, text);
  return archive.generateAsync({ type: "nodebuffer" }); };
const unzip = async (bytes) => { const archive = await JSZip.loadAsync(bytes), parts = {};
  for (const [name, file] of Object.entries(archive.files)) if (!file.dir) parts[name] = await file.async("string"); return parts; };
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (body) => `<w:p>${body}</w:p>`;
const r = (text, props = "") => `<w:r>${props}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const types = (notes) => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${notes ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : ""}</Types>`;
const root = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const rels = (body) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;

const bodyFile = path.join(out, "citations.docx");
const expectedBody = "The test states “A useful quoted sentence”. 2018 SCC 31 at paras 41–43. Criminal Code, RSC 1985, c C-46, ss 8(2), 9. See also existing link.";
writeFileSync(bodyFile, await zip({ "[Content_Types].xml": types(false), "_rels/.rels": root,
  "word/_rels/document.xml.rels": rels('<Relationship Id="rIdOriginal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/original" TargetMode="External"/>'),
  "word/document.xml": `<?xml version="1.0"?><w:document ${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${p(
    r("The test states “A useful quoted sentence”. ") + r("2018 SCC 31", "<w:rPr><w:i/></w:rPr>") +
    r(" at paras 41–43. Criminal Code, RSC 1985, c C-46, ss 8(2), 9. See also ") +
    '<w:hyperlink r:id="rIdOriginal">' + r("existing link") + "</w:hyperlink>" + r("."))}<w:sectPr/></w:body></w:document>` }));
const notesFile = path.join(out, "footnotes.docx");
writeFileSync(notesFile, await zip({ "[Content_Types].xml": types(true), "_rels/.rels": root,
  "word/_rels/document.xml.rels": rels('<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>'),
  "word/document.xml": `<w:document ${W}><w:body>${p(r("The court describes “An invented quoted passage”.") + '<w:r><w:footnoteReference w:id="1"/></w:r>')}${p(r("The next reference.") + '<w:r><w:footnoteReference w:id="2"/></w:r>')}<w:sectPr/></w:body></w:document>`,
  "word/footnotes.xml": `<w:footnotes ${W}><w:footnote w:id="1">${p('<w:r><w:footnoteRef/></w:r>' + r(" 2018 SCC 31 at paras 41–43."))}</w:footnote><w:footnote w:id="2">${p('<w:r><w:footnoteRef/></w:r>' + r(" Ibid at para 46."))}</w:footnote></w:footnotes>` }));

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } })).newPage();
const errors = [], requests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => { if (/^https?:/u.test(request.url())) requests.push(request.url()); });
const link = async (file, mode) => {
  if (await page.getByRole("button", { name: "Remove file" }).count()) await page.getByRole("button", { name: "Remove file" }).click();
  await page.getByLabel("Word document").setInputFiles(file);
  await page.getByLabel(mode).check();
  await page.getByRole("button", { name: "Add hyperlinks", exact: true }).click();
  const anchor = page.getByRole("link", { name: "Download linked copy" });
  await anchor.waitFor({ timeout: 120000 });
  const [download] = await Promise.all([page.waitForEvent("download"), anchor.click()]);
  const saved = path.join(out, `${path.basename(file, ".docx")}-${mode === "Pinpoint only" ? "pinpoint" : "fragment"}.docx`);
  await download.saveAs(saved);
  return { parts: await unzip(readFileSync(saved)), status: await page.getByRole("heading", { name: "Linked copy" }).locator("..").innerText() };
};
try {
  await page.goto(pathToFileURL(path.resolve(html)).href);
  await page.getByRole("heading", { name: "Authority Linker" }).waitFor();
  await page.screenshot({ path: path.join(out, "page.png") });
  for (const mode of ["Pinpoint only", "Pinpoint + quoted text"]) {
    const { parts, status } = await link(bodyFile, mode);
    const body = parts["word/document.xml"], links = parts["word/_rels/document.xml.rels"];
    assert.equal([...body.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/gs)].map((match) => match[1]).join(""), expectedBody);
    assert.match(body, /<w:i(?:\s[^>]*)?(?:\s*\/|><\/w:i)>/u);
    assert.match(links, /https:\/\/example\.org\/original/u);
    for (const anchor of ["#par41", "#par43", "#sec8subsec2", "#sec9"]) assert.ok(links.includes(anchor), `Missing ${anchor}: ${links}`);
    assert.match(body, /<w:t[^>]*>41<\/w:t>/u); assert.match(body, /<w:t[^>]*>43<\/w:t>/u);
    if (mode === "Pinpoint only") assert.ok(!links.includes(":~:text="));
    else { assert.ok(links.includes("#par41:~:text=A%20useful%20quoted%20sentence")); assert.ok(!links.includes("#par43:~:")); }
    console.log(`${mode}: ${status.replace(/\s+/g, " ")}`);
  }
  await page.screenshot({ path: path.join(out, "linked.png") });
  const { parts } = await link(notesFile, "Pinpoint + quoted text");
  const noteLinks = parts["word/_rels/footnotes.xml.rels"];
  assert.ok(noteLinks.includes("#par41:~:text=An%20invented%20quoted%20passage"));
  assert.ok(noteLinks.includes("#par43") && noteLinks.includes("#par46"));
  assert.ok(!noteLinks.includes("#par43:~:") && !noteLinks.includes("#par46:~:"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, "phone.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(requests, []); assert.deepEqual(errors, []);
  console.log("PASS: both modes, each pinpoint of a range, sections, a quotation's fragment on its lead pinpoint, footnotes and ibid, the copy's text, emphasis and links, a phone screen and no network request.");
} finally { await browser.close(); }
