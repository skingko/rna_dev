import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const program = `
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.argv[1];
const { PROJECT_EVALUATION_RUNTIME_HASH, PROJECT_EVALUATION_RUNTIME, evaluateProjectGenomes } = await import(pathToFileURL(join(root,'src/project-evolution.mjs')));
if (process.argv[2] === 'source-after-load') {
  const source=join(root,'src/workspace-tools.mjs'); await writeFile(source,(await readFile(source,'utf8'))+'\\n// Changed source after module initialization.\\n');
  const again=await import(pathToFileURL(join(root,'src/project-evolution.mjs')));
  console.log(JSON.stringify({hash:PROJECT_EVALUATION_RUNTIME_HASH,afterHash:again.PROJECT_EVALUATION_RUNTIME_HASH,runtime:PROJECT_EVALUATION_RUNTIME}));
}
else if (process.argv[2] !== 'mutate-after-load') console.log(JSON.stringify({hash:PROJECT_EVALUATION_RUNTIME_HASH,runtime:PROJECT_EVALUATION_RUNTIME}));
else {
  const skillFile=join(root,'skills/rna-delivery-quality/SKILL.md'), original=await readFile(skillFile,'utf8');
  await writeFile(skillFile,original+'\\nAFTER_LOAD_MARKER');
  const genome={schemaVersion:1,systemPrompt:'baseline',skills:[{id:'local',name:'Local',description:'Local method',instructions:'Use evidence.',resources:[]}],tools:[],evaluationSuite:{version:'frozen',criteria:[{id:'quality',description:'Evidence use',weight:1}],cases:[1,2,3].map(n=>({id:'case_'+n,input:'Inspect evidence.',requiredTerms:['evidence'],forbiddenTerms:[],requiredToolIds:[],weight:1})),thresholds:{minImprovement:.1,maxRegression:0,minScore:.7,maxTokenRatio:2}}};
  const candidate=structuredClone(genome); candidate.systemPrompt='candidate'; let count=0,seen=[];
  const provider=async function*(request){
    if(request.systemPrompt.includes('blind evaluator')) {const input=JSON.parse(request.messages[0].content[0].text); yield {type:'text_delta',delta:JSON.stringify({ratings:[{criterionId:'quality',left:input.left.answer.startsWith('precise')?.9:.4,right:input.right.answer.startsWith('precise')?.9:.4,reason:'Observed evidence use.'}]})};}
    else if(!request.messages.some(x=>x.role==='toolResult')){yield {type:'tool_call',id:'load-'+(++count),name:'skill_load',arguments:{id:'host:rna-delivery-quality'}};yield {type:'usage',usage:{totalTokens:1}};yield {type:'done',stopReason:'toolUse'};return;}
    else {seen.push(JSON.parse(request.messages.find(x=>x.role==='toolResult').content[0].text).content);yield {type:'text_delta',delta:request.systemPrompt.includes('\\ncandidate\\n')?'precise evidence':'evidence'};}
    yield {type:'usage',usage:{totalTokens:1}};yield {type:'done',stopReason:'stop'};
  };
  const result=await evaluateProjectGenomes({baseline:genome,candidate,model:{providerId:'fixture',modelId:'fixture',contextWindow:64000,maxOutputTokens:4096},provider});
  console.log(JSON.stringify({hash:PROJECT_EVALUATION_RUNTIME_HASH,evaluatedHash:result.evaluationRuntimeHash,allUsedSnapshot:seen.length===6&&seen.every(x=>x===original),fileChanged:(await readFile(skillFile,'utf8')).includes('AFTER_LOAD_MARKER')}));
}
`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rna-evaluation-identity-')); t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL('../src', import.meta.url)), join(root, 'src'), { recursive: true });
  await cp(fileURLToPath(new URL('../skills', import.meta.url)), join(root, 'skills'), { recursive: true }); return root;
}
async function inspect(root, mode = 'identity') { const result = await exec(process.execPath, ['--input-type=module', '--eval', program, root, mode], { maxBuffer: 64000 }); return JSON.parse(result.stdout); }

