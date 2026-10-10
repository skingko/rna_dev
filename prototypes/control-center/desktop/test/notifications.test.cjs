const test=require('node:test'),assert=require('node:assert/strict');
const{installNotifications,parseEvents}=require('../notifications.cjs');
const frames=text=>new ReadableStream({start(controller){for(const part of text)controller.enqueue(new TextEncoder().encode(part));controller.close();}});
function fakeNotification(shown){return class{static isSupported(){return true;}constructor(options){this.options=options;this.handlers={};}on(event,handler){this.handlers[event]=handler;}show(){shown.push(this);}};}
test('SSE parser keeps partial frames and reads event, id and multi-line data',()=>{const first=parseEvents('id: 7\nevent: notify\ndata: {"a":\ndata: 1}\n\n: hb\n\nevent: ind');assert.deepEqual(first.events,[{event:'notify',id:'7',data:'{"a":\n1}'}]);assert.equal(first.rest,'event: ind');});
test('only notify events become native notifications; click reports the project target',async()=>{const shown=[],opened=[];let calls=0;
  const request=async(url,options)=>{calls++;assert.equal(url,'http://127.0.0.1:4999/api/v2/stream');if(calls>1)return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))));
    return new Response(frames(['event: hello\ndata: {"protocol":2}\n\n','id: 1\nevent: index\ndata: {}\n\nid: 2\nevent: notify\ndata: {"projectId":"p1","entryId":"e1","sessionId":"s1","title":"Proj","body":"Found the missing case."}\n','\nevent: notify\ndata: not-json\n\n']),{status:200});};
  const stop=installNotifications({Notification:fakeNotification(shown),origin:'http://127.0.0.1:4999',fetch:request,onOpen:target=>opened.push(target),retryMs:1,wait:()=>Promise.resolve()});
  while(calls<2)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(shown.length,1);assert.equal(shown[0].options.title,'Proj');assert.equal(shown[0].options.body,'Found the missing case.');
  shown[0].handlers.click();assert.deepEqual(opened,[{projectId:'p1',entryId:'e1',sessionId:'s1'}]);
  await stop();});
test('unsupported platforms install nothing and make no request',()=>{let calls=0;const stop=installNotifications({Notification:class{static isSupported(){return false;}},origin:'http://127.0.0.1:1',fetch:async()=>{calls++;}});stop();assert.equal(calls,0);});
