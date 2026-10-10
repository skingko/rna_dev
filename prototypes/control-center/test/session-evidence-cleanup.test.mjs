import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openJournal } from '../../../packages/sdk/src/journal.mjs';
import { captureSessionEvidence, scrubSessionEvidence, discoverSessionEvidence, purgeSessionEvidenceFiles } from '../session-evidence-cleanup.mjs';
const secret='unique chat body that must be removed';
const hash = text=>createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'rna-evidence-purge-')), file=join(dir,'state.json');
  const session={id:'session-one',projectId:'project-one',items:[{id:'message-one',text:secret}],turns:[{id:'turn-one'}],inbox:[{id:'queued-one',text:secret}],submissions:[{message:{id:'submission-one',text:secret}}]};
  const project={id:session.projectId,observations:[{id:'observation-one',text:secret,status:'pending',data:{messageId:'message-one',sessionId:session.id}},{id:'observation-other',text:'keep observation',data:{sessionId:'session-other'}}],facts:[{id:'fact-one',evidenceId:'observation-one',text:secret},{id:'fact-other',evidenceId:'observation-other',text:'keep fact'}],jobs:[],decisions:[],initiativeRuntime:{sdkState:{usedTokens:100,reservedTokens:0,estimatedTokens:2,events:[],actions:[]}}};
  const state={projects:[project],sessions:[session],events:[]};
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const record=()=>({sessionId:session.id,projectId:project.id,evidence:captureSessionEvidence(state,session)});
  const archive=(kind,value,pid=project.id)=>{const text=JSON.stringify(value),path=join(`${file}.archive`,'initiative',pid,kind,`${hash(text)}.json`);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,text);return path;};
  const journal=(actionId,{source=session.id,evidence=[],uncertain=false,complete=false,closed=true,projectId=project.id}={})=>{const directory=join(`${file}.rna`,'initiative',projectId,actionId),handle=openJournal({stateDir:directory,sessionId:actionId,projectId});handle.append('inbox_added',{item:{context:[{source:'project-evidence',text:JSON.stringify({project:{recentConversation:[{sessionId:source,id:source===session.id?'message-one':'other-message',text:source===session.id?secret:'keep context'}]},evidence})}]}});if(uncertain){handle.append('tool_intent',{callKey:'call-1',toolName:'project_exec',arguments:{command:secret},effect:'write',idempotent:false});handle.append('tool_uncertain',{callKey:'call-1',code:'cleanup_uncertain'});}if(complete)handle.append('tool_completed',{callKey:'call-1',result:{content:[{type:'text',text:'actual tool outcome'}]}});if(closed)handle.close();return {directory,file:handle.file,handle};};
  return {dir,file,state,session,project,record,archive,journal};
}
const action=(id,evidenceIds,extra={})=>({id,action:'work',status:'completed',evidenceIds,content:secret,reason:secret,resultSummary:secret,intentKey:'a'.repeat(64),usage:{totalTokens:47},...extra});

test('search history deletion follows transitive and cyclic version sources, including artifacts missing hot records', async t => {
  const f = fixture(t);
  f.project.versions = [
    { id: 'derived-two', searchSourceVersionIds: ['derived-one'], searchSummary: { text: secret } },
    { id: 'derived-one', searchSourceVersionIds: ['source-version', 'derived-two'], searchReview: { hypothesis: secret } },
    { id: 'source-version', evidenceIds: ['message-one'], proposal: { hypothesis: secret } },
    { id: 'unrelated', searchSourceVersionIds: [], proposal: { hypothesis: 'keep' } },
  ];
  const files = [];
  for (const [id, sources] of [['source-version', []], ['derived-one', ['source-version']], ['derived-two', ['derived-one']], ['orphan-z', ['derived-two']], ['orphan-a', ['orphan-z']]]) {
    const dir = join(`${f.file}.evolution`, f.project.id, id); mkdirSync(dir, { recursive: true });
    const path = join(dir, 'search-policy.json'); writeFileSync(path, JSON.stringify({ sourceVersionIds: sources, policy: { history: [{ hypothesis: secret }] } })); files.push(path);
  }
  const record = f.record(); assert.deepEqual(new Set(record.evidence.evolutionVersionIds), new Set(['source-version', 'derived-one', 'derived-two']));
  record.evidence = await discoverSessionEvidence(f.file, record, { state: f.state });
  assert.ok(record.evidence.evolutionVersionIds.includes('orphan-a')); assert.ok(record.evidence.evolutionVersionIds.includes('orphan-z'));
  scrubSessionEvidence(f.state, record); await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true });
  assert.equal(JSON.stringify(f.project.versions).includes(secret), false); assert.equal(f.project.versions.find(row => row.id === 'unrelated').proposal.hypothesis, 'keep');
  assert.ok(files.every(path => !existsSync(path)));
});

