import test from 'node:test';
import assert from 'node:assert/strict';
import { recallProjectMemory, attachedMemoryPassages, memoryFilterHook } from '../memory-context.mjs';
import { packMemoryRecall, passageHash } from '../memory-service.mjs';
import { prepareContext } from '../../../packages/sdk/src/context.mjs';
const base = () => ({ projectId:'p',prompt:'What did we agree?',snapshot:{tools:['openviking_search'],cache:{estimatedInputTokens:2000},pendingContextTokens:200},model:{contextWindow:12000,maxOutputTokens:2000},policy:{contextBudget:2048,limit:5} });
test('foreground/background share bounded request-specific recall and preserve URI without changing stable prefix',async()=>{
 const input=base(), calls=[],progress=[];const entries=[{uri:'viking://resources/projects/p/a',expandUri:'viking://resources/projects/p/a',summary:'Keep visible user choices.',level:'L2'}];
 const result=await recallProjectMemory({...input,service:{recall:async(id,request)=>{calls.push({id,request});return {entries,content:JSON.stringify(entries),truncated:false,candidateCount:1,stage:'summaries'};}},onProgress:x=>progress.push(x)});
 assert.equal(calls[0].id,'p');assert.equal(calls[0].request.limit,5);assert.equal(result.projection.execution,'retrieved');assert.equal(progress[0].execution,'retrieving');
 const a=prepareContext({systemPrompt:'stable',messages:[]}),b=prepareContext({systemPrompt:'stable',messages:[{role:'user',content:[{type:'text',text:input.prompt}],context:[{source:'project-memory',text:result.reference}]}]});assert.equal(a.cache.prefixHash,b.cache.prefixHash);assert.match(JSON.stringify(b.messages),/not user instructions/);
});
test('unassigned, disabled, insufficient budget never search; query and escaped attachments are bounded',async()=>{
 let count=0;const service={recall:async()=>{count++;throw new Error('should not search');}};
 for(const changes of [{snapshot:{tools:[]}},{policy:{autoRecall:false}},{model:{contextWindow:2500,maxOutputTokens:2000}}]) assert.equal((await recallProjectMemory({...base(),...changes,service})).reference,null);assert.equal(count,0);
 const input={...base(),prompt:'a'.repeat(1800),policy:{contextBudget:400}},entries=[{uri:'viking://resources/projects/p/b',summary:'\\\"'.repeat(8000)}];
 const result=await recallProjectMemory({...input,service:{recall:async(_id,request)=>{assert.equal(request.query.length,1000);return {entries,content:JSON.stringify(entries),candidateCount:1};}}});assert.equal(result.reference,null);assert.equal(result.projection.execution,'budget');
});
test('service failure is explicit unavailable data; cancellation does not masquerade as memory failure',async()=>{
 const result=await recallProjectMemory({...base(),service:{recall:async()=>{throw new Error('PRIVATE_UPSTREAM_BODY');}}});assert.equal(result.projection.execution,'unavailable');assert.match(result.reference,/No memory was retrieved/);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_UPSTREAM_BODY/);
 const controller=new AbortController();await assert.rejects(recallProjectMemory({...base(),signal:controller.signal,service:{recall:async()=>{controller.abort();throw controller.signal.reason;}}}),{name:'AbortError'});
});

