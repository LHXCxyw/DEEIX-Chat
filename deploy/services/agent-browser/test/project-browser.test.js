import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { validateRequest, validateActions, validPath, serveManifest, runProjectBrowser } from '../src/project-browser.js';

function request() {
  const files = [['index.html', '<script src="app.js"></script>'], ['app.js', 'document.body.textContent="ok"'], ['style.css', 'body{color:red}'], ['a.png', 'image']].sort((a,b) => a[0] < b[0] ? -1 : 1).map(([path,text]) => ({path,data:Buffer.from(text).toString('base64'),sha256:createHash('sha256').update(text).digest('hex')}));
  return {protocol:1,entry:'index.html',files,actions:[{type:'click',selector:'button'},{type:'fill',selector:'input',value:'hi'},{type:'press',selector:'input',key:'Enter'},{type:'wait',selector:'p'},{type:'dom'}],snapshot_hash:createHash('sha256').update(files.map(f => `${f.path}\0${f.sha256}\n`).join('')).digest('hex')};
}
test('多文件 hash 与动作严格校验', () => {
  assert.equal(validateRequest(request()).size,4);
  for(const path of ['../a.html','/a.html','a//b.js','a%2fb.js','a\\b.js','.env','a.txt','a/./b.js']) assert.equal(validPath(path),false,path);
  for(const action of [{type:'evaluate',script:'1'}, {type:'click',selector:'a',extra:true}, {type:'press',selector:'a',key:'Control+L'}, {type:'wait',selector:'a',timeout:99999}]) assert.throws(()=>validateActions([action]));
  const r=request(); r.files[0].sha256='bad';assert.throws(()=>validateRequest(r));
  const duplicate=request();duplicate.files.push(duplicate.files[0]);assert.throws(()=>validateRequest(duplicate));
});
function get(origin,path,headers={}) {
  return new Promise((resolve,reject) => { const req=http.get(origin,{path,headers},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));});req.on('error',reject); });
}
test('资源仅由 manifest 内存提供，拒绝编码穿越、跨源和未知路径',async()=>{
 const server=await serveManifest(validateRequest(request()));
 try {
  const ok=await get(server.origin,'/app.js');assert.equal(ok.status,200);assert.match(ok.headers['content-security-policy'],/connect-src 'none'/);
  for(const name of ['/missing.js','/../index.html','/%2e%2e/index.html','//index.html','/app.js?x=1','/app.js%00']) assert.equal((await get(server.origin,name)).status,403,name);
  assert.equal((await get(server.origin,'/index.html',{Origin:'https://evil.test'})).status,403);
  assert.equal((await get(server.origin,'/index.html',{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await get(server.origin,'/index.html',{Host:'evil.test'})).status,403);
 } finally {await server.close();}
});
test('清理异常不覆盖上下文初始化的原始错误', async () => {
 const knownError = new Error('known-context-error');
 await assert.rejects(runProjectBrowser(request(), async () => ({
  newContext: async () => { throw knownError; },
  close: async () => { throw new Error('cleanup-error'); },
 })), error => error === knownError);
});

test('fake 执行固定动作、有界摘要与错误，始终关闭浏览器',async()=>{
 let closed=false;const calls=[];const handlers={};
 const locator={click:async()=>calls.push('click'),fill:async()=>calls.push('fill'),press:async()=>calls.push('press'),waitFor:async()=>calls.push('wait'),count:async()=>1,nth(){return this;},innerText:async()=> 'ok',evaluateAll:async fn=>fn([{textContent:'ok'}])};
 const page={on:(event,fn)=>{handlers[event]=fn;},goto:async url=>{page.current=url;handlers.console({type:()=> 'error',text:()=> 'untrusted'});},url:()=>page.current,locator:()=>locator};
 const context={setDefaultTimeout(){},setDefaultNavigationTimeout(){},routeWebSocket:async()=>{},route:async()=>{},newPage:async()=>page};
 const result=await runProjectBrowser(request(),async()=>({newContext:async options=>{assert.equal(options.javaScriptEnabled,true);return context;},close:async()=>{closed=true;}}));
 assert.deepEqual(calls,['click','fill','press','wait']);assert.deepEqual(result.dom,[{text:'ok'}]);assert.deepEqual(result.console_errors,['untrusted']);assert.equal(closed,true);
});
