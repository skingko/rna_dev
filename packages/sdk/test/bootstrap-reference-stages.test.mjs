import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { bootstrapProject, projectBootstrapSchema } from '../src/bootstrap.mjs';
import { runReferenceAuthoring, REFERENCE_AUTHORING_POLICY } from '../src/reference-authoring.mjs';
import { projectGenomeFixture } from './fixtures/project-genome.mjs';
const model = { providerId: 'stages', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 32768, reasoning: 'max' };
const artifact = () => ({ overview: 'Source-aware project', focus: 'Use verified methods', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture() });
const encodedSchema = JSON.stringify(projectBootstrapSchema);
const messageText = request => request.messages.map(row => [...(typeof row.content === 'string' ? [{type:'text',text:row.content}] : row.content ?? []).filter(part => part.type === 'text').map(part => {
  if (part.text.includes('[Retrieved reference data;')) { try { const at = part.text.indexOf('[Retrieved reference data;'); return part.text.slice(0, at) + JSON.parse(part.text.slice(part.text.indexOf('\n', at) + 1)).map(item => item.text).join('\n'); } catch { /* normal source text */ } }
  return part.text;
}), ...(row.context ?? []).map(part => part.text)].join('\n')).join('\n');
function setup(actions, { pending = false, maxAttempts = 1, policy, ...extra } = {}) {
  const requests = [], events = [], admissions = []; let reads = 0;
  const referenceTools = [{ name: 'marketplace_plan', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => 'Bounded plan fixture' }, { name: 'marketplace_read', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => { reads++; return 'ORIGINAL_SOURCE_RECEIPT: use verified evidence before concluding.'; } }];
  const referencePolicy = policy ?? { beforeFinish: () => pending && !reads ? { feedback: [{ source: 'host:test-policy', text: 'Read a source before completing research.' }] } : undefined, finalizeGenome: value => value };
  const provider = async function* (request) {
    const number = requests.push(request), action = actions[Math.min(number - 1, actions.length - 1)];
    if (typeof action === 'function') yield* action(request, number);
    else if (action === 'read') { yield { type: 'tool_call', id: `read-${number}`, name: 'marketplace_read', arguments: {} }; yield { type: 'usage', usage: { totalTokens: 17 } }; yield { type: 'done', stopReason: 'toolUse' }; }
    else { yield { type: 'text_delta', delta: JSON.stringify(action === 'marker' ? { researchComplete: true } : action ?? artifact()) }; yield { type: 'usage', usage: { totalTokens: 17 } }; yield { type: 'done', stopReason: 'stop' }; }
  };
  const run = () => bootstrapProject({ title: 'Source-aware project', description: 'Preserve this exact user constraint.', existingState: { focus: 'Existing decision survives research.' }, model, referenceTools, referencePolicy, provider, maxAttempts, onEvent: event => events.push(event), beforeRequest: request => admissions.push(request), ...extra });
  return { run, requests, events, admissions, reads: () => reads };
}

test('bootstrap source stage excludes the full genome contract and hands it off once with metered context', async () => {
  const app = setup(['read', 'marker', artifact()], { pending: true });
  const result = await app.run(); assert.equal(result.status, 'ready'); assert.equal(app.requests.length, 3); assert.equal(app.reads(), 1);
  const [first, , final] = app.requests;
  assert.ok(Buffer.byteLength(first.systemPrompt) < 8000); assert.ok(!first.systemPrompt.includes(encodedSchema)); assert.doesNotMatch(first.systemPrompt, /FUNCTION BODY|Schema:|smokeRepairs:/);
  assert.match(messageText(first), /Preserve this exact user constraint/); assert.match(messageText(first), /Existing decision survives research/);
  assert.equal(final.tools.length, 0); assert.equal(first.model.maxOutputTokens, 32768); assert.equal(first.model.reasoning, 'max');
  assert.equal(messageText(final).split(encodedSchema).length - 1, 1); assert.match(messageText(final), /ORIGINAL_SOURCE_RECEIPT/); assert.match(messageText(final), /FUNCTION BODY/);
  assert.ok(app.admissions[2].estimatedTokens > app.admissions[0].estimatedTokens + 8000, 'The full handoff is counted by request admission, not inserted behind the meter.');
  assert.equal(result.usage.totalTokens, 51); assert.equal(app.events.filter(event => event.type === 'bootstrap_request_end').length, 3);
  const stages = app.events.filter(event => event.type === 'bootstrap_authoring_stage'); assert.deepEqual(stages.map(row => row.reason), ['started', 'research_completed']); assert.equal(stages[1].researchCompleted, true); assert.equal(stages[1].nextRequestIndex, 3);
  const tool = app.events.filter(event => event.type === 'bootstrap_first_reference_tool'); assert.equal(tool.length, 1); assert.equal(tool[0].toolName, 'marketplace_read'); assert.equal(tool[0].requestIndex, 1); assert.ok(tool[0].elapsedMs >= 0); assert.equal('arguments' in tool[0], false);
  const starts = app.events.filter(event => event.type === 'bootstrap_request_start'); assert.deepEqual(starts.map(row => row.authoringStage), ['research', 'research', 'artifact']); assert.equal(starts[2].declaredToolCount, 0); assert.ok(starts.every(row => row.systemPromptBytes > 0 && row.messageBytes > 0));
});

