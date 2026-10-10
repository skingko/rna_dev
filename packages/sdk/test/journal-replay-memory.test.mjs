import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const journalURL = new URL('../src/journal.mjs', import.meta.url).href;
const sessionURL = new URL('../src/session.mjs', import.meta.url).href;
async function isolated(t, source) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'rna-streamed-replay-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', source], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(result.code, 0, stderr); assert.equal(result.signal, null, stderr);
  return JSON.parse(stdout);
}

test('a journal larger than the isolated heap replays incrementally, preserving canonical messages, usage, partial text and uncertain effects', { timeout: 30000 }, async t => {
  const result = await isolated(t, `
import assert from 'node:assert/strict';import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
const {openJournal}=await import(${JSON.stringify(journalURL)});
const journal=openJournal({stateDir:'state',sessionId:'large',projectId:'p'});
const user={id:'u',role:'user',content:[{type:'text',text:'Preserve my request.'}],timestamp:1};
journal.append('message',{message:user});
for(let i=0;i<40000;i++)journal.appendEvent({type:'tool_execution_update',index:i,text:'x'.repeat(2048)});
const assistant={id:'a',role:'assistant',content:[{type:'text',text:'A completed answer.'},{type:'toolCall',id:'completed',name:'change',arguments:{}},{type:'toolCall',id:'unknown',name:'change',arguments:{value:2}}],usage:{input:7,output:3,cacheRead:0,cacheWrite:0,totalTokens:10},timestamp:2};
journal.append('request_started',{requestId:'r',message:{...assistant,content:[]}});
journal.appendEvent({type:'message_update',requestId:'r',delta:'discarded streaming copy'});
journal.append('request_completed',{requestId:'r',message:assistant});
journal.append('tool_intent',{callKey:'a/completed',assistantId:'a',call:{id:'completed',name:'change',arguments:{}},effect:'write',idempotent:false});
journal.append('tool_completed',{callKey:'a/completed',result:{content:[{type:'text',text:'receipt'}]},message:{id:'t',role:'toolResult',toolCallId:'completed',toolName:'change',assistantId:'a',content:[{type:'text',text:'receipt'}],timestamp:3}});
journal.append('tool_intent',{callKey:'a/unknown',assistantId:'a',call:{id:'unknown',name:'change',arguments:{value:2}},effect:'write',idempotent:false});
journal.append('tool_checkpoint',{callKey:'a/unknown',checkpoint:{before:'one',after:'two'}});
journal.append('tool_uncertain',{callKey:'a/unknown',requiresResolution:true});
journal.append('run_started',{runId:'interrupted'});
journal.append('request_started',{requestId:'partial',message:{id:'partial-answer',role:'assistant',content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0},timestamp:4}});
const partial='跨块🙂'.repeat(40000);journal.appendEvent({type:'message_update',requestId:'partial',delta:partial});
const file=journal.file,expectedSeq=journal.seq;journal.close();const fileBytes=fs.statSync(file).size;assert.ok(fileBytes>80*1024*1024);
const read=fs.readSync,readFile=fs.readFileSync,fstat=fs.fstatSync,stat=fs.statSync,identity=stat(file);let maxRead=0,journalReads=0;
// Module loading also uses readSync. Identify this journal by its file identity,
// not a process-wide read size or an fd number that can be reused after close.
const isJournal=target=>{try{const value=typeof target==='number'?fstat(target):stat(target);return value.dev===identity.dev&&value.ino===identity.ino;}catch{return false;}};
fs.readSync=(fd,buffer,offset,length,position)=>{if(isJournal(fd)){journalReads++;maxRead=Math.max(maxRead,length??0);}return read(fd,buffer,offset,length,position);};
fs.readFileSync=(path,...args)=>{assert.equal(isJournal(path),false,'replay must not materialize the entire journal by path or descriptor');return readFile(path,...args);};syncBuiltinESMExports();
fs.writeFileSync('unrelated-source.mjs',' '.repeat(70000));assert.equal(fs.readFileSync('unrelated-source.mjs','utf8').length,70000);assert.equal(journalReads,0,'unrelated file reads must not enter the journal probe');assert.throws(()=>fs.readFileSync(file),/must not materialize/);const probeFd=fs.openSync(file,'r');try{assert.throws(()=>fs.readFileSync(probeFd),/must not materialize/);}finally{fs.closeSync(probeFd);}
const reopened=openJournal({stateDir:'state',sessionId:'large',projectId:'p'});let seen=0;for(const row of reopened.iterateRecords())assert.equal(row.seq,++seen);assert.equal(seen,expectedSeq);reopened.close();
const{createSession}=await import(${JSON.stringify(sessionURL)});let executions=0;
const session=await createSession({stateDir:'state',sessionId:'large',projectId:'p',cwd:'.',model:{providerId:'test',modelId:'fixture',contextWindow:1000000,maxOutputTokens:1000},tools:[{name:'change',effect:'write',parameters:{type:'object'},execute:async()=>{executions++;return 'must not run';}}],provider:async function*(){throw Error('replay must not request a model')}});
const snapshot=session.snapshot();assert.equal(snapshot.messages.filter(x=>x.id==='u').length,1);assert.equal(snapshot.messages.find(x=>x.id==='a').content[0].text,'A completed answer.');assert.equal(snapshot.messages.filter(x=>x.id==='t').length,1);assert.equal(snapshot.messages.find(x=>x.id==='partial-answer').content[0].text,partial);assert.equal(snapshot.messages.find(x=>x.id==='partial-answer').stopReason,'aborted');assert.equal(snapshot.usage.totalTokens,10);assert.equal(snapshot.recovery.uncertainTools.length,1);assert.equal(snapshot.recovery.uncertainTools[0].callKey,'a/unknown');assert.equal(executions,0);assert.ok(journalReads>0,'the probe must observe journal reads');assert.ok(maxRead<=65536);await session.dispose();
console.log(JSON.stringify({fileBytes,records:expectedSeq,maxRead,messages:snapshot.messages.length,uncertainEffects:snapshot.recovery.uncertainTools.length,maxRSS:process.resourceUsage().maxRSS}));`);
  assert.ok(result.fileBytes > 80 * 1024 * 1024); assert.equal(result.uncertainEffects, 1); assert.ok(result.records > 40000);
});