test('runtime fingerprint tracks exact core method bytes and catalog descriptions but never absolute installation paths', async t => {
  const root = await fixture(t), initial = await inspect(root);
  assert.match(initial.runtime.coreMethodSkillsHash, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(initial).includes(root));
  const skill = join(root, 'skills/rna-delivery-quality/SKILL.md'); await writeFile(skill, `${await readFile(skill, 'utf8')}\nA byte-level method revision.\n`);
  const changed = await inspect(root); assert.notEqual(changed.hash, initial.hash); assert.notEqual(changed.runtime.coreMethodSkillsHash, initial.runtime.coreMethodSkillsHash);
  const catalog = join(root, 'src/core-method-skills.mjs'); await writeFile(catalog, (await readFile(catalog, 'utf8')).replace("'交付与质量验证'", "'交付与质量验证（修订目录）'"));
  const catalogChanged = await inspect(root); assert.notEqual(catalogChanged.hash, changed.hash); assert.notEqual(catalogChanged.runtime.coreMethodSkillsHash, changed.runtime.coreMethodSkillsHash);
});

test('a comparison uses the same hashed core-skill snapshot even if installed files change after module load', async t => {
  const root = await fixture(t), result = await inspect(root, 'mutate-after-load');
  assert.equal(result.allUsedSnapshot, true); assert.equal(result.fileChanged, true); assert.equal(result.evaluatedHash, result.hash);
  assert.notEqual((await inspect(root)).hash, result.hash, 'A restarted evaluation process sees the changed method, with a new identity');
});

test('complete SDK implementation identity is portable across identical installation locations', async t => {
  const first = await fixture(t), second = await fixture(t), [a, b] = await Promise.all([inspect(first), inspect(second)]);
  assert.deepEqual(a, b); assert.match(a.runtime.implementationHash, /^[a-f0-9]{64}$/); assert.equal(a.runtime.nodeVersion, process.versions.node);
  assert.equal(JSON.stringify(a).includes(first), false); assert.equal(JSON.stringify(a).includes(second), false);
});

test('fresh evaluation processes detect tool description, executor, provider, context and added source bytes', async t => {
  const root = await fixture(t); let previous = await inspect(root);
  const mutations = [
    ['workspace-tools.mjs', 'Read a project text file as line-numbered content', 'Read a verified project text file as line-numbered content'],
    ['workspace-tools.mjs', 'maxFileBytes = 1024 * 1024', 'maxFileBytes = 1024 * 1023'],
    ['providers.mjs', '[Reference images from tool ', '[Retrieved image evidence from tool '],
    ['context.mjs', 'UTF-8 bytes / 3 + 8192/image reserve; not billed tokens', 'UTF-8 bytes / 3 + image reserve; not billed tokens']
  ];
  for (const [name, before, after] of mutations) {
    const file = join(root, 'src', name), source = await readFile(file, 'utf8'); assert.ok(source.includes(before), `Fixture source marker missing: ${name}`); await writeFile(file, source.replace(before, after));
    const changed = await inspect(root); assert.notEqual(changed.hash, previous.hash, name); assert.notEqual(changed.runtime.implementationHash, previous.runtime.implementationHash, name); assert.equal(changed.runtime.coreMethodSkillsHash, previous.runtime.coreMethodSkillsHash); previous = changed;
  }
  await writeFile(join(root, 'src/added-evaluation-dependency.mjs'), 'export const revision = 1;\n');
  const added = await inspect(root); assert.notEqual(added.runtime.implementationHash, previous.runtime.implementationHash, 'Source inventory changes are covered too');
});

test('implementation identity is fixed at module load and source changes take effect in a new process', async t => {
  const root = await fixture(t), before = await inspect(root), loaded = await inspect(root, 'source-after-load');
  assert.equal(loaded.hash, before.hash); assert.equal(loaded.afterHash, before.hash);
  const restarted = await inspect(root); assert.notEqual(restarted.hash, loaded.hash); assert.notEqual(restarted.runtime.implementationHash, loaded.runtime.implementationHash);
});
