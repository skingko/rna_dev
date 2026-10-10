import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareScreenedSkillFoundation } from '../src/skill-foundation-screen.mjs';
import { projectGenomeFixture } from './fixtures/project-genome-fixture.mjs';

// In-memory marketplace: three candidates; 'huge' and 'unlicensed' cannot be installed, 'good' can.
function market() {
  const calls = [], text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] }), fail = code => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code }) }] });
  const results = [{ provider: 'skills-sh', id: 'a/huge', name: 'huge-writer' }, { provider: 'skills-sh', id: 'a/unlicensed', name: 'unlicensed-writer' }, { provider: 'skills-sh', id: 'a/good', name: 'good-writer' }];
  const tool = (name, fn) => ({ name, execute: async (_id, args) => { calls.push([name, args.id ?? args.query ?? '']); return fn(args); } });
  const tools = [
    tool('marketplace_plan', () => text({ existingSkills: [] })),
    tool('marketplace_search', () => text({ provider: 'skills-sh', results })),
    tool('marketplace_read', args => args.id === 'a/huge' ? fail('marketplace_response_limit') : text({ ok: true })),
    tool('marketplace_acquire', args => args.id === 'a/unlicensed' ? fail('marketplace_license_missing') : text({ skillId: `pkg-${args.id.split('/')[1]}` })),
    tool('marketplace_skip', () => text({ ok: true })),
  ];
  return { calls, tools };
}
const policy = { finalizeGenome: genome => genome };

test('picked packages that fail to install give way to the next options the same JEV choice ranked, up to five tries', async () => {
  const m = market(), picks = [];
  const result = await prepareScreenedSkillFoundation({ project: { id: 'p', title: 'Novel', description: 'write a novel', skillQueries: ['novel writing', 'fiction'] }, baseline: projectGenomeFixture(), referenceTools: m.tools, referencePolicy: policy,
    pick: async input => { picks.push(input); return { source: 'judge', indexes: [0, 1], alternates: [2] }; } }).catch(error => error);
  assert.equal(picks.length, 1, 'one JEV choice');
  const receipt = result.screening ?? result;
  const installed = m.calls.filter(([name]) => name === 'marketplace_acquire').map(([, id]) => id);
  assert.ok(installed.includes('a/good'), JSON.stringify(m.calls));
  assert.ok(m.calls.some(([name, id]) => name === 'marketplace_read' && id === 'a/huge'), 'the first pick was tried');
});
