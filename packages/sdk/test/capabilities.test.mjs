import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CapabilityRegistry, loadSkill, validateToolArguments, mcpToolName } from '../src/capabilities.mjs';
const parameters = { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 2 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, additionalProperties: false };
test('schema rejects unknown fields, wrong types and nested constraints', () => {
  assert.deepEqual(validateToolArguments(parameters, { query: 'ok', limit: 2 }), { query: 'ok', limit: 2 });
  for (const args of [{}, { query: 'x' }, { query: 'ok', limit: 0 }, { query: 'ok', extra: 1 }]) assert.throws(() => validateToolArguments(parameters, args), { code: 'invalid_arguments' });
  assert.throws(() => validateToolArguments({ type: 'object', unevaluatedProperties: false }, {}), { code: 'unsupported_schema' });
  assert.equal(validateToolArguments({ type: 'string', format: 'email', $comment: 'annotation only', contentEncoding: 'base64', contentMediaType: 'text/plain', minLength: 2 }, 'invalid'), 'invalid');
  assert.throws(() => validateToolArguments({ type: 'string', format: 'email', minLength: 2 }, 'x'), { code: 'invalid_arguments' });
  assert.throws(() => validateToolArguments({ $ref: 'https://example.invalid/schema' }, {}), { code: 'unsupported_schema' });
  const schema = { $defs: { count: { type: 'integer', minimum: 1 } }, anyOf: [{ $ref: '#/$defs/count' }, { const: 'auto' }] };
  assert.equal(validateToolArguments(schema, 'auto'), 'auto'); assert.equal(validateToolArguments(schema, 2), 2); assert.throws(() => validateToolArguments(schema, 0));
  assert.throws(() => validateToolArguments({ type: 'array', uniqueItems: true, items: { type: 'integer' } }, [1, 1]));
});
test('skill loader reads inert SKILL.md instructions and hashes actual content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-skill-'));
  try {
    const body = '---\nname: analysis\ndescription: Analyze project evidence\n---\n# Work\n```bash\n#| eval: true\ntouch SHOULD_NEVER_EXECUTE\n```\n'; await writeFile(join(dir, 'SKILL.md'), body);
    const skill = await loadSkill({ id: 'analysis', path: dir, enabled: true, trusted: true });
    assert.equal(skill.name, 'analysis'); assert.equal(skill.instructions, body); assert.match(skill.contentHash, /^[a-f0-9]{64}$/);
    await writeFile(join(dir, 'SKILL.md'), body + '\nChanged'); assert.notEqual((await loadSkill({ id: 'analysis', path: dir, enabled: true, trusted: true })).contentHash, skill.contentHash);
    await assert.rejects(loadSkill({ id: 'analysis', path: dir, enabled: true }), { code: 'not_authorized' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('registry only exposes explicitly enabled trusted tools, enforces arguments before execution', async () => {
  let calls = 0;
  const registry = new CapabilityRegistry({ tools: [
    { id: 'read', name: 'read', permission: 'read', parameters, enabled: true, trusted: true, execute: async (_id, args) => { calls++; return args.query; } },
    { id: 'untrusted', name: 'untrusted', permission: 'exec', parameters, enabled: true, trusted: false, execute: async () => { throw new Error('not called'); } }
  ] });
  assert.deepEqual((await registry.catalog()).tools.map(tool => tool.id), ['read']);
  await assert.rejects(registry.resolve({ toolIds: ['invented'] }), { code: 'not_authorized' });
  await assert.rejects(registry.resolve({ toolIds: ['untrusted'] }), { code: 'not_authorized' });
  const { tools } = await registry.resolve({ toolIds: ['read'] }); assert.equal(tools[0].effect, 'read');
  await assert.rejects(tools[0].execute('one', { query: 'x' }), { code: 'invalid_arguments' }); assert.equal(calls, 0);
  assert.equal(await tools[0].execute('two', { query: 'ok' }), 'ok'); assert.equal(calls, 1);
  assert.throws(() => registry.registerTool({ id: 'missing_permission', execute() {} }));
  await registry.close();
});
test('skill metadata supports common folded/literal blocks and quoted scalars without evaluating YAML', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-skill-metadata-'));
  const manifest = { id: 'metadata', path: dir, enabled: true, trusted: true };
  try {
    for (const [metadata, name, description] of [
      ["name: 'Researcher''s skill' # display name\ndescription: >-\n  Review project evidence\n  and explain the findings.\n\n  Include sources.\nversion: 1", "Researcher's skill", 'Review project evidence and explain the findings.\nInclude sources.'],
      ['name: "A \\"quoted\\" skill"\ndescription: |\n  First line.\n  Second line.\n\n  Last paragraph.\nversion: 1', 'A "quoted" skill', 'First line.\nSecond line.\n\nLast paragraph.'],
      ['name: "quoted-name"\ndescription: "Use \\"sources\\" and \\u4e2d\\u6587." # metadata', 'quoted-name', 'Use "sources" and 中文.'],
      ['name: plain\ndescription: >2-\n  A folded sentence\n  across two lines.\nother: value', 'plain', 'A folded sentence across two lines.']
    ]) {
      const body = `---\n${metadata}\n---\n# Instructions stay inert\n`; await writeFile(join(dir, 'SKILL.md'), body);
      const skill = await loadSkill(manifest); assert.equal(skill.name, name); assert.equal(skill.description, description); assert.equal(skill.instructions, body);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('MCP public tool names preserve uniqueness after normalization and length bounds', () => {
  assert.equal(mcpToolName('files', 'read'), 'mcp__files__read');
  assert.notEqual(mcpToolName('a.b', 'read'), mcpToolName('a_b', 'read'));
  assert.ok(mcpToolName('x'.repeat(100), 'y'.repeat(100)).length <= 64);
});
test('MCP catalogs omit command credentials and never start configured processes implicitly', async () => {
  const registry = new CapabilityRegistry({ mcpServers: [{ id: 'configured', transport: 'stdio', command: 'DO_NOT_SPAWN', env: { SECRET: 'secret-value' }, enabled: true, trusted: true, allowTools: { read: { permission: 'read' } } }] });
  const catalog = await registry.catalog(); assert.equal(catalog.mcpServers[0].connected, false); assert.ok(!JSON.stringify(catalog).includes('secret-value'));
  await assert.rejects(registry.connectMcp('unknown'), { code: 'not_authorized' });
});

test('a skill whose SKILL.md is gone is left out of the catalog and noted; other skill errors still fail', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-skill-missing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'SKILL.md'), '---\nname: Present\ndescription: Here.\n---\nUse it.\n');
  const registry = new CapabilityRegistry({ skills: [
    { id: 'present', path: join(dir, 'SKILL.md'), enabled: true, trusted: true },
    { id: 'gone', path: join(dir, 'deleted-project', 'SKILL.md'), enabled: true, trusted: true },
  ] });
  const catalog = await registry.catalog();
  assert.deepEqual(catalog.skills.map(skill => skill.id), ['present']);
  assert.deepEqual(registry.skillFailures, [{ id: 'gone', code: 'skill_missing' }]);
  await mkdir(join(dir, 'empty'), { recursive: true }); await writeFile(join(dir, 'empty', 'SKILL.md'), '');
  const broken = new CapabilityRegistry({ skills: [{ id: 'empty', path: join(dir, 'empty', 'SKILL.md'), enabled: true, trusted: true }] });
  await assert.rejects(broken.catalog(), /SKILL\.md must be a file|SKILL\.md is empty/, 'a present but invalid skill is still an error');
});
