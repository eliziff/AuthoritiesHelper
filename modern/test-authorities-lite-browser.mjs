import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium, expect} from '@playwright/test';
import {PDFDocument, PDFName, PDFDict} from 'pdf-lib';
import fs from 'node:fs/promises';
const target=Number(process.env.LITE_TEST_PAGE)||37;
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
page.setDefaultTimeout(30000);
page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
page.on('console',m=>{if(m.type()==='error')console.error(m.text());if(m.text().includes('fake worker'))errors.push(m.text());});
let server;
try {
  let url=/^https?:\/\//.test(process.argv[2]) ? process.argv[2] : pathToFileURL(path.resolve(process.argv[2])).href;
  if(process.env.LITE_HOSTED==='1'){
    const html=await fs.readFile(process.argv[2]);
    server=createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end(html);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${server.address().port}/`;
  }
  await page.goto(url);
  await page.getByRole('textbox',{name:'List of citations'}).fill(process.env.LITE_TEST_CITATION || '2011 SCC 58 at para 83');
  const chooser=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'Upload',exact:true}).click();
  await (await chooser).setFiles(path.resolve(process.argv[3]));
  await page.getByRole('button',{name:'Review',exact:true}).click({timeout:90000});
  await expect(page.locator('#page-wrap .pdf-page canvas').first()).toBeVisible({timeout:30000});
  assert(await page.locator('#page-scroll').evaluate(e=>e.clientHeight)>500);
  await page.getByLabel('PDF page',{exact:true}).fill(String(target));await page.getByLabel('PDF page',{exact:true}).press('Enter');
  await expect(page.locator(`#page-wrap .pdf-page[data-page="${target}"] canvas`)).toBeVisible({timeout:30000});
  await expect(page.locator(`#page-wrap .pdf-page[data-page="${target}"] .textLayer`)).toBeVisible();
  if(process.env.LITE_TEST_PRINTED){
    await expect(page.getByLabel('Printed page',{exact:true})).toHaveValue(process.env.LITE_TEST_PRINTED);
    await page.getByLabel('PDF page',{exact:true}).fill('1');
    await page.getByLabel('PDF page',{exact:true}).press('Enter');
    await page.getByLabel('Printed page',{exact:true}).fill(process.env.LITE_TEST_PRINTED);
    await page.getByLabel('Printed page',{exact:true}).press('Enter');
    await expect(page.getByLabel('PDF page',{exact:true})).toHaveValue(String(target));
  }
  const count=await page.locator('#highlight-list .highlight-row').count();
  await page.locator(`#page-wrap .pdf-page[data-page="${target}"] .textLayer span`).first().evaluate(span=>{
    const range=document.createRange();range.selectNodeContents(span);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  });
  await page.locator('#selection-highlight').click();
  await expect(page.locator('#highlight-list .highlight-row')).toHaveCount(count+1);
  const before=count+1;
  await page.locator('#area-highlight').click();
  const bounds=await page.locator(`#page-wrap .pdf-page[data-page="${target}"]`).boundingBox();
  await page.mouse.move(bounds.x+90,Math.max(bounds.y,0)+150);await page.mouse.down();
  await page.mouse.move(bounds.x+350,Math.max(bounds.y,0)+185,{steps:5});await page.mouse.up();
  await expect(page.locator('#highlight-list .highlight-row')).toHaveCount(before+1);
  await page.locator('#undo').click();await expect(page.locator('#highlight-list .highlight-row')).toHaveCount(before);
  await page.locator('#redo').click();await expect(page.locator('#highlight-list .highlight-row')).toHaveCount(before+1);
  const download=page.waitForEvent('download');await page.locator('#viewer-download').click();
  const output=await PDFDocument.load(await fs.readFile(await (await download).path()));
  assert(output.getPage(target-1).node.Annots()?.asArray().some(ref=>output.context.lookup(ref,PDFDict).get(PDFName.of('Subtype'))?.toString()==='/Highlight'));
  for(const ref of output.getPage(target-1).node.Annots()?.asArray() ?? []) {
    const mark=output.context.lookup(ref,PDFDict);
    assert(!mark.has(PDFName.of('T')) && !mark.has(PDFName.of('Contents')),'Lite omits author and comment metadata');
  }
  await page.screenshot({path:path.resolve(process.argv[4]||'lite-pdf-smoke.png')});
  await page.locator('#close-viewer').click();await page.getByRole('button',{name:'Review',exact:true}).click();
  await expect(page.locator('#page-wrap .pdf-page canvas').first()).toBeVisible();
  if(process.env.LITE_TEST_PRINTED){
    await page.getByLabel('Printed page',{exact:true}).fill(process.env.LITE_TEST_PRINTED);
    await page.getByLabel('Printed page',{exact:true}).press('Enter');
    await expect(page.getByLabel('PDF page',{exact:true})).toHaveValue(String(target));
  }
  assert.deepEqual(errors,[]);
  await page.locator('#close-viewer').click();
  for(const citation of ['2021 SCC 1']) {
    await page.getByRole('textbox',{name:'List of citations'}).fill(citation);
    const chooseWrong=page.waitForEvent('filechooser');
    await page.getByRole('button',{name:'Upload',exact:true}).click();
    await (await chooseWrong).setFiles(path.resolve(process.argv[3]));
    await expect(page.getByRole('button',{name:'Review',exact:true})).toHaveCount(1);
    await expect(page.getByRole('status')).not.toContainText('Wrong PDF');
  }
  await page.getByRole('textbox',{name:'List of citations'}).fill('2020 SCC 2');
  await expect(page.getByRole('button',{name:'Review',exact:true})).toHaveCount(0);
  const chooseUnmatched=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:/Click or drag to add PDFs/}).click();
  await (await chooseUnmatched).setFiles({name:'unmatched-upload.pdf',mimeType:'application/pdf',buffer:await fs.readFile(process.argv[3])});
  await expect(page.getByRole('button',{name:'Review',exact:true})).toHaveCount(1);
  await expect(page.getByText('unmatched-upload',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Review',exact:true}).click();
  await expect(page.locator('#page-wrap .pdf-page canvas').first()).toBeVisible();
  console.log('PASS: Lite native viewer, navigation, highlights, undo/redo, annotated export, close/reopen, real PDF worker.');
} catch(error) {
  await page.screenshot({path:path.resolve(process.argv[4]||'lite-pdf-smoke.png')});
  console.error((await page.locator('body').innerText()).slice(0,1800));
  throw error;
} finally {await browser.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