test('an early artifact cannot bypass the research marker and the marker cannot bypass source policy', async () => {
  const app = setup([artifact(), 'marker', 'read', 'marker', artifact()], { pending: true });
  await app.run(); assert.equal(app.requests.length, 5); assert.equal(app.reads(), 1);
  assert.match(messageText(app.requests[1]), /still the source research stage/); assert.match(messageText(app.requests[2]), /Read a source before completing research/);
  for (const request of app.requests.slice(0, 4)) { assert.ok(request.tools.length); assert.ok(!request.systemPrompt.includes(encodedSchema)); }
  assert.equal(app.requests[4].tools.length, 0); assert.equal(app.events.find(row => row.type === 'bootstrap_authoring_stage' && row.stage === 'artifact').researchCompleted, true);
});

test('five tool batches receive the full contract once in the reserved sixth request without claiming a marker', async () => {
  const app = setup(['read', 'read', 'read', 'read', 'read', artifact()]); const result = await app.run();
  assert.equal(app.requests.length, 6); assert.equal(app.reads(), 5); assert.equal(result.usage.totalTokens, 102);
  for (const request of app.requests.slice(0, 5)) assert.equal(messageText(request).includes(encodedSchema), false);
  const final = app.requests[5]; assert.equal(final.tools.length, 0); assert.equal(messageText(final).split(encodedSchema).length - 1, 1); assert.ok(!final.systemPrompt.includes(encodedSchema));
  const stage = app.events.find(row => row.type === 'bootstrap_authoring_stage' && row.stage === 'artifact'); assert.equal(stage.reason, 'request_limit'); assert.equal(stage.researchCompleted, false); assert.equal(stage.nextRequestIndex, 6);
});

test('reserved output cannot silently accept an unfinished source policy or buy a seventh request', async () => {
  const app = setup(['read', 'read', 'read', 'read', 'read', artifact()], { policy: { beforeFinish: () => ({ feedback: [{ source: 'host:pending', text: 'A complementary source remains uninspected.' }] }), finalizeGenome: () => { throw Error('Must not reach source finalization'); } } });
  await assert.rejects(app.run(), error => error.code === 'step_limit' && error.usage.totalTokens === 102); assert.equal(app.requests.length, 6);
});

test('artifact validation repair stays in the same operation and never repeats source research', async () => {
  const invalid = artifact(); invalid.genome.tools[0].script = 'return {doubled:99};';
  const app = setup(['read', 'marker', invalid, artifact()], { maxAttempts: 2 }); const result = await app.run();
  assert.equal(result.attempts, 2); assert.equal(app.reads(), 1); assert.equal(app.requests.length, 4); assert.equal(app.requests[3].tools.length, 0); assert.ok(app.requests[3].systemPrompt.includes(encodedSchema));
  assert.equal(result.usage.totalTokens, 68); assert.equal(result.repairEvidence[0].validation.passed, false); assert.equal(result.repairEvidence[1].validation.passed, true);
  assert.equal(app.events.filter(row => row.type === 'bootstrap_authoring_stage' && row.stage === 'research').length, 1);
});

