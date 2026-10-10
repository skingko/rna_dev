import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const journalURL = new URL('../src/journal.mjs', import.meta.url).href;
const sessionURL = new URL('../src/session.mjs', import.meta.url).href;
const model = { providerId: 'test', modelId: 'fixture', protocol: 'openai', contextWindow: 32000, maxOutputTokens: 1000 };
async function child(t, source) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-journal-batch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', value => { stdout += value; }); process.stderr.on('data', value => { stderr += value; });
  const result = await new Promise((resolve, reject) => { process.once('error', reject); process.once('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(result.code, 0, stderr); assert.equal(result.signal, null, stderr);
  return JSON.parse(stdout);
}
const instrument = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const sync=fs.fsyncSync, writes=fs.writeSync, barriers=[], sizes=new Map();
const sleeper=new Int32Array(new SharedArrayBuffer(4));
fs.fsyncSync=fd=>{Atomics.wait(sleeper,0,0,12);sync(fd);const bytes=fs.fstatSync(fd).size;barriers.push({fd,bytes});sizes.set(fd,bytes);};
syncBuiltinESMExports();
const {openJournal,digest}=await import(${JSON.stringify(journalURL)});
const rows=file=>fs.readFileSync(file,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
function verify(records){let prior=null;for(const [index,row]of records.entries()){const{hash,...body}=row;assert.equal(body.seq,index+1);assert.equal(body.prevHash,prior);assert.equal(hash,digest(body));prior=hash;}}
`;

test('slow actual fsync is independent of stream event count; bounded writes and canonical barriers retain the full hash chain', { timeout: 15000 }, async t => {
  const result = await child(t, `${instrument}
const journal=openJournal({stateDir:'journal',sessionId:'buffer'});journal.releaseRecords();
const initial=barriers.length,start=performance.now();
for(let index=0;index<1000;index++)journal.appendEvent({type:'message_update',requestId:'req',delta:'token-'+index});
assert.equal(barriers.length,initial,'telemetry must not fsync per token or per buffer flush');
const physical=rows(journal.file);assert.ok(physical.length>128&&physical.length<1001,'bounded events must be written out without claiming their tail durable');
assert.equal(journal.records.length,1001);verify(journal.records);
journal.appendEvent({type:'tool_execution_update',text:'large'.repeat(30000)});
assert.equal(barriers.length,initial);assert.equal(rows(journal.file).length,1002,'oversized event must bypass the pending buffer');
journal.append('tool_intent',{callKey:'a/t',effect:'write',idempotent:false});
assert.equal(barriers.length,initial+1);assert.equal(rows(journal.file).at(-1).type,'tool_intent');assert.equal(barriers.at(-1).bytes,fs.statSync(journal.file).size);verify(rows(journal.file));
journal.appendEvent({type:'agent_settled',reason:'completed'});const file=journal.file;assert.equal(journal.records.length,1004);verify(journal.records);assert.equal(barriers.length,initial+1,'records after release must merge the written prefix and buffered suffix without a durability barrier');journal.close();assert.equal(barriers.length,initial+2);assert.equal(rows(file).at(-1).data.type,'agent_settled');verify(rows(file));
const reopened=openJournal({stateDir:'journal',sessionFile:file,sessionId:'buffer'});assert.equal(reopened.seq,1004);reopened.close();assert.equal(reopened.records.length,1004,'cached records stay readable after a successful close');verify(reopened.records);
console.log(JSON.stringify({events:1002,streamFsyncs:0,canonicalFsyncs:1,closeFsyncs:1,elapsedMs:Math.round(performance.now()-start)}));`);
  assert.equal(result.streamFsyncs, 0); assert.equal(result.events, 1002);
});

test('real session keeps request, intent, checkpoint and result durable before model/tool publication with hundreds of token events', { timeout: 15000 }, async t => {
  const result = await child(t, `${instrument}
const {createSession}=await import(${JSON.stringify(sessionURL)});let session,calls=0,executions=0;const observerFailures=[];
const assertBarrier=type=>{const file=session.snapshot().sessionFile,record=rows(file).at(-1);assert.equal(record.type,type);assert.equal(barriers.at(-1).bytes,fs.statSync(file).size);};
session=await createSession({sessionId:'actual',projectId:'p',cwd:'.',stateDir:'state',model:${JSON.stringify(model)},
tools:[{name:'change_fixture',effect:'write',parameters:{type:'object',properties:{}},execute:async(_id,_args,_signal,_update,execution)=>{assertBarrier('tool_intent');execution.checkpoint({kind:'fixture',before:'a',after:'b'});assertBarrier('tool_checkpoint');fs.writeFileSync('effect.txt','one actual effect');executions++;return 'written';}}],
provider:async function*(){calls++;assertBarrier('request_started');for(let i=0;i<400;i++)yield{type:'text_delta',delta:'x'};if(calls===1)yield{type:'tool_call',id:'call',name:'change_fixture',arguments:{}};yield{type:'done'};},
onEvent:event=>{try{if(event.type==='tool_execution_end')assertBarrier('tool_completed');if(event.type==='message_end'&&event.message.role==='assistant')assertBarrier('request_completed');}catch(error){observerFailures.push(error.message);}}});
const start=performance.now();await session.prompt('Write one fixture.');assert.equal(executions,1);assert.equal(calls,2);
const file=session.snapshot().sessionFile;await session.dispose();const committed=rows(file);verify(committed);assert.equal(committed.filter(r=>r.type==='tool_intent').length,1);assert.equal(committed.filter(r=>r.type==='tool_checkpoint').length,1);assert.equal(committed.filter(r=>r.type==='tool_completed').length,1);const updates=committed.filter(r=>r.type==='event'&&r.data.type==='message_update');assert.ok(updates.length>=2&&updates.length<20,'stream tokens are journaled as segments, not per token: '+updates.length);for(const id of new Set(updates.map(r=>r.data.requestId)))assert.equal(updates.filter(r=>r.data.requestId===id).map(r=>r.data.assistantMessageEvent.delta).join(''),'x'.repeat(400));assert.equal(updates.reduce((sum,r)=>sum+(r.data.deltas??1),0),800);
assert.deepEqual(observerFailures,[]);assert.ok(barriers.length<20,'canonical operation count, not 800 tokens, controls sync barriers');
console.log(JSON.stringify({events:800,barriers:barriers.length,calls,executions,elapsedMs:Math.round(performance.now()-start)}));`);
  assert.equal(result.executions, 1); assert.ok(result.barriers < 20);
});

test('buffer write and fsync failures poison the writer; neither records nor later operations can reuse a partial append', { timeout: 15000 }, async t => {
  const result = await child(t, `${instrument}
for(const mode of ['write','sync','event-write']){
 const journal=openJournal({stateDir:mode,sessionId:mode});journal.releaseRecords();journal.appendEvent({type:'message_update',delta:'pending'});
 let injected=false;
 fs.writeSync=(fd,buffer,offset,length,position)=>{if(mode!=='sync'&&!injected){injected=true;writes(fd,buffer,offset,Math.min(17,length),position);throw Object.assign(new Error('injected partial write'),{code:'EIO'});}return writes(fd,buffer,offset,length,position);};
 fs.fsyncSync=fd=>{if(mode==='sync'&&!injected){injected=true;throw Object.assign(new Error('injected fsync'),{code:'EIO'});}return sync(fd);};syncBuiltinESMExports();
 assert.throws(()=>mode==='event-write'?journal.appendEvent({type:'message_update',delta:'x'.repeat(65536)}):journal.append('tool_intent',{effect:'write'}),{code:'EIO'});const size=fs.statSync(journal.file).size;
 assert.throws(()=>journal.append('tool_completed',{}),{code:'journal_persistence_failed'});assert.throws(()=>journal.appendEvent({type:'message_update'}),{code:'journal_persistence_failed'});assert.throws(()=>journal.records,{code:'journal_persistence_failed'});assert.equal(fs.statSync(journal.file).size,size);
 assert.throws(()=>journal.close(),{code:'journal_persistence_failed'});journal.close();assert.ok(!fs.existsSync(journal.file+'.lock'));
 fs.writeSync=writes;fs.fsyncSync=sync;syncBuiltinESMExports();
 const reopened=openJournal({stateDir:mode,sessionId:mode});verify(reopened.records);assert.ok(mode==='sync'||reopened.recoveredBytes>0);assert.equal(reopened.records.some(row=>row.type==='tool_completed'),false);reopened.close();
}
console.log(JSON.stringify({failures:['partial-write','fsync'],lateWrites:0}));`);
  assert.equal(result.lateWrites, 0);
});

test('SIGKILL during a buffered incomplete stream never recovers a partial tool call as executable', { timeout: 15000 }, async t => {
  const result = await child(t, `
import assert from 'node:assert/strict';import fs from 'node:fs';import {spawn}from'node:child_process';
const script=${JSON.stringify(`import{createSession}from${JSON.stringify(sessionURL)};const session=await createSession({sessionId:'crash',cwd:'.',stateDir:'state',model:${JSON.stringify(model)},tools:[{name:'effect',effect:'write',parameters:{type:'object'},execute:async()=>{throw Error('must not run')}}],provider:async function*(){for(let i=0;i<300;i++)yield{type:'text_delta',delta:'partial'};yield{type:'tool_call',id:'not-committed',name:'effect',arguments:{}};process.kill(process.pid,'SIGKILL');}});await session.prompt('Original user retained.');`)};
const proc=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});const status=await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('close',(code,signal)=>resolve({code,signal}));});assert.equal(status.signal,'SIGKILL');
const {createSession}=await import(${JSON.stringify(sessionURL)});let executions=0;const recovered=await createSession({sessionId:'crash',cwd:'.',stateDir:'state',model:${JSON.stringify(model)},tools:[{name:'effect',effect:'write',parameters:{type:'object'},execute:async()=>{executions++;return 'unsafe'}}],provider:async function*(){yield{type:'text_delta',delta:'completed after inspection'};yield{type:'done'}}});
const snapshot=recovered.snapshot();assert.ok(snapshot.messages.some(row=>row.role==='user'&&row.content.some(part=>part.text==='Original user retained.')));assert.equal(snapshot.recovery.pendingTools,0);assert.equal(snapshot.messages.at(-1).stopReason,'aborted');assert.ok(snapshot.messages.every(row=>!row.content.some(part=>part.type==='toolCall')));await recovered.resume();assert.equal(executions,0);await recovered.dispose();console.log(JSON.stringify({recovered:true,partialToolExecutions:executions}));`);
  assert.equal(result.partialToolExecutions, 0);
});