for (const provenance of ['receipt', 'retained-source']) test(`deleting a steering conversation removes derived action text and journals through ${provenance}`, async t => {
  const f = fixture(t), id = 'steered-from-another-session';
  f.project.initiativeRuntime.sdkState.actions.push(action(id, [], provenance === 'receipt'
    ? { controls: [{ id: 'steer-one', kind: 'steer', sourceSessionId: f.session.id, instruction: secret, status: 'applied' }] }
    : { controlSourceSessionIds: [f.session.id], controls: [] }));
  // The original action came from another conversation. Only the later command
  // links it to this deletion, even after its bounded receipt history is pruned.
  const owned = f.journal(id, { source: 'session-other' }), keep = f.journal('unrelated-journal', { source: 'session-other' });
  const record = f.record(); assert.ok(record.evidence.actionIds.includes(id));
  record.evidence = await discoverSessionEvidence(f.file, record, { state: f.state });
  scrubSessionEvidence(f.state, record);
  const retained = f.project.initiativeRuntime.sdkState.actions.find(row => row.id === id);
  assert.equal(retained.contextRevoked, true); assert.equal(retained.controls, undefined); assert.equal(JSON.stringify(retained).includes(secret), false);
  await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true });
  assert.equal(existsSync(owned.directory), false); assert.equal(existsSync(keep.directory), true);
});

test('SDK execution captures are recognized and removed only with their linked settled journal', async t => {
  const f = fixture(t), owned = f.journal('with-exec'), other = f.journal('other-exec', { source: 'other-session' });
  for (const log of [owned, other]) { const dir = join(log.directory, 'exec', 'rna-exec-Ab12_-'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'output.log'), secret); }
  const record = f.record(); record.evidence = await discoverSessionEvidence(f.file, record, { state: f.state });
  const result = await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true });
  assert.equal(result.removedJournals, 1); assert.equal(existsSync(owned.directory), false); assert.equal(existsSync(other.directory), true);
});

test('long valid journals are streamed beyond the old whole-file limit while validating every record', async t => {
  const f = fixture(t), log = f.journal('long-running', { closed: false });
  const content = 'long-running-evidence '.repeat(50000);
  for (let i = 0; i < 34; i++) log.handle.append('diagnostic', { content });
  log.handle.close();
  const record = f.record(); record.evidence = await discoverSessionEvidence(f.file, record, { state: f.state });
  assert.deepEqual(record.evidence.journalActionIds, ['long-running']);
  await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true });
  assert.equal(existsSync(log.directory), false);
});

test('execution captures do not bypass active writers, unknown effects, links or unknown files', async t => {
  for (const variant of ['live', 'uncertain', 'symlink', 'unknown']) await t.test(variant, async t => {
    const f = fixture(t), log = f.journal('guarded-exec', { closed: variant !== 'live', uncertain: variant === 'uncertain' });
    if (variant === 'live') t.after(() => log.handle.close());
    const dir = join(log.directory, 'exec', 'rna-exec-Ab12_-'); mkdirSync(dir, { recursive: true });
    if (variant === 'symlink') symlinkSync(f.dir, join(dir, 'output.log'));
    else writeFileSync(join(dir, variant === 'unknown' ? 'unowned.txt' : 'output.log'), secret);
    const code = { live: 'SESSION_BACKGROUND_CLEANUP_PENDING', uncertain: 'SESSION_BACKGROUND_EXECUTION_UNCONFIRMED', symlink: 'SESSION_EVIDENCE_STORAGE_UNSAFE', unknown: 'SESSION_EVIDENCE_JOURNAL_UNKNOWN' }[variant];
    await assert.rejects(discoverSessionEvidence(f.file, f.record(), { state: f.state }), { code });
    assert.equal(existsSync(log.file), true);
  });
});

