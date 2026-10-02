import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acquirePdf} from './network.mjs';

const source = 'https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/1204/index.do';
for (const status of [200, 403, 302]) test(`publisher verification survives HTTP ${status}`, async () => {
  const fetcher = async () => status === 302
    ? new Response(null, {status, headers: {Location: '/robocop/captcha/en/query.do'}})
    : new Response('<iframe src="/robocop/captcha/en/query.do"></iframe>', {status, headers: {'Content-Type': 'text/html'}});
  await assert.rejects(acquirePdf(source, fetcher), {code: 'verification_required'});
  const result = await acquirePdf(source, async () => new Response('%PDF-1.7 original', {headers: {'Content-Type': 'application/pdf'}}));
  assert.equal(await new Response(result.body).text(), '%PDF-1.7 original');
});
test('ordinary forbidden responses are not reported as CAPTCHA', async () => {
  await assert.rejects(acquirePdf(source, async () => new Response('Forbidden', {status: 403})), {code: 'publisher_http'});
});
test('Decisia original needs only its direct PDF request', async () => {
  const calls=[];
  const result=await acquirePdf(source,async url=>{calls.push(url);return new Response('%PDF-1.7 original',{headers:{'Content-Type':'application/pdf'}});});
  assert.equal(await new Response(result.body).text(),'%PDF-1.7 original');
  assert.deepEqual(calls,['https://decisions.scc-csc.ca/scc-csc/scc-csc/en/1204/1/document.do']);
});
test('missing direct PDF retains publisher discovery', async () => {
  const calls=[];
  const result=await acquirePdf(source,async url=>{
    calls.push(url);
    if(url.endsWith('/1204/1/document.do'))return new Response('',{status:404});
    if(url===source)return new Response('<li class="documents"><a href="/scc-csc/scc-csc/en/1204/2/document.do">PDF</a></li>',{headers:{'Content-Type':'text/html'}});
    return new Response('%PDF-1.7 alternate',{headers:{'Content-Type':'application/pdf'}});
  });
  assert.equal(await new Response(result.body).text(),'%PDF-1.7 alternate');
  assert.equal(calls.length,3);
});
test('a challenge on a guessed PDF does not invent a PDF when the decision has no PDF control', async () => {
  const calls=[];
  await assert.rejects(acquirePdf(source,async url=>{
    calls.push(url);
    if(url.endsWith('/1204/1/document.do'))return new Response('<iframe src="/robocop/captcha/en/query.do"></iframe>',{status:403,headers:{'Content-Type':'text/html'}});
    return new Response('<div class="documents"></div>',{headers:{'Content-Type':'text/html'}});
  }),{code:'pdf_not_found'});
  assert.equal(calls.length,3);
});
test('a confirmed PDF control exposes the exact challenge URL', async () => {
  await assert.rejects(acquirePdf(source,async url=>url.endsWith('/1204/1/document.do')
    ? new Response('<iframe src="/robocop/captcha/en/query.do"></iframe>',{status:403,headers:{'Content-Type':'text/html'}})
    : new Response('<li class="documents"><a href="/scc-csc/scc-csc/en/1204/1/document.do">PDF</a></li>',{headers:{'Content-Type':'text/html'}})),
  {code:'verification_required',verificationUrl:'https://decisions.scc-csc.ca/robocop/captcha/en/query.do',pdfUrl:source.replace('/item/1204/index.do','/1204/1/document.do')});
});
test('an incidental CAPTCHA script on a readable case preserves the guessed PDF challenge URL', async () => {
  const exact='https://decisions.scc-csc.ca/robocop/captcha/fr/query.do?token=pdf';
  await assert.rejects(acquirePdf(source,async url=>url.endsWith('/1204/1/document.do')
    ? new Response(`<iframe src="${exact}"></iframe>`,{status:403,headers:{'Content-Type':'text/html'}})
    : new Response('<script src="/robocop/captcha/en/loader.js"></script><li class="documents"><a href="/scc-csc/scc-csc/en/1204/1/document.do">PDF</a></li>',{headers:{'Content-Type':'text/html'}})),
  {code:'verification_required',verificationUrl:exact});
});
test('an incidental CAPTCHA script does not turn a case without a PDF into a challenge', async () => {
  await assert.rejects(acquirePdf(source,async url=>url.endsWith('/1204/1/document.do')
    ? new Response('',{status:404})
    : new Response('<script src="/robocop/captcha/en/loader.js"></script><div class="documents"></div>',{headers:{'Content-Type':'text/html'}})),
  {code:'pdf_not_found'});
});

test('Decisia decision-content CAPTCHA opens its exact visible iframe', async () => {
  const decision='https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/14385/index.do';
  const content=`${decision}?iframe=true`;
  const calls=[];
  await assert.rejects(acquirePdf(decision,async url=>{
    calls.push(url);
    if(url.endsWith('/14385/1/document.do'))return new Response('<iframe src="/robocop/captcha/en/query.do"></iframe>',
      {status:403,headers:{'Content-Type':'text/html'}});
    if(url===decision)return new Response('<script src="/robocop/captcha/en/loader.js"></script>'+
      '<iframe src="/scc-csc/scc-csc/en/item/14385/index.do?iframe=true"></iframe>',
      {headers:{'Content-Type':'text/html'}});
    if(url===content)return new Response('<title>Validation</title><div style="padding-top:10px" id="captchaForm">\n'+
      '<form action="/robocop/captcha/eval.do" target="_parent"><img id="captchaTag"></form></div>',
      {status:403,headers:{'Content-Type':'text/html'}});
    throw new Error(`Unexpected request: ${url}`);
  }),{code:'verification_required',verificationUrl:content});
  assert.deepEqual(calls,[
    'https://decisions.scc-csc.ca/scc-csc/scc-csc/en/14385/1/document.do',decision,content]);
});