// MIND-13: what the conversation still holds of earlier recalls is read from its own transcript (OpenViking's /find has
// no exclude_uris / dedup_turns: search.py CONTEXT_ONLY_FIELDS).
const passage = (name, text) => ({ uri: `viking://user/u/peers/forge-p/memories/${name}.md`, expandUri: `viking://user/u/peers/forge-p/memories/${name}.md`, level: 'L2', isLeaf: true, availableReads: ['L2'], summary: text });
const attachedTurn = (id, rows, wrapped = false) => ({ id, role: 'user', source: 'user', content: [{ type: 'text', text: 'Earlier request' }], context: [{ source: 'project-memory', text: JSON.stringify(wrapped ? { strategy: 'progressive', entries: rows } : rows) }] });
test('attached passages are read after the newest compaction boundary only, and only when attached whole', () => {
  const a = passage('a', 'Alpha decision.'), b = passage('b', 'Beta decision.'), c = passage('c', 'Gamma decision.');
  const messages = [attachedTurn('m1', [a]), { id: 'm2', role: 'assistant', content: [] }, attachedTurn('m3', [b, { ...c, summary: 'Gamma', truncated: true }], true), { id: 'm4', role: 'user', context: [{ source: 'project-evidence', text: JSON.stringify([passage('d', 'other source')]) }] }];
  const all = attachedMemoryPassages({ messages });
  assert.deepEqual([...all.keys()].map(uri => uri.split('/').at(-1)), ['a.md', 'b.md']);
  assert.ok(all.get(a.uri).has(passageHash('Alpha decision.')));
  // Behind the boundary the passage was summarized away: the model no longer holds it verbatim.
  const compacted = attachedMemoryPassages({ messages, compaction: { throughMessageId: 'm2' } });
  assert.deepEqual([...compacted.keys()].map(uri => uri.split('/').at(-1)), ['b.md']);
  assert.equal(attachedMemoryPassages({ messages: [{ id: 'x', role: 'user', context: [{ source: 'project-memory', text: '{not json' }] }] }).size, 0);
  // An idle summary prepared but not committed yet is committed by the turn's first cold request (SDK economyPoint):
  // what it covers is about to leave the context, so the later of the two boundaries counts.
  const prepared = attachedMemoryPassages({ messages, compaction: null, preparedCompaction: { id: 'idle-1', previousCompactionId: null, throughMessageId: 'm3' } });
  assert.equal(prepared.size, 0, 'everything through m3 is in the prepared summary');
  const both = attachedMemoryPassages({ messages, compaction: { throughMessageId: 'm2' }, preparedCompaction: { throughMessageId: 'm1' } });
  assert.deepEqual([...both.keys()].map(uri => uri.split('/').at(-1)), ['b.md'], 'a prepared boundary older than the committed one changes nothing');
});

test('a recall skips a passage the conversation holds unchanged, refills its budget with the next one, and leaves a pointer (MIND-13)', async () => {
  const a = passage('a', 'Alpha decision. '.repeat(30)), b = passage('b', 'Beta decision. '.repeat(30)), c = passage('c', 'Gamma decision. '.repeat(30));
  const snapshot = { ...base().snapshot, messages: [attachedTurn('m1', [a])] }, model = { contextWindow: 64000, maxOutputTokens: 2000 }, policy = { contextBudget: 700, limit: 5 };
  // The service as memory-service packs (one budget, every candidate returned whole for a later re-pack).
  const service = { recall: async (_id, request) => ({ ...packMemoryRecall([a, b, c], request.budgetTokens, { exclude: request.exclude }), candidates: [a, b, c], candidateCount: 3, stage: 'summaries', requested: request }) };
  const fresh = await recallProjectMemory({ ...base(), snapshot: base().snapshot, model, policy, service });
  assert.equal(fresh.projection.injectedEntries[0].uri, a.uri, 'without the earlier attachment the first passage leads');
  const direct = await recallProjectMemory({ ...base(), snapshot, model, policy, service });
  assert.deepEqual(direct.projection.injectedEntries.map(row => row.uri.split('/').at(-1)), ['b.md', 'c.md']);
  assert.equal(direct.projection.deduplicated, 1); assert.deepEqual(direct.projection.alreadyAttached, [a.uri]);
  assert.deepEqual(JSON.parse(direct.reference).alreadyAttached.uris, [a.uri]); assert.doesNotMatch(direct.reference, /Alpha decision/);
  // A turn-start prefetch packed before the transcript was known is packed again from its candidates, without a second search.
  let searches = 0;
  const prefetched = Promise.resolve({ result: { ...packMemoryRecall([a, b, c], 2048), candidates: [a, b, c], candidateCount: 3, stage: 'summaries' } });
  const repacked = await recallProjectMemory({ ...base(), snapshot, model, policy, prefetched, service: { recall: async () => { searches++; throw new Error('no second search'); } } });
  assert.equal(searches, 0);
  assert.deepEqual(repacked.projection.injectedEntries.map(row => row.uri.split('/').at(-1)), ['b.md', 'c.md']); assert.equal(repacked.projection.deduplicated, 1);
  // Only passages already attached: the pointer is all that is attached.
  const only = await recallProjectMemory({ ...base(), snapshot: { ...snapshot, messages: [attachedTurn('m1', [a, b, c])] }, model, policy, service });
  assert.equal(only.projection.execution, 'already_attached'); assert.deepEqual(only.projection.injectedEntries, []);
  assert.deepEqual(JSON.parse(only.reference).entries, []); assert.equal(JSON.parse(only.reference).alreadyAttached.uris.length, 3);
});