test('deleting a learning source removes snapshots and reflection text, preserving bills, bundles and unrelated experiments', async t => {
  const f = fixture(t), id = `episode:turn:${f.session.id}:turn-one:abcdef0123456789`, key = 'a'.repeat(64), otherKey = 'b'.repeat(64);
  f.project.learningRuntime = { usage: { totalTokens: 90, reservedTokens: 12 }, sdkState: { schemaVersion: 1, seen: [key, otherKey], nextReviewAt: 0,
    episodes: [{ id, key, sourceIds: [`session:${f.session.id}`], summary: secret, reviewId: 'review-one' }, { id: 'episode:turn:session-other:turn-other:abcdef0123456789', key: otherKey, sourceIds: ['session:session-other'], summary: 'keep unrelated evidence', reviewId: 'review-other' }],
    reviews: [{ id: 'review-one', status: 'completed', sourceIds: [`session:${f.session.id}`], episodeKeys: [key], decision: { hypothesis: secret }, result: { status: 'ready', versionId: 'version-one', summary: secret }, usage: { totalTokens: 90 } }, { id: 'review-other', status: 'completed', sourceIds: ['session:session-other'], episodeKeys: [otherKey], decision: { hypothesis: 'keep unrelated reflection' } }] } };
  f.project.versions = [{ id: 'version-one', evidenceIds: [id], learningReviewId: 'review-one', learningIntent: { content: secret }, proposal: { diagnosis: { explanation: secret } }, bundle: { hash: 'c'.repeat(64), dir: 'keep generated package' }, usage: { totalTokens: 90 }, evaluation: { gatePassed: true, evaluationComplete: true, baselineScore: .7, candidateScore: .9, gates: { improvement: true }, details: [{ answer: secret }] } }, { id: 'version-other', evidenceIds: ['episode:turn:session-other:turn-other:abcdef0123456789'], proposal: { summary: 'keep independent version' } }];
  const versionDir = join(`${f.file}.evolution`, f.project.id, 'version-one'), otherDir = join(`${f.file}.evolution`, f.project.id, 'version-other'); mkdirSync(versionDir, { recursive: true }); mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(versionDir, 'learning-context.json'), JSON.stringify({ schemaVersion: 1, evidence: [{ id, content: secret }], files: [] }));
  writeFileSync(join(versionDir, 'evidence.json'), JSON.stringify({ schemaVersion: 1, evidence: [{ id, summary: secret }] }));
  writeFileSync(join(versionDir, 'learning-intent.json'), JSON.stringify({ learningIntent: { content: secret, evidenceIds: [id] } }));
  writeFileSync(join(versionDir, 'proposal.json'), JSON.stringify({ summary: secret, genome: { systemPrompt: secret } }));
  writeFileSync(join(versionDir, 'trace.jsonl'), JSON.stringify({ type: 'model_request', at: '2026-09-25T13:00:00Z', usage: { totalTokens: 90 }, body: secret }) + '\n');
  writeFileSync(join(versionDir, 'evaluation.json'), JSON.stringify(f.project.versions[0].evaluation));
  writeFileSync(join(versionDir, 'frozen-evaluation.json'), 'keep immutable standards');
  writeFileSync(join(otherDir, 'learning-context.json'), JSON.stringify({ schemaVersion: 1, evidence: [{ id: 'episode:turn:session-other:turn-other:abcdef0123456789', content: 'keep unrelated snapshot' }], files: [] }));
  const bundle = join(`${f.file}.genomes`, 'retained'); mkdirSync(bundle, { recursive: true }); writeFileSync(join(bundle, 'SKILL.md'), 'keep generated skill');
  const archiveRow = { ...f.project.learningRuntime.sdkState.reviews[0], decision: { diagnosis: secret } }, archiveText = JSON.stringify(archiveRow), archiveRoot = join(`${f.file}.archive`, 'learning', f.project.id, 'reviews'), archivePath = join(archiveRoot, `${hash(archiveText)}.json`); mkdirSync(archiveRoot, { recursive: true }); writeFileSync(archivePath, archiveText);
  const record = f.record(); assert.equal(JSON.stringify(record).includes(secret), false); assert.deepEqual(record.evidence.learningEpisodeKeys, [key]); assert.deepEqual(record.evidence.evolutionVersionIds, ['version-one']);
  record.evidence = await discoverSessionEvidence(f.file, record, { state: f.state }); scrubSessionEvidence(f.state, record);
  assert.equal(f.project.learningRuntime.sdkState.episodes.length, 1); assert.equal(f.project.learningRuntime.sdkState.episodes[0].key, otherKey);
  assert.equal(JSON.stringify(f.project.learningRuntime).includes(secret), false); assert.equal(f.project.learningRuntime.usage.totalTokens, 90); assert.equal(f.project.learningRuntime.usage.reservedTokens, 12);
  assert.equal(f.project.versions[0].sourceDeleted, true); assert.equal(f.project.versions[0].bundle.dir, 'keep generated package'); assert.equal(f.project.versions[0].evaluation.candidateScore, .9); assert.equal(f.project.versions[0].evaluation.details, undefined); assert.equal(f.project.versions[1].proposal.summary, 'keep independent version');
  const result = await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true }); assert.equal(result.scrubbedLearningArchives, 1); assert.equal(result.scrubbedEvolutionArtifacts, 6);
  assert.equal(existsSync(join(versionDir, 'learning-context.json')), false); assert.equal(existsSync(join(versionDir, 'evidence.json')), false); assert.equal(existsSync(archivePath), false);
  for (const name of ['learning-intent.json', 'proposal.json', 'evaluation.json', 'trace.jsonl']) assert.equal(readFileSync(join(versionDir, name), 'utf8').includes(secret), false);
  assert.equal(readFileSync(join(versionDir, 'frozen-evaluation.json'), 'utf8'), 'keep immutable standards'); assert.equal(readFileSync(join(bundle, 'SKILL.md'), 'utf8'), 'keep generated skill'); assert.match(readFileSync(join(otherDir, 'learning-context.json'), 'utf8'), /keep unrelated snapshot/);
  assert.equal(readFileSync(join(archiveRoot, readdirSync(archiveRoot)[0]), 'utf8').includes(secret), false);
  const second = await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true }); assert.deepEqual(second, { removedArchives: 0, removedJournals: 0 });
});

