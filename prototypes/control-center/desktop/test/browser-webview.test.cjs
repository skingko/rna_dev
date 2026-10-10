const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{readFileSync}=require('node:fs'),{join}=require('node:path');
const{PARTITION,OPEN_URL,OPEN_EXTERNAL,OPEN_DEVTOOLS,httpUrl,guestUrl,hardenWebview,installBrowserWebviews,installBrowserBridge}=require('../browser-webview.cjs');
const origin='http://127.0.0.1:4999';
function fakeWindow(){const contents=new EventEmitter();contents.sent=[];contents.send=(channel,value)=>contents.sent.push([channel,value]);contents.mainFrame={url:`${origin}/`};return{webContents:contents,isDestroyed:()=>false};}
function fakeIpc(){const handlers=new Map();return{handlers,handle:(channel,fn)=>{if(handlers.has(channel))throw new Error('duplicate');handlers.set(channel,fn);},removeHandler:channel=>handlers.delete(channel)};}
test('URL validation: only http/https (no credentials) open externally; guests also allow about:blank',()=>{
  for(const url of['https://example.com/a?b#c','http://127.0.0.1:5173/'])assert.ok(httpUrl(url),url);
  for(const url of['file:///etc/passwd','javascript:alert(1)','data:text/html,x','chrome://settings','https://user:pw@example.com/','about:blank','',null,42,'x'.repeat(9000)])assert.equal(httpUrl(url),null,String(url).slice(0,40));
  assert.equal(guestUrl('about:blank'),'about:blank');assert.equal(guestUrl('file:///tmp/x'),null);});
test('will-attach-webview strips preload/node integration, forces isolation, sandbox and the browser partition',()=>{
  const prefs={preload:'/evil.js',preloadURL:'file:///evil.js',nodeIntegration:true,nodeIntegrationInSubFrames:true,contextIsolation:false,sandbox:false,webSecurity:false,enableBlinkFeatures:'X',allowRunningInsecureContent:true};
  const params={src:'https://example.com/',preload:'file:///evil.js',nodeintegration:'true',nodeintegrationinsubframes:'true',disablewebsecurity:'true',webpreferences:'nodeIntegration=yes',partition:'persist:app'};
  assert.equal(hardenWebview(prefs,params),true);
  assert.equal(prefs.preload,undefined);assert.equal(prefs.preloadURL,undefined);assert.equal(prefs.enableBlinkFeatures,undefined);
  assert.deepEqual([prefs.nodeIntegration,prefs.nodeIntegrationInSubFrames,prefs.contextIsolation,prefs.sandbox,prefs.webSecurity,prefs.allowRunningInsecureContent,prefs.webviewTag,prefs.partition],[false,false,true,true,true,false,false,PARTITION]);
  assert.deepEqual(params,{src:'https://example.com/',partition:PARTITION,allowpopups:'true'});
  assert.equal(hardenWebview({},{src:'file:///etc/passwd'}),false);assert.equal(hardenWebview({},{}),true,'empty src is about:blank');});
test('attach handlers refuse bad sources, deny popups as windows and route them to a browser tab',()=>{
  const window=fakeWindow(),permissions={};const session={fromPartition:name=>{assert.equal(name,PARTITION);return{setPermissionRequestHandler:fn=>permissions.request=fn,setPermissionCheckHandler:fn=>permissions.check=fn};}};
  const dispose=installBrowserWebviews({window,session,logger:{warn(){}}});
  let prevented=false;window.webContents.emit('will-attach-webview',{preventDefault:()=>{prevented=true;}},{},{src:'file:///etc/passwd'});assert.equal(prevented,true);
  const guest=new EventEmitter();guest.id=42;guest.setWindowOpenHandler=fn=>{guest.open=fn;};window.webContents.emit('did-attach-webview',{},guest);
  assert.deepEqual(guest.open({url:'https://example.com/x',disposition:'foreground-tab'}),{action:'deny'});
  assert.deepEqual(window.webContents.sent,[[OPEN_URL,{url:'https://example.com/x',disposition:'foreground-tab',sourceWebContentsId:42}]]);
  assert.deepEqual(guest.open({url:'file:///etc/passwd',disposition:'new-window'}),{action:'deny'});assert.equal(window.webContents.sent.length,1);
  let blocked=0;guest.emit('will-navigate',{preventDefault:()=>blocked++},'file:///etc/passwd');guest.emit('will-redirect',{preventDefault:()=>blocked++},'https://ok.example/');guest.emit('will-attach-webview',{preventDefault:()=>blocked++});assert.equal(blocked,2);
  const answers=[];permissions.request(null,'media',value=>answers.push(value));permissions.request(null,'fullscreen',value=>answers.push(value));assert.deepEqual(answers,[false,true]);assert.equal(permissions.check(null,'geolocation'),false);
  dispose();assert.equal(window.webContents.listenerCount('will-attach-webview'),0);});
test('bridge: openExternal validates URLs and sender; openDevTools only targets this window\'s webview guests',async()=>{
  const window=fakeWindow(),ipcMain=fakeIpc(),opened=[],devtools=[];
  const guest={isDestroyed:()=>false,getType:()=>'webview',hostWebContents:window.webContents,openDevTools:options=>devtools.push(options)},other={...guest,hostWebContents:{}},page={...guest,getType:()=>'window'};
  const webContents={fromId:id=>({1:guest,2:other,3:page})[id]??null};
  const dispose=installBrowserBridge({ipcMain,shell:{openExternal:async url=>opened.push(url)},window,origin,webContents});
  installBrowserBridge({ipcMain,shell:{openExternal:async()=>{}},window,origin,webContents});// reconnect replaces handlers
  const own={sender:window.webContents,senderFrame:window.webContents.mainFrame},foreign={sender:{},senderFrame:{url:'https://evil.example/'}};
  assert.deepEqual(await ipcMain.handlers.get(OPEN_EXTERNAL)(own,'https://example.com/'),{opened:true});
  await assert.rejects(ipcMain.handlers.get(OPEN_EXTERNAL)(own,'file:///etc/passwd'));await assert.rejects(ipcMain.handlers.get(OPEN_EXTERNAL)(foreign,'https://example.com/'));
  assert.deepEqual(ipcMain.handlers.get(OPEN_DEVTOOLS)(own,1),{opened:true});assert.deepEqual(devtools,[{mode:'detach'}]);
  for(const id of[2,3,99,'1'])assert.throws(()=>ipcMain.handlers.get(OPEN_DEVTOOLS)(own,id));
  assert.throws(()=>ipcMain.handlers.get(OPEN_DEVTOOLS)(foreign,1));
  dispose();assert.equal(ipcMain.handlers.size,0);});
test('main window enables webviewTag and preload exposes the browser bridge',()=>{
  const main=readFileSync(join(__dirname,'../main.cjs'),'utf8'),preload=readFileSync(join(__dirname,'../preload.cjs'),'utf8'),build=readFileSync(join(__dirname,'../build.mjs'),'utf8');
  assert.match(main,/webviewTag: true/);assert.match(main,/installBrowserWebviews\(/);assert.match(main,/installBrowserBridge\(/);
  assert.match(preload,/browser: Object\.freeze\(\{ openExternal:/);assert.match(preload,/capabilities: Object\.freeze\(\{ webview: true \}\)/);assert.match(preload,/'rna:browser-open-url'/);
  assert.match(build,/'browser-webview\.cjs'/);});