test('artifact handoff admission failure retains earlier billed requests and sends no final provider call', async () => {
  let admissions = 0; const app = setup(['read', 'marker', artifact()], { beforeRequest: () => { if (++admissions === 3) throw Object.assign(Error('Budget denied'), { code: 'budget' }); } });
  await assert.rejects(app.run(), error => error.code === 'budget' && error.usage.totalTokens === 34); assert.equal(app.requests.length, 2); assert.equal(admissions, 3);
});

test('cancellation during asynchronous source readiness review dispatches no artifact request', async () => {
  const controller = new AbortController(); const app = setup(['marker', artifact()], { signal: controller.signal, policy: { beforeFinish: async () => { controller.abort(); await Promise.resolve(); }, finalizeGenome: value => value } });
  await assert.rejects(app.run(), error => error.name === 'AbortError' && error.usage.totalTokens === 17); assert.equal(app.requests.length, 1);
});

test('non-staged reference callers keep the original first-response contract and system prefix', async () => {
  const requests = [], stages = [];
  const result = await runReferenceAuthoring({ systemPrompt: 'Original full artifact schema', artifactSystemPrompt: 'Original full artifact schema', input: 'Data', schema: { type: 'object' }, model, tools: [], onStage: event => stages.push(event), provider: async function* (request) { requests.push(request); yield { type: 'text_delta', delta: '{"complete":true}' }; yield { type: 'done', stopReason: 'stop' }; } });
  assert.equal(result.output, '{"complete":true}'); assert.equal(requests.length, 1); assert.equal(requests[0].systemPrompt, `Original full artifact schema\n${REFERENCE_AUTHORING_POLICY}`); assert.deepEqual(stages, []);
});


test('staged bootstrap sends a small actual HTTP research request and a single complete host contract at handoff', async t => {
  const bodies = [], failures = []; let planned = false, read = false;
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), number = bodies.push(body);
      assert.ok(number <= 4); assert.equal(body.max_tokens ?? body.max_completion_tokens, 32768);
      const system = body.messages.find(row => row.role === 'system').content;
      assert.ok(Buffer.byteLength(system) < 8000); assert.ok(!system.includes(encodedSchema));
      let delta, finish;
      if (number <= 2) {
        assert.ok(body.tools.length); assert.equal(messageText(body).includes(encodedSchema), false);
        delta = { tool_calls: [{ index: 0, id: `http-stage-${number}`, type: 'function', function: { name: number === 1 ? 'marketplace_plan' : 'marketplace_read', arguments: '{}' } }] }; finish = 'tool_calls';
      } else if (number === 3) { delta = { content: '{"researchComplete":true}' }; finish = 'stop'; }
      else {
        assert.equal(body.tools?.length ?? 0, 0); assert.equal(messageText(body).split(encodedSchema).length - 1, 1); assert.match(messageText(body), /HTTP_SOURCE_INSPECTED/);
        delta = { content: JSON.stringify(artifact()) }; finish = 'stop';
      }
      res.writeHead(200, {'content-type':'text/event-stream'});
      res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
      res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:7,total_tokens:17}})}\n\ndata: [DONE]\n\n`);
    } catch (error) { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(done => server.listen(0,'127.0.0.1',done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); assert.deepEqual(failures, []); });
  const tools = [{ name:'marketplace_plan', effect:'read', parameters:{type:'object',properties:{}},execute:async()=>{planned=true;return 'HTTP_PLAN_RECORDED';} },{name:'marketplace_read',effect:'read',parameters:{type:'object',properties:{}},execute:async()=>{read=true;return 'HTTP_SOURCE_INSPECTED';}}];
  const result = await bootstrapProject({title:'HTTP source-aware project',model:{...model,baseUrl:`http://127.0.0.1:${server.address().port}/v1`},referenceTools:tools,referencePolicy:{beforeFinish:()=>planned&&read?undefined:{feedback:[{source:'host:policy',text:'Plan and inspect the source.'}]},finalizeGenome:genome=>genome},maxAttempts:1});
  assert.equal(result.status,'ready');assert.equal(result.usage.totalTokens,68);assert.equal(bodies.length,4);
});