test('late learning snapshots are discovered after the session and hot project state disappear', async t => {
  const f = fixture(t), record = f.record(), id = `episode:turn:${f.session.id}:turn-one:abcdef0123456789`;
  f.state.projects = [];
  const dir = join(`${f.file}.evolution`, f.project.id, 'late-version'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'learning-context.json'), JSON.stringify({ evidence: [{ id, content: secret }], files: [] }));
  record.evidence = await discoverSessionEvidence(f.file, record, { state: f.state }); assert.deepEqual(record.evidence.evolutionVersionIds, ['late-version']);
  await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true }); assert.equal(existsSync(join(dir, 'learning-context.json')), false);
});
test('an author failure with only exact evidence persisted remains discoverable and deletable without removing an unrelated snapshot', async t => {
  const f = fixture(t), record = f.record(), id = `episode:turn:${f.session.id}:turn-one:abcdef0123456789`;
  const dir = join(`${f.file}.evolution`, f.project.id, 'author-failed'), other = join(`${f.file}.evolution`, f.project.id, 'other-failed'); mkdirSync(dir, { recursive: true }); mkdirSync(other);
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ schemaVersion: 1, evidence: [{ id, summary: secret }] }));
  writeFileSync(join(other, 'evidence.json'), JSON.stringify({ schemaVersion: 1, evidence: [{ id: 'episode:turn:session-other:turn-other:abcdef0123456789', summary: 'Retain other session' }] }));
  f.state.projects = [];
  record.evidence = await discoverSessionEvidence(f.file, record, { state: f.state }); assert.deepEqual(record.evidence.evolutionVersionIds, ['author-failed']);
  await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true }); assert.equal(existsSync(join(dir, 'evidence.json')), false); assert.match(readFileSync(join(other, 'evidence.json'), 'utf8'), /Retain other session/);
});
test('an orphan author no-change review remains attributable through its retained evidence references and keeps only billing receipts after deletion', async t => {
  const f = fixture(t), record = f.record(), id = `episode:turn:${f.session.id}:turn-one:abcdef0123456789`;
  const dir = join(`${f.file}.evolution`, f.project.id, 'no-change-orphan'), other = join(`${f.file}.evolution`, f.project.id, 'other-no-change'); mkdirSync(dir, { recursive: true }); mkdirSync(other);
  writeFileSync(join(dir, 'author-review.json'), JSON.stringify({ schemaVersion: 1, status: 'no_change', abstention: { reason: 'no_method_gap', summary: secret, explanation: secret, evidenceIds: [id], revisitWhen: [{ condition: 'new_work_evidence', description: secret }] }, usage: { totalTokens: 71 } }));
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: 'no_change', candidateGenerated: false, versionId: 'no-change-orphan', summary: secret, usage: { totalTokens: 71 }, requests: [{ response: secret }] }));
  writeFileSync(join(other, 'author-review.json'), JSON.stringify({ status: 'no_change', abstention: { evidenceIds: ['episode:turn:session-other:turn-other:abcdef0123456789'], explanation: 'Retain unrelated review' } }));
  f.state.projects = [];
  record.evidence = await discoverSessionEvidence(f.file, record, { state: f.state }); assert.deepEqual(record.evidence.evolutionVersionIds, ['no-change-orphan']);
  await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true });
  assert.equal(existsSync(join(dir, 'author-review.json')), false); assert.match(readFileSync(join(other, 'author-review.json'), 'utf8'), /Retain unrelated review/);
  const retained = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')); assert.equal(retained.status, 'no_change'); assert.equal(retained.usage.totalTokens, 71); assert.equal(JSON.stringify(retained).includes(secret), false); assert.equal(retained.requests, undefined);
});
test('a feedback-only snapshot remains attributable after its consumed interaction and episode were pruned', async t => {
  const f = fixture(t), record = f.record(), id = `episode:feedback:${f.session.id}:answer-one:abcdef0123456789`;
  const dir = join(`${f.file}.evolution`, f.project.id, 'feedback-version'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'learning-context.json'), JSON.stringify({ evidence: [{ id, content: secret }], files: [] }));
  record.evidence = await discoverSessionEvidence(f.file, record, { state: f.state }); assert.deepEqual(record.evidence.evolutionVersionIds, ['feedback-version']);
  await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true }); assert.equal(existsSync(join(dir, 'learning-context.json')), false);
});
test('orphan uncertainty review cleanup uses host source identities independently of empty model citations', async t => {
  const f = fixture(t), record = f.record(), id = `episode:turn:${f.session.id}:turn-one:abcdef0123456789`;
  const dir = join(`${f.file}.evolution`, f.project.id, 'uncited-no-change'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'author-review.json'), JSON.stringify({ schemaVersion: 1, status: 'no_change', sourceEvidenceIds: [id], abstention: { reason: 'insufficient_evidence', summary: secret, explanation: secret, evidenceIds: [] }, usage: { totalTokens: 71 } }));
  f.state.projects = [];
  record.evidence = await discoverSessionEvidence(f.file, record, { state: f.state }); assert.deepEqual(record.evidence.evolutionVersionIds, ['uncited-no-change']);
  await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true }); assert.equal(existsSync(join(dir, 'author-review.json')), false);
});
test('malformed host source identities stop cleanup rather than silently leaving an unattributed review', async t => {
  const f = fixture(t), dir = join(`${f.file}.evolution`, f.project.id, 'invalid-source-list'); mkdirSync(dir, { recursive: true });
  for (const sourceEvidenceIds of ['message-one', [null], [{ id: 'message-one' }]]) {
    writeFileSync(join(dir, 'author-review.json'), JSON.stringify({ sourceEvidenceIds, abstention: { evidenceIds: [], explanation: secret } }));
    await assert.rejects(discoverSessionEvidence(f.file, f.record(), { state: f.state }), { code: 'SESSION_EVIDENCE_ARCHIVE_INVALID' });
    assert.equal(existsSync(join(dir, 'author-review.json')), true);
  }
});