test('streamed readers retain pending events, a closed prefix, integrity checks and exact torn bytes across chunk boundaries', { timeout: 15000 }, async t => {
  const result = await isolated(t, `
import assert from'node:assert/strict';import fs from'node:fs';const{openJournal}=await import(${JSON.stringify(journalURL)});
let journal=openJournal({stateDir:'state',sessionId:'boundaries'});const text='语🙂'.repeat(18000);journal.append('message',{text});journal.appendEvent({type:'message_update',delta:'pending'});const expected=journal.records,file=journal.file;assert.deepEqual([...journal.iterateRecords()],expected);journal.close();
for(let i=0;i<40;i++)assert.deepEqual(journal.records,expected,'closed readers must release their descriptor');
const next=openJournal({stateDir:'state',sessionId:'boundaries'});next.append('message',{text:'later owner'});next.close();assert.deepEqual(journal.records,expected,'closed readers retain their original prefix even after later appends');
const torn=Buffer.from('断🙂'.repeat(40000));fs.appendFileSync(file,torn);journal=openJournal({stateDir:'state',sessionId:'boundaries'});assert.equal(journal.recoveredBytes,torn.length);assert.equal(journal.records.at(-1).type,'journal_recovered');const quarantine=fs.readdirSync('state').find(name=>name.includes('.torn-'));assert.deepEqual(fs.readFileSync('state/'+quarantine),torn);journal.close();
const bytes=fs.readFileSync(file);const needle=Buffer.from('later owner');const offset=bytes.indexOf(needle);assert.ok(offset>=0);bytes[offset]=120;fs.writeFileSync(file,bytes);assert.throws(()=>openJournal({stateDir:'state',sessionId:'boundaries'}),{code:'journal_corrupt'});assert.ok(!fs.existsSync(file+'.lock'));
console.log(JSON.stringify({tornBytes:torn.length,closedReads:40,corruptionDetected:true}));`);
  assert.ok(result.tornBytes > 64 * 1024); assert.equal(result.corruptionDetected, true);
});

test('a reopen in the same process verifies only the unseen tail; any later rewrite of the log forces full verification', { timeout: 30000 }, async t => {
  const result = await isolated(t, `
import assert from'node:assert/strict';import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';
const{openJournal}=await import(${JSON.stringify(journalURL)});
let journal=openJournal({stateDir:'state',sessionId:'reopen'});
for(let i=0;i<6000;i++){if(i%40===0)journal.append('message',{message:{id:'m'+i,role:'user',content:[{type:'text',text:'x'.repeat(900)}]}});journal.appendEvent({type:'message_update',requestId:'r',delta:'y'.repeat(600)});}
const file=journal.file,expected=journal.seq;journal.close();const size=fs.statSync(file).size;
const read=fs.readSync,identity=fs.statSync(file);let bytes=0;
fs.readSync=(fd,buffer,offset,length,position)=>{const count=read(fd,buffer,offset,length,position);try{const s=fs.fstatSync(fd);if(s.ino===identity.ino&&s.dev===identity.dev)bytes+=count;}catch{}return count;};syncBuiltinESMExports();
bytes=0;journal=openJournal({stateDir:'state',sessionId:'reopen'});const warm=bytes;journal.append('message',{message:{id:'tail',role:'user',content:[]}});
let seen=0,events=0;for(const row of journal.iterateRecords({verified:true,wantEvent:()=>false})){seen++;if(row.type==='event')events++;}
assert.equal(events,0,'telemetry is skipped without parsing');assert.equal(journal.seq,expected+1);journal.close();
assert.ok(warm<=4*64*1024,'reopen reads only a few bounded chunks at the boundary: '+warm);
const again=openJournal({stateDir:'state',sessionId:'reopen'});let all=0;for(const row of again.iterateRecords())all++;assert.equal(all,expected+1);again.close();
const content=fs.readFileSync(file);const at=content.indexOf(Buffer.from('m120"'));content[at]=110;fs.writeFileSync(file,content);
bytes=0;assert.throws(()=>openJournal({stateDir:'state',sessionId:'reopen'}),{code:'journal_corrupt'});
console.log(JSON.stringify({size,warm,seen}));`);
  assert.ok(result.size > 3 * 1024 * 1024); assert.ok(result.warm <= 4 * 65536 && result.warm * 10 < result.size); assert.equal(result.seen, 1 + 150 + 1, 'header, messages and the new tail record; events skipped');
});
