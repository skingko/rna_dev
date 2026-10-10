import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { retainEvaluationScreenshot, pairedVisualEvidence, frozenResearchEvidence, sourceClaimInventory, sourceReviewSchema, validateSourceReview, evaluationRequestReserve } from '../src/project-evaluation-evidence.mjs';
import { validateToolArguments } from '../src/capabilities.mjs';
import { evaluateProjectGenomes, executeProjectEvaluationCase } from '../src/project-evolution.mjs';
import { validateProjectGenome } from '../src/project-genome.mjs';
import { projectGenomeFixture } from './fixtures/project-genome.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 4096, input: ['text'] };
function png() { const bytes = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.write('IHDR', 12); bytes.writeUInt32BE(800, 16); bytes.writeUInt32BE(600, 20); return bytes; }
function shot() { const bytes = png(), receipt = { screenshot: { mimeType: 'image/png', bytes: bytes.length, hash: hash(bytes), width: 800, height: 600, path: '/private/baseline-secret.png' } }; retainEvaluationScreenshot(receipt, bytes); return receipt; }
const visualCase = { environment: { kind: 'browser', visualReview: true } };

test('paired screenshots use actual private host capture and never load paths or replayed receipt JSON', () => {
  const left = { environment: shot() }, right = { environment: shot() }, vision = { ...model, input: ['text', 'image'] };
  const result = pairedVisualEvidence({ testCase: visualCase, model: vision, left, right });
  assert.equal(result.receipt.status, 'provided_to_visual_judge'); assert.equal(result.content.filter(part => part.type === 'image').length, 2);
  assert.ok(!JSON.stringify(result).includes('/private/')); assert.ok(!JSON.stringify(result).includes('baseline'));
  assert.throws(() => pairedVisualEvidence({ testCase: visualCase, model: vision, left: structuredClone(left), right }), { code: 'evaluation_visual_evidence_unavailable' });
  const optional = pairedVisualEvidence({ testCase: { environment: { kind: 'browser' } }, model: vision, left: { environment: { screenshot: { ...left.environment.screenshot, path: '/etc/passwd' } } }, right });
  assert.equal(optional.receipt.status, 'not_assessed_host_pixels_unavailable'); assert.deepEqual(optional.content, []);
});
test('changed screenshot identity and undeclared model vision cannot acquire visual credit', () => {
  const left = { environment: shot() }, right = { environment: shot() };
  assert.throws(() => pairedVisualEvidence({ testCase: visualCase, model, left, right }), { code: 'evaluation_visual_model_required' });
  const optional = pairedVisualEvidence({ testCase: { environment: { kind: 'browser' } }, model, left, right });
  assert.equal(optional.receipt.status, 'not_assessed_model_has_no_image_input'); assert.deepEqual(optional.content, []);
  left.environment.screenshot.width = 801;
  assert.throws(() => pairedVisualEvidence({ testCase: visualCase, model: { ...model, input: ['image'] }, left, right }), { code: 'evaluation_visual_evidence_unavailable' });
});
test('image reservation counts pixel allowance independently from transport base64', () => {
  const image = { type: 'image', mimeType: 'image/png', data: png().toString('base64') }, request = { model: { ...model, input: ['image'] }, messages: [{ role: 'user', content: [image, image] }] };
  assert.ok(evaluationRequestReserve(request) > 2 * 8192 + 4096); assert.ok(evaluationRequestReserve(request) < 2 * 8192 + 4096 + 2000);
  assert.throws(() => evaluationRequestReserve({ ...request, model }), { code: 'image_not_supported' });
});