test('evolution cleanup refuses a linked managed root and cannot unlink arbitrary state artifactDir paths', async t => {
  const f = fixture(t), outside = join(f.dir, 'unrelated'); mkdirSync(outside); writeFileSync(join(outside, 'learning-context.json'), secret); symlinkSync(outside, `${f.file}.evolution`);
  f.project.versions = [{ id: 'version-one', evidenceIds: ['message:message-one'], artifactDir: outside }];
  await assert.rejects(discoverSessionEvidence(f.file, f.record(), { state: f.state }), { code: 'SESSION_EVIDENCE_STORAGE_UNSAFE' }); assert.equal(readFileSync(join(outside, 'learning-context.json'), 'utf8'), secret);
});

test('project deletion preserves an existing explicit resolution before removing the hot project state', async t => {
  const f = fixture(t), original = action('resolved-work', ['message:message-one'], { status: 'needs_review', blocksExecution: true });
  f.archive('actions', original);
  const log = f.journal(original.id, { uncertain: true });
  f.project.initiativeRuntime.sdkState.actions.push({ ...original, status: 'cancelled', resolvedAt: 1000, resolutionSource: 'user' });
  const record = f.record(); assert.deepEqual(record.evidence.resolvedActionIds, [original.id]);
  f.state.projects = [];
  record.evidence = await discoverSessionEvidence(f.file, record, { state: f.state });
  await purgeSessionEvidenceFiles(f.file, record, { writersSettled: true });
  assert.equal(existsSync(log.directory), false);
});

