import {chromium} from 'playwright';
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});const ctx=await b.newContext();
await ctx.addInitScript(()=>Object.defineProperty(window,'showOpenFilePicker',{value:undefined,configurable:true}));
const pg=await ctx.newPage();const logs=[];pg.on('pageerror',e=>logs.push('PAGEERROR '+e.message));
ctx.on('requestfailed',r=>logs.push('FAILED '+r.url().slice(0,100)+' '+r.failure()?.errorText));
await pg.goto(process.argv[2]);console.log('page', pg.url());
const ch=pg.waitForEvent('filechooser');await pg.getByRole('button',{name:'Add file',exact:true}).click();await (await ch).setFiles('/tmp/wt/factum.docx');
await pg.waitForTimeout(2000);const dlg=pg.getByRole('dialog',{name:'Import options'});if(await dlg.isVisible())await dlg.getByRole('button',{name:'Import and review',exact:true}).click();
await pg.waitForTimeout(6000);console.log(logs.filter(l=>!l.includes('a2aj')).join('\n'));console.log('BODY:',(await pg.innerText('body')).replace(/\n+/g,' | ').slice(0,300));await b.close();