function researchCase() {
  const body = 'Initial report called the measurement provisional. ' + 'Context. '.repeat(1100) + 'Correction: single-worker result is 51 ms. No multi-worker performance is provided. No revenue was measured.';
  return { domain: { kind: 'research', sources: [{ id: 'source', title: 'Correction', url: 'https://example.test/correction', publishedAt: '2026-09-28T01:00:00Z', body, sha256: hash(body) }], checks: { secret: 'not sent' } } };
}
test('judge sources retain correction after the transcript truncation boundary, identity, dates, and exclude private assertions', () => {
  const fixture = researchCase(), result = frozenResearchEvidence(fixture);
  assert.equal(result.sources[0].body, fixture.domain.sources[0].body); assert.equal(result.truncated, false); assert.ok(result.sources[0].body.includes('No revenue was measured.'));
  assert.ok(!JSON.stringify(result).includes('not sent')); assert.equal(result.sourceSetHash, hash(JSON.stringify(result.sources)));
  fixture.domain.sources[0].body += 'changed'; assert.throws(() => frozenResearchEvidence(fixture), { code: 'invalid_judge_evidence' });
});
function review() { return Object.fromEntries(['left', 'right'].map(side => [side, { findings: [{ claim: 'Revenue is unknown.', support: 'supported', evidence: [{ sourceId: 'source', quote: 'No revenue was measured.' }], timeScope: 'current', reason: 'Unknown does not imply no paying customers.' }], coverage: 'complete', limitations: 'Frozen source review only.' }])); }
const sides = { left: { answer: 'Revenue is unknown.' }, right: { answer: 'Revenue is unknown.' } };
for (const [label, mutate] of [
  ['invented claim', value => { value.left.findings[0].claim = 'No paying customers exist.'; }],
  ['invented source', value => { value.left.findings[0].evidence[0].sourceId = 'invented'; }],
  ['fabricated quote', value => { value.left.findings[0].evidence[0].quote = 'There were zero payers.'; }],
  ['unsupported support', value => { value.left.findings[0].evidence = []; }],
  ['empty coverage', value => { value.left.findings = []; }],
]) test(`source review rejects ${label} without inventing a score`, () => { const value = review(); mutate(value); assert.throws(() => validateSourceReview(value, frozenResearchEvidence(researchCase()), sides), { code: 'invalid_judge' }); });
test('a genuine quote receipt does not turn the model support verdict into mechanically verified truth', () => {
  const value = review(); value.left.findings[0].reason = 'This interpretation is still a model opinion.';
  validateSourceReview(value, frozenResearchEvidence(researchCase()), sides, [{ left: .7, right: .8 }]);
  value.left.coverage = 'partial'; const partial = validateSourceReview(value, frozenResearchEvidence(researchCase()), sides, [{ criterionId: 'report_schema', left: 1, right: .8 }]); assert.equal(partial.left.coverage, 'partial');
  value.left.findings[0].support = 'not_established'; value.left.findings[0].evidence = [];
  const qualified = validateSourceReview(value, frozenResearchEvidence(researchCase()), sides, [{ criterionId: 'report_schema', left: 1, right: 1 }]); assert.equal(qualified.left.findings[0].support, 'not_established');
});