test('capture persists only identities and follows message, turn, observation and result-action references',t=>{
  const f=fixture(t),sdk=f.project.initiativeRuntime.sdkState;
  sdk.actions=[action('action-one',['message:message-one']),action('action-two',['action:action-one:completed']),action('unrelated',['message:other'])];
  const record=f.record();assert.deepEqual(record.evidence.actionIds,['action-one','action-two']);assert.deepEqual(record.evidence.observationIds,['observation-one']);
  assert.deepEqual(record.evidence.messageIds,['message-one','queued-one','submission-one']);assert.equal(JSON.stringify(record).includes(secret),false);assert.equal(record.evidence.discovered,undefined);
});

test('hot scrub removes raw projections while preserving accounting, uncertainty and unrelated project evidence',t=>{
  const f=fixture(t),sdk=f.project.initiativeRuntime.sdkState;
  sdk.actions=[action('action-one',['turn:turn-one:completed'],{status:'needs_review',blocksExecution:true,failure:{id:'failure-one',code:'tool_uncertain',message:secret}}),action('other-action',['message:other'])];
  sdk.events=[{id:'message:message-one',summary:secret},{id:'action:action-one:completed',summary:secret},{id:'message:other',summary:'keep event'}];sdk.lastDecision={action:'share',reason:secret,content:secret,evidenceIds:['message:message-one']};sdk.lastFailure={id:'failure-one',code:'tool_uncertain',message:secret};
  f.project.decisions=[{id:'decision-one',evidenceIds:['observation:observation-one'],content:secret,reason:secret}];f.project.jobs=[{...sdk.actions[0],instruction:secret,output:secret,toolReceipts:[{toolCallId:'read-one',output:secret,status:'completed'}],toolReceiptCounts:{total:1,completed:1}}];
  const record=f.record();scrubSessionEvidence(f.state,record);
  assert.equal(sdk.usedTokens,100);assert.equal(sdk.estimatedTokens,2);assert.equal(sdk.actions[0].blocksExecution,true);assert.equal(sdk.actions[0].status,'needs_review');assert.equal(sdk.actions[0].usage.totalTokens,47);assert.equal(sdk.actions[0].failure.code,'tool_uncertain');
  assert.deepEqual(sdk.events,[{id:'message:other',summary:'keep event'}]);assert.equal(sdk.actions[1].content,secret,'unrelated record is not guessed from text');assert.equal(f.project.facts.length,1);assert.equal(f.project.observations[1].text,'keep observation');
  assert.equal(JSON.stringify({...sdk,actions:[sdk.actions[0]]}).includes(secret),false);assert.equal(JSON.stringify(f.project.decisions).includes(secret),false);assert.equal(JSON.stringify(f.project.jobs).includes(secret),false);
  assert.equal(f.project.jobs[0].toolReceipts,undefined);assert.equal(f.project.jobs[0].toolReceiptCounts,undefined);
});

test('discovery finds uncited recent-conversation context in owned journals and transitive archives, then preserves only receipts',async t=>{
  const f=fixture(t),record=f.record();
  const direct=f.archive('actions',action('action-context',['message:unrelated'],{failure:{id:'failure-context',code:'http_error',message:secret}}));
  const descendant=f.archive('actions',action('action-descendant',['action:action-context:completed']));
  const failure=f.archive('failures',{id:'failure-context',message:secret,code:'http_error',at:123,request:{responseSha256:'d'.repeat(64)}});
  const job=f.archive('jobs',{id:'action-context',instruction:secret,output:secret,runtimeFile:join(f.dir,'project.txt'),status:'completed',usage:{totalTokens:47}});
  const keep=f.archive('actions',action('unrelated',['observation:unrelated']));
  const foreign=f.archive('actions',action('foreign',['message:message-one']),'other-project');
  const owned=f.journal('action-context'),other=f.journal('action-other',{source:'other-session'});
  writeFileSync(join(f.dir,'project.txt'),'keep project');writeFileSync(f.file+'.before-projects-backup',secret);
  record.evidence=await discoverSessionEvidence(f.file,record,{state:f.state});
  assert.ok(record.evidence.actionIds.includes('action-context'));assert.ok(record.evidence.actionIds.includes('action-descendant'));assert.deepEqual(record.evidence.journalActionIds,['action-context']);assert.equal(JSON.stringify(record.evidence).includes(secret),false);
  const result=await purgeSessionEvidenceFiles(f.file,record,{writersSettled:true});assert.equal(result.removedArchives,4);assert.equal(result.removedJournals,1);
  for(const path of [direct,descendant,failure,job])assert.equal(existsSync(path),false);
  assert.equal(existsSync(owned.directory),false);assert.equal(existsSync(other.file),true);assert.equal(existsSync(keep),true);assert.equal(existsSync(foreign),true);assert.equal(readFileSync(join(f.dir,'project.txt'),'utf8'),'keep project');assert.equal(readFileSync(f.file+'.before-projects-backup','utf8'),secret);
  const directory=join(`${f.file}.archive`,'initiative',f.project.id,'jobs'),receipt=JSON.parse(readFileSync(join(directory,readdirSync(directory)[0]),'utf8'));assert.equal(receipt.usage.totalTokens,47);assert.equal(receipt.output,undefined);assert.equal(receipt.runtimeFile,undefined);
  assert.deepEqual(await purgeSessionEvidenceFiles(f.file,record,{writersSettled:true}),{removedArchives:0,removedJournals:0});
});