const pendingReadiness = (allowOneCorrection=true) => ({ready:false,pendingCapabilityIds:['verification'],feedback:'Verification has no selected source. Resolve its recorded acquisition error.',allowOneCorrection});
test('host-ready research forces request six into one native final without increasing ordinary allowance',async()=>{
 const app=setup(['read','read','read','read','read',artifact()],{model:{...model,compat:{supportsJsonObject:true,supportsToolChoiceNone:true}},policy:{researchReadiness:()=>({ready:true}),finalizeGenome:g=>g}});
 await app.run();assert.equal(app.requests.length,6);assert.deepEqual(app.requests[5].responseFormat,{type:'json_object'});assert.equal(app.requests[5].toolChoice,'none');assert.equal(app.requests[5].tools.length,0);assert.equal(app.events.find(r=>r.reason==='research_ready').researchCompleted,false);assert.equal(app.events.some(r=>r.reason==='correction_granted'),false);
});
test('successful source progress permits only one corrective research request, then a metered final',async()=>{
 let app;app=setup(['read','read','read','read','read','read',artifact()],{policy:{researchReadiness:()=>app.reads()>=6?{ready:true}:pendingReadiness(),finalizeGenome:g=>g}});const result=await app.run();assert.equal(app.requests.length,7);assert.equal(app.requests[5].tools.length,2);assert.equal(app.requests[6].tools.length,0);assert.equal(result.usage.totalTokens,119);assert.equal(app.events.filter(r=>r.reason==='correction_granted').length,1);assert.equal(app.events.find(r=>r.reason==='research_ready').researchReceipt.researchRequests,6);assert.equal(app.events.filter(r=>r.type==='bootstrap_request_end').length,7);
});
test('pending after the single correction exits typed with all costs and no artifact or repair even maxAttempts three',async()=>{
 const app=setup(['read'],{maxAttempts:3,policy:{researchReadiness:()=>pendingReadiness(),finalizeGenome:()=>assert.fail('No artifact finalization')}});
 await assert.rejects(app.run(),e=>{assert.equal(e.code,'reference_research_incomplete');assert.equal(e.usage.totalTokens,102);assert.deepEqual(e.referenceResearch,{schemaVersion:1,ready:false,researchRequests:6,correctionGranted:true,pendingCapabilityIds:['verification']});assert.deepEqual(e.repairEvidence,[]);return true;});assert.equal(app.requests.length,6);assert.ok(app.requests.every(r=>r.tools.length&& !messageText(r).includes(encodedSchema)));assert.equal(app.events.some(r=>r.type==='bootstrap_repair'||r.stage==='artifact'),false);
});
test('tool error receipts and model claims cannot authorize extra research or an artifact',async()=>{
 const errorTool={name:'marketplace_read',effect:'read',parameters:{type:'object',properties:{}},execute:async()=>({isError:true,content:[{type:'text',text:'Failed source read; not evidence.'}]})};
 for(const actions of [['marker'],['read']]){const app=setup(actions,{maxAttempts:3,referenceTools:[{name:'marketplace_plan',effect:'read',parameters:{type:'object',properties:{}},execute:async()=>({})},errorTool],policy:{researchReadiness:()=>pendingReadiness(),beforeFinish:()=>({feedback:[{source:'host:pending',text:'Source remains pending.'}]}),finalizeGenome:()=>assert.fail()}});await assert.rejects(app.run(),e=>e.code==='reference_research_incomplete'&&e.usage.totalTokens===85&&!e.referenceResearch.correctionGranted);assert.equal(app.requests.length,5);}
});
test('host refusal of correction, invalid readiness and cancellation never dispatch final artifact',async()=>{
 for(const value of [pendingReadiness(false),undefined,{ready:'yes'},{ready:false,pendingCapabilityIds:[],feedback:'Pending',allowOneCorrection:'yes'}]){const app=setup(['read'],{policy:{researchReadiness:()=>value,finalizeGenome:g=>g}});await assert.rejects(app.run(),e=>e.code===(value?.ready===false&&value.allowOneCorrection===false?'reference_research_incomplete':'invalid_reference_readiness'));assert.equal(app.requests.length,5);}
 const controller=new AbortController();const app=setup(['read'],{signal:controller.signal,policy:{researchReadiness:()=>{controller.abort();return pendingReadiness();},finalizeGenome:g=>g}});await assert.rejects(app.run(),e=>e.name==='AbortError'&&e.usage.totalTokens===85);assert.equal(app.requests.length,5);
});
test('external budget rejects a permitted correction before any sixth provider request',async()=>{
 let count=0;const app=setup(['read'],{policy:{researchReadiness:()=>pendingReadiness(),finalizeGenome:g=>g},beforeRequest:()=>{if(++count===6)throw Object.assign(Error('Denied'),{code:'budget_denied'});}});await assert.rejects(app.run(),e=>e.code==='budget_denied'&&e.usage.totalTokens===85);assert.equal(count,6);assert.equal(app.requests.length,5);assert.equal(app.events.filter(r=>r.type==='bootstrap_request_end').length,5);assert.equal(app.events.filter(r=>r.type==='bootstrap_request_start').length,5);
});
test('early marker still requires host readiness; artifact finish feedback cannot buy a seventh request',async()=>{
 const app=setup(['read','read','read','read','read',artifact()],{policy:{researchReadiness:()=>({ready:true}),beforeFinish:()=>({feedback:[{source:'host:changed',text:'Source authorization changed before finish.'}]}),finalizeGenome:()=>assert.fail()}});await assert.rejects(app.run(),e=>e.code==='step_limit'&&e.usage.totalTokens===102);assert.equal(app.requests.length,6);
 let calls=0;const blocked=setup(['marker'],{policy:{researchReadiness:()=>{calls++;return pendingReadiness();},beforeFinish:()=>undefined,finalizeGenome:()=>assert.fail()}});await assert.rejects(blocked.run(),{code:'reference_research_incomplete'});assert.equal(blocked.requests.length,5);assert.ok(calls>=5);assert.equal(blocked.events.some(r=>r.stage==='artifact'),false);
});