function researchGenome(candidate = false) {
  const genome = projectGenomeFixture({ candidate }); genome.tools = [];
  const fixture = researchCase().domain; fixture.reportPath = 'report.json'; fixture.checks = { requiredSourceIds: ['source'], windowStart: '2026-09-28T00:00:00Z', windowEnd: '2026-09-28T23:59:59Z', minCitations: 1, maxCitations: 2 };
  genome.evaluationSuite.cases = [1,2,3].map(index => ({ id: `research_${index}`, input: 'Write a research report about the measured performance and its limits. Use research sources and report format.', requiredTerms: [], forbiddenTerms: [], requiredToolIds: ['research_read', 'project_write'], weight: 1, workspace: { files: [], checks: [{ id: 'report', path: 'report.json', kind: 'file_exists' }] }, domain: structuredClone(fixture) }));
  return genome;
}
test('paired research evaluates complete frozen sources and host-read claims with a bounded structured source review', async () => {
  let judges = 0;
  const result = await evaluateProjectGenomes({ baseline: researchGenome(), candidate: researchGenome(true), model, provider: async function* (request) {
    if (request.systemPrompt.includes('blind evaluator')) {
      judges++; const input = JSON.parse(request.messages[0].content[0].text);
      assert.equal(input.hostContext.researchEvidence.truncated, false); assert.match(request.systemPrompt, /not establish zero, nonexistence/); assert.match(request.systemPrompt, /earlier "provisional"/);
      assert.ok(input.hostContext.researchEvidence.sources[0].body.endsWith('No revenue was measured.'));
      const sourceReview = Object.fromEntries(['left','right'].map(side => [side, { findings: [{ claimId: input.hostContext.claimInventories[side].units[0].id, support: input[side].answer.startsWith('Not') ? 'supported' : 'not_established', evidence: [{ sourceId: 'source', quote: 'No multi-worker performance is provided.' }], timeScope: 'current', reason: 'Missing reported performance is not proof that no test ever happened.' }], coverage: 'complete', limitations: 'Frozen sources only; semantic assessment remains a model opinion.' }]));
      const ratings = { ratings: input.criteria.map(criterion => ({ criterionId: criterion.id, left: input.left.answer.startsWith('Not') ? .85 : .5, right: input.right.answer.startsWith('Not') ? .85 : .5, reason: 'The two actual claims differ in whether they overstate absent measurement.' })), sourceReview };
      yield { type: 'tool_call', id: `judge${judges}`, name: request.tools[0].name, arguments: ratings }; yield { type: 'usage', usage: { totalTokens: 20 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
    }
    const results = request.messages.filter(row => row.role === 'toolResult'), candidate = request.systemPrompt.includes('CANDIDATE_AGENT');
    const claim = candidate ? 'Not established: multi-worker performance.' : 'No two-worker test was ever run.';
    if (!results.length) yield { type: 'tool_call', id: 'read', name: 'research_read', arguments: { sourceId: 'source' } };
    else if (results.length === 1) {
      const source = JSON.parse(results[0].content[0].text).source;
      yield { type: 'tool_call', id: 'write', name: 'project_write', arguments: { path: 'report.json', expectedHash: null, content: JSON.stringify({ citations: [{ sourceId: source.id, url: source.url, sha256: source.sha256, publishedAt: source.publishedAt, quote: 'No multi-worker performance is provided.', claim }], summary: claim }) } };
    } else yield { type: 'text_delta', delta: claim };
    yield { type: 'usage', usage: { totalTokens: 20 } }; yield { type: 'done', stopReason: results.length < 2 ? 'toolUse' : 'stop' };
  } });
  assert.equal(judges, 3); assert.equal(result.coverage.researchReviewedCases, 3); assert.equal(result.gatePassed, true);
  assert.equal(result.details[0].judgment.evidence.research.semanticClaim, 'model_review_not_fact_verification');
  for (const side of ['left','right']) { const finding=result.details[0].judgment.sourceReview[side].findings[0]; assert.match(finding.claimId,/^claim_/); assert.ok(finding.claim); assert.equal(finding.claimBinding.source,'host_inventory'); }
  assert.equal(result.details[0].baseline.domain.passed, true); assert.equal(result.details[0].candidate.domain.passed, true);
});

function inventoryReview(sides) { const inventories=Object.fromEntries(['left','right'].map(side=>[side,sourceClaimInventory(sides[side])])); const value=review(); for(const side of ['left','right']) value[side].findings=value[side].findings.map(({claim,...row})=>({...row,claimId:inventories[side].units[0].id})); return {inventories,value}; }
test('host claim IDs resolve source text without allowing invented text or cross-side substitution', () => {
  const distinct={left:{answer:'Revenue is unknown.'},right:{answer:'Payer status was not measured.'}}, {inventories,value}=inventoryReview(distinct);
  validateToolArguments(sourceReviewSchema,value); const normalized=validateSourceReview(value,frozenResearchEvidence(researchCase()),distinct,[],inventories);
  assert.equal(normalized.left.findings[0].claim,distinct.left.answer); assert.equal(normalized.right.findings[0].claim,distinct.right.answer); assert.equal(value.left.findings[0].claim,undefined);
  for(const mutate of [r=>{r.left.findings[0].claimId=inventories.right.units[0].id;},r=>{r.left.findings[0].claimId='claim_'+'0'.repeat(24);},r=>{r.left.findings[0].claim='Forged replacement';},r=>{r.left.findings.push(structuredClone(r.left.findings[0]));}]){const bad=structuredClone(value);mutate(bad);assert.throws(()=>validateSourceReview(bad,frozenResearchEvidence(researchCase()),distinct,[],inventories),{code:'invalid_judge'});}
  const both=structuredClone(value);both.left.findings[0].claim='Revenue is unknown.';assert.throws(()=>validateToolArguments(sourceReviewSchema,both));
  const corrupted=structuredClone(inventories);corrupted.left.units[0].text='different';assert.throws(()=>validateSourceReview(value,frozenResearchEvidence(researchCase()),distinct,[],corrupted),{code:'invalid_judge'});
});
test('anonymous side randomization binds IDs to actual side content, including identical content', () => {
  for(const swapped of [true,false]){const content=['Revenue is unknown.','No revenue was measured.'];const sides={left:{answer:content[swapped?1:0]},right:{answer:content[swapped?0:1]}};const {inventories,value}=inventoryReview(sides);const result=validateSourceReview(value,frozenResearchEvidence(researchCase()),sides,[],inventories);assert.equal(result.left.findings[0].claim,sides.left.answer);assert.equal(result.right.findings[0].claim,sides.right.answer);}
  const {inventories,value}=inventoryReview(sides);assert.equal(inventories.left.units[0].id,inventories.right.units[0].id);validateSourceReview(value,frozenResearchEvidence(researchCase()),sides,[],inventories);
});
test('coverage complete cannot hide omitted units, metadata is not a claim and long inventories remain bounded', () => {
  const evidence=frozenResearchEvidence(researchCase()), multi={left:{answer:'Revenue is unknown.\n\nPayer status is unknown.'},right:{answer:'Revenue is unknown.'}}, {inventories,value}=inventoryReview(multi);
  assert.throws(()=>validateSourceReview(value,evidence,multi,[],inventories),{code:'invalid_judge'});value.left.coverage='partial';validateSourceReview(value,evidence,multi,[{left:.8,right:.9}],inventories);
  assert.equal(validateSourceReview(value,evidence,multi,[{criterionId:'final_json_schema',left:1,right:.9}],inventories).left.coverage,'partial');
  const report={answer:'Revenue is unknown.',domain:{reviewReport:{citations:[{url:'https://metadata.invalid',quote:'No revenue was measured.',sha256:'abc',claim:'Revenue is unknown.'}],summary:'Revenue is unknown.'}}};const inventory=sourceClaimInventory(report);assert.equal(inventory.units.length,1);assert.ok(!JSON.stringify(inventory).includes('https://metadata.invalid'));assert.equal(inventory.units[0].origins.length,3);
  const long=sourceClaimInventory({answer:Array.from({length:100},(_,i)=>`Unit ${i}: `+'z'.repeat(2000)).join('\n\n')});assert.ok(long.units.length<=64);assert.equal(long.truncated,true);assert.ok(long.omittedUnits>0);
  const repeated=sourceClaimInventory({answer:Array(10000).fill('Revenue is unknown.').join('\n\n')});assert.equal(repeated.units.length,1);assert.equal(repeated.units[0].origins.length,8);assert.equal(repeated.units[0].omittedOrigins,9992);
  const metaSides={left:report,right:report},meta=inventoryReview(metaSides);delete meta.value.left.findings[0].claimId;meta.value.left.findings[0].claim='https://metadata.invalid';meta.value.left.coverage='partial';assert.throws(()=>validateSourceReview(meta.value,evidence,metaSides,[],meta.inventories),{code:'invalid_judge'});
});

test('mandatory visual case is rejected before execution or confirmation claim when model is text-only', async () => {
  const baseline = projectGenomeFixture(); baseline.tools = [];
  for (const row of baseline.evaluationSuite.cases) { row.requiredToolIds = []; row.workspace = { files: [{ path: 'index.html', content: '<main>test</main>' }], checks: [{ id: 'html', kind: 'file_exists', path: 'index.html' }] }; row.environment = { kind: 'browser', entry: 'index.html', viewport: { width: 800, height: 600 }, visualReview: true, steps: [{ id: 'main', kind: 'assert_visible', selector: 'main' }] }; }
  let calls = 0, claims = 0;
  await assert.rejects(evaluateProjectGenomes({ baseline, candidate: baseline, model, provider: async function* () { calls++; }, claimConfirmation: () => { claims++; } }), { code: 'evaluation_visual_model_required' });
  await assert.rejects(executeProjectEvaluationCase({ genome: baseline, caseId: baseline.evaluationSuite.cases[0].id, model, provider: async function* () { calls++; } }), { code: 'evaluation_visual_model_required' });
  assert.equal(calls, 0); assert.equal(claims, 0);
  baseline.evaluationSuite.cases[0].environment.screenshot = false; assert.throws(() => validateProjectGenome(baseline), { code: 'invalid_genome' });
});