test('late action discovered after capture is included before the final repeated hot scrub',async t=>{
  const f=fixture(t),record=f.record();f.project.initiativeRuntime.sdkState.actions.push(action('late-action',['message:message-one']));f.project.jobs.push({id:'late-action',output:secret,status:'completed'});f.journal('late-action');
  record.evidence=await discoverSessionEvidence(f.file,record,{state:f.state});scrubSessionEvidence(f.state,record);assert.equal(f.project.jobs[0].output,undefined);assert.ok(record.evidence.actionIds.includes('late-action'));await purgeSessionEvidenceFiles(f.file,record,{writersSettled:true});
});

test('unknown external execution retains its journal and archive until an explicit whole-action resolution',async t=>{
  const f=fixture(t),a=action('action-uncertain',['message:message-one'],{status:'needs_review',blocksExecution:true});f.project.initiativeRuntime.sdkState.actions.push(a);const path=f.archive('actions',a),log=f.journal(a.id,{uncertain:true});const record=f.record();
  await assert.rejects(discoverSessionEvidence(f.file,record,{state:f.state}),{code:'SESSION_BACKGROUND_EXECUTION_UNCONFIRMED'});assert.equal(existsSync(path),true);assert.equal(existsSync(log.file),true);
  // Resolution supersedes archived unknown receipts, but does not replay/alter the SDK log.
  a.status='cancelled';a.resolvedAt=Date.now();a.resolutionSource='user';a.blocksExecution=false;
  record.evidence=await discoverSessionEvidence(f.file,record,{state:f.state});assert.deepEqual(record.evidence.resolvedActionIds,[a.id]);await purgeSessionEvidenceFiles(f.file,record,{writersSettled:true});assert.equal(existsSync(log.directory),false);
});

test('an unreported uncertain tool in an otherwise completed action is not silently deleted',async t=>{
  const f=fixture(t),a=action('uncertain-log',['message:message-one']);f.project.initiativeRuntime.sdkState.actions.push(a);const log=f.journal(a.id,{uncertain:true});
  await assert.rejects(discoverSessionEvidence(f.file,f.record(),{state:f.state}),{code:'SESSION_BACKGROUND_EXECUTION_UNCONFIRMED'});assert.equal(existsSync(log.file),true);
});

test('live journal writer and missing writer settlement gate both remain pending',async t=>{
  const f=fixture(t),record=f.record(),log=f.journal('live-action',{closed:false});
  await assert.rejects(discoverSessionEvidence(f.file,record,{state:f.state}),{code:'SESSION_BACKGROUND_CLEANUP_PENDING'});log.handle.close();
  record.evidence=await discoverSessionEvidence(f.file,record,{state:f.state});await assert.rejects(purgeSessionEvidenceFiles(f.file,record),{code:'SESSION_BACKGROUND_CLEANUP_PENDING'});assert.equal(existsSync(log.file),true);
});

