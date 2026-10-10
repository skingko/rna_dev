import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
const model = { providerId:'fixture',modelId:'fixture',protocol:'openai',contextWindow:32000,maxOutputTokens:1000,compat:{supportsJsonObject:true,supportsToolChoiceNone:true} };
async function setup(t, options={}) {
 const root=await mkdtemp(join(tmpdir(),'rna-host-final-'));
 const session=await createSession({cwd:root,stateDir:root,model,maxSteps:6,autoCompaction:false,stepLimitBehavior:'summarize',stepLimitResponseFormat:'json_object',stepLimitInstructions:'Return the completed artifact as JSON.',...options});
 t.after(async()=>{await session.dispose();await rm(root,{recursive:true,force:true});});return session;
}
const complete=async function*(){yield {type:'text_delta',delta:'{"complete":true}'};yield {type:'usage',usage:{totalTokens:13}};yield {type:'done',stopReason:'stop'};};
test('early final uses native JSON and no-tool projection, journals purpose, and meters attached context once',async t=>{
 const requests=[],admissions=[];let executions=0;
 const session=await setup(t,{tools:[{name:'read',effect:'read',parameters:{type:'object',properties:{}},execute:async()=>{executions++;return 'source';}}],beforeRequest:({snapshot})=>snapshot.messages.some(row=>row.role==='toolResult')?{finalResponse:true,contextUpdates:[{key:'artifact',source:'host:artifact',text:'Large contract '+ 'x'.repeat(4000)}]}:undefined,beforeCompletion:r=>admissions.push(r),provider:async function*(r){requests.push(r);if(requests.length===1){yield {type:'tool_call',id:'read',name:'read',arguments:{}};yield {type:'usage',usage:{totalTokens:7}};yield {type:'done',stopReason:'toolUse'};}else yield* complete();}});
 await session.prompt('Inspect and finish.');assert.equal(requests.length,2);assert.equal(executions,1);assert.equal(admissions.length,2);assert.equal(session.snapshot().usage.totalTokens,20);
 assert.deepEqual(requests[1].tools,[]);assert.deepEqual(requests[1].responseFormat,{type:'json_object'});assert.equal(requests[1].toolChoice,'none');assert.match(requests[1].systemPrompt,/host has closed the tool phase/);assert.ok(admissions[1].estimatedInputTokens>admissions[0].estimatedInputTokens+900);
 const records=(await readFile(session.snapshot().sessionFile,'utf8')).trim().split('\n').map(JSON.parse);const started=records.find(row=>row.type==='request_started'&&row.data?.boundaryReason==='host_final_response');assert.ok(started);assert.equal(started.data.purpose,'step-limit-summary');
});
test('early final cannot execute returned tools or buy another request with finish feedback',async t=>{
 for(const mode of ['tool','feedback']){let calls=0,executed=0;const session=await setup(t,{beforeRequest:()=>({finalResponse:true}),tools:[{name:'read',effect:'read',parameters:{type:'object',properties:{}},execute:async()=>{executed++;}}],beforeFinish:mode==='feedback'?()=>({feedback:[{source:'host:review',text:'Still incomplete.'}]}):undefined,provider:async function*(){calls++;if(mode==='tool'){yield {type:'tool_call',id:'forbidden',name:'read',arguments:{}};yield {type:'usage',usage:{totalTokens:13}};yield {type:'done',stopReason:'toolUse'};}else yield*complete();}});await assert.rejects(session.prompt('Complete.'),{code:'step_limit'});assert.equal(calls,1);assert.equal(executed,0);assert.equal(session.snapshot().usage.totalTokens,13);}
});
test('invalid finalResponse values and non-summarize policy fail before billing or provider calls',async t=>{
 for(const value of [false,null,'true',1,{},[]]){let calls=0,admitted=0;const session=await setup(t,{beforeRequest:()=>({finalResponse:value}),beforeCompletion:()=>{admitted++;},provider:async function*(){calls++;yield*complete();}});await assert.rejects(session.prompt('Complete.'),{code:'invalid_final_response'});assert.equal(calls,0);assert.equal(admitted,0);}
 const session=await setup(t,{stepLimitBehavior:'error',stepLimitResponseFormat:undefined,stepLimitInstructions:undefined,beforeRequest:()=>({finalResponse:true}),provider:complete});await assert.rejects(session.prompt('Complete.'),{code:'invalid_final_response'});
});
test('early final cannot bypass budget rejection or cancellation before dispatch',async t=>{
 for(const mode of ['budget','cancel']){let calls=0,admissions=0;let session;session=await setup(t,{beforeRequest:()=>({finalResponse:true}),beforeCompletion:()=>{admissions++;if(mode==='budget')throw Object.assign(Error('Budget denied'),{code:'budget_denied'});void session.abort();},provider:async function*(){calls++;yield*complete();}});if(mode==='budget')await assert.rejects(session.prompt('Complete.'),{code:'budget_denied'});else await session.prompt('Complete.');assert.equal(admissions,1);assert.equal(calls,0);assert.equal(session.snapshot().usage.totalTokens,0);}
});