test('the memory.filter hook is the decision service\'s, keyed by project and turn or action, and absent when the point is off', async () => {
  const calls = [], decisions = { enabled: point => point === 'memory.filter', memoryFilter: async input => { calls.push(input); return { keep: [1] }; } };
  const hook = memoryFilterHook({ decisions, projectId: 'p', turnId: 'action-1', prompt: 'Task', signal: null });
  assert.deepEqual(await hook([{ uri: 'x' }, { uri: 'y' }]), { keep: [1] });
  assert.deepEqual(calls.map(({ projectId, turnId, prompt, sessionId }) => ({ projectId, turnId, prompt, sessionId })), [{ projectId: 'p', turnId: 'action-1', prompt: 'Task', sessionId: undefined }]);
  assert.equal(memoryFilterHook({ decisions: { ...decisions, enabled: () => false }, projectId: 'p' }), undefined);
  assert.equal(memoryFilterHook({ decisions: undefined, projectId: 'p' }), undefined);
});

test('a turn that will be compacted before its first request deduplicates nothing: an earlier attachment may be summarized away (MIND-13)', async () => {
  const a = passage('a', 'Alpha decision. '.repeat(30)), b = passage('b', 'Beta decision. '.repeat(30));
  const model = { contextWindow: 64000, maxOutputTokens: 2000 }, policy = { contextBudget: 700, limit: 5 };
  const service = { recall: async (_id, request) => ({ ...packMemoryRecall([a, b], request.budgetTokens, { exclude: request.exclude }), candidates: [a, b], candidateCount: 2, stage: 'summaries' }) };
  const snapshot = usage => ({ ...base().snapshot, messages: [attachedTurn('m1', [a])], contextUsage: usage });
  // The SDK compacts before a request once its estimate passes blockingTrigger (contextUsage, its own number).
  const far = await recallProjectMemory({ ...base(), snapshot: snapshot({ estimatedInputTokens: 2000, blockingTrigger: 55600, automaticEnabled: true }), model, policy, service });
  assert.deepEqual(far.projection.injectedEntries.map(row => row.uri.split('/').at(-1)), ['b.md']); assert.equal(far.projection.deduplicated, 1);
  const near = await recallProjectMemory({ ...base(), snapshot: snapshot({ estimatedInputTokens: 2000, blockingTrigger: 2600, automaticEnabled: true }), model, policy, service });
  assert.deepEqual(near.projection.injectedEntries.map(row => row.uri.split('/').at(-1)), ['a.md', 'b.md'], 'attached whole again');
  assert.equal(near.projection.deduplicated, undefined); assert.doesNotMatch(near.reference, /Matched again/);
  // Automatic compaction off: nothing is compacted before the request, so the earlier attachment stays.
  const off = await recallProjectMemory({ ...base(), snapshot: snapshot({ estimatedInputTokens: 2000, blockingTrigger: 2600, automaticEnabled: false }), model, policy, service });
  assert.equal(off.projection.deduplicated, 1);
  // The pointer names the read that brings a passage back if a later compaction took the attachment.
  assert.match(far.reference, /If that attachment is no longer in your context, read these URIs with openviking_read\./);
});