for(const suffix of ['.archive','.rna'])test(`refuse symlinked managed ${suffix} root without touching its target`,async t=>{
  const f=fixture(t),outside=join(f.dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep'),secret);symlinkSync(outside,f.file+suffix);
  await assert.rejects(discoverSessionEvidence(f.file,f.record(),{state:f.state}),{code:'SESSION_EVIDENCE_STORAGE_UNSAFE'});assert.equal(readFileSync(join(outside,'keep'),'utf8'),secret);
});

test('archive hash mismatch or journal identity mismatch never authorizes deletion',async t=>{
  const f=fixture(t),path=f.archive('actions',action('owned',['message:message-one']));writeFileSync(path,'{}');await assert.rejects(discoverSessionEvidence(f.file,f.record(),{state:f.state}),{code:'SESSION_EVIDENCE_ARCHIVE_INVALID'});assert.equal(existsSync(path),true);
  rmSync(`${f.file}.archive`,{recursive:true});const log=f.journal('owned');const rows=readFileSync(log.file,'utf8').trim().split('\n').map(JSON.parse);rows[0].data.projectId='other';writeFileSync(log.file,rows.map(JSON.stringify).join('\n')+'\n');await assert.rejects(discoverSessionEvidence(f.file,f.record(),{state:f.state}),{code:'SESSION_EVIDENCE_JOURNAL_INVALID'});assert.equal(existsSync(log.file),true);
});

test('bounded evidence scans stop with pending rather than claiming unread large files were cleaned',async t=>{
  const f=fixture(t),log=f.journal('oversized');truncateSync(log.file,33*1024*1024);await assert.rejects(discoverSessionEvidence(f.file,f.record(),{state:f.state}),{code:'SESSION_EVIDENCE_READ_LIMIT'});assert.equal(existsSync(log.file),true);
});

test('normal read cancellation keeps an honest needs-review receipt but needs no side-effect resolution',async t=>{
  const f=fixture(t),a=action('read-cancelled',['message:message-one'],{status:'needs_review'});f.project.initiativeRuntime.sdkState.actions.push(a);const log=f.journal(a.id,{closed:false});
  log.handle.append('tool_intent',{callKey:'read-call',toolName:'project_read',effect:'read',idempotent:true,arguments:{path:'README.md'}});log.handle.append('tool_uncertain',{callKey:'read-call'});log.handle.close();
  const record=f.record();record.evidence=await discoverSessionEvidence(f.file,record,{state:f.state});scrubSessionEvidence(f.state,record);assert.equal(f.project.initiativeRuntime.sdkState.actions[0].status,'needs_review');await purgeSessionEvidenceFiles(f.file,record,{writersSettled:true});assert.equal(existsSync(log.directory),false);
});

test('requiresResolution on a read tool overrides read/idempotent while a legacy uncertain job also blocks without a journal',async t=>{
  const f=fixture(t),a=action('read-process-uncertain',['message:message-one']);f.project.initiativeRuntime.sdkState.actions.push(a);const log=f.journal(a.id,{closed:false});
  log.handle.append('tool_intent',{callKey:'read-call',effect:'read',idempotent:true});log.handle.append('tool_uncertain',{callKey:'read-call',requiresResolution:true,details:{cleanupUncertain:true}});log.handle.close();
  await assert.rejects(discoverSessionEvidence(f.file,f.record(),{state:f.state}),{code:'SESSION_BACKGROUND_EXECUTION_UNCONFIRMED'});rmSync(log.directory,{recursive:true});f.project.jobs.push({id:a.id,status:'needs_review',errorCode:'uncertain_tool'});await assert.rejects(discoverSessionEvidence(f.file,f.record(),{state:f.state}),{code:'SESSION_BACKGROUND_EXECUTION_UNCONFIRMED'});
});

test('SDK-recovered torn sidecars are owned attachments; unrelated recovered logs remain untouched',async t=>{
  const f=fixture(t),owned=f.journal('recovered'),other=f.journal('recovered-other',{source:'other'});
  for(const log of [owned,other]) {writeFileSync(log.file,readFileSync(log.file,'utf8')+'{"torn":"partial original text');const actionId=log===owned?'recovered':'recovered-other';openJournal({stateDir:log.directory,sessionId:actionId,projectId:f.project.id}).close();assert.ok(readdirSync(log.directory).some(name=>name.includes('.torn-')));}
  const record=f.record();record.evidence=await discoverSessionEvidence(f.file,record,{state:f.state});await purgeSessionEvidenceFiles(f.file,record,{writersSettled:true});assert.equal(existsSync(owned.directory),false);assert.equal(existsSync(other.directory),true);
});

test('journal-only action descendants follow structured evidence IDs even without hot or archived action rows',async t=>{
  const f=fixture(t),first=f.journal('z-first'),second=f.journal('a-second',{source:'other',evidence:[{id:'action:z-first:completed',summary:secret}]});
  const record=f.record();record.evidence=await discoverSessionEvidence(f.file,record,{state:f.state});assert.deepEqual(record.evidence.actionIds.sort(),['a-second','z-first']);await purgeSessionEvidenceFiles(f.file,record,{writersSettled:true});assert.equal(existsSync(first.directory),false);assert.equal(existsSync(second.directory),false);
});