test('actual HTTP source failure gets one correction; unresolved coverage never receives full schema or artifact request',async t=>{
 for(const correctionSucceeds of [true,false]){
  const bodies=[],failures=[],events=[];let closed=false,executions=0;
  const server=createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),n=bodies.push(body);assert.ok(n<8);
    const final=n===7;assert.equal(final,closed);if(!final){assert.ok(body.tools.length);assert.equal(messageText(body).includes(encodedSchema),false);}else{assert.equal(body.tools?.length??0,0);assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(body.tool_choice,'none');assert.equal(messageText(body).split(encodedSchema).length-1,1);}
    const delta=final?{content:JSON.stringify(artifact())}:{tool_calls:[{index:0,id:`source-${n}`,type:'function',function:{name:'marketplace_read',arguments:JSON.stringify({n})}}]};
    res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:final?'stop':'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:7,total_tokens:17}})}\n\ndata: [DONE]\n\n`);
   }catch(e){failures.push(e);res.writeHead(500);res.end();}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));assert.deepEqual(failures,[]);});
  const refTools=[{name:'marketplace_plan',effect:'read',parameters:{type:'object',properties:{}},execute:async()=>({})},{name:'marketplace_read',effect:'read',parameters:{type:'object',properties:{n:{type:'integer'}},required:['n']},execute:async(_id,{n})=>{executions++;if(n===6&&correctionSucceeds)closed=true;return {isError:n===5||n===6&&!correctionSucceeds,content:[{type:'text',text:JSON.stringify({status:closed?'ready':n===5?'marketplace_existing_required':'source_recorded'})}]};}}];
  const run=()=>bootstrapProject({title:'HTTP correction',model:{...model,compat:{supportsJsonObject:true,supportsToolChoiceNone:true},baseUrl:`http://127.0.0.1:${server.address().port}/v1`},referenceTools:refTools,referencePolicy:{researchReadiness:()=>closed?{ready:true}:pendingReadiness(),beforeFinish:()=>closed?undefined:{feedback:[{source:'host:coverage',text:'Verification source pending.'}]},finalizeGenome:g=>g},maxAttempts:3,onEvent:e=>events.push(e)});
  if(correctionSucceeds){const result=await run();assert.equal(result.usage.totalTokens,119);assert.equal(bodies.length,7);}else{await assert.rejects(run(),e=>e.code==='reference_research_incomplete'&&e.usage.totalTokens===102);assert.equal(bodies.length,6);assert.equal(events.some(e=>e.stage==='artifact'),false);}assert.equal(executions,6);
 }
});
