import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';

// A deleted project's genome takes its installed skills with it; their entries must not break every new project's
// setup (live, 2026-10-04: ENOENT on two deleted projects' SKILL.md made project initialization fail).
test('skills installed into a deleted project\'s genome are no longer offered; others stay', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-orphan-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json'));
  const { project } = store.createProject({ name: 'Live' });
  const skill = (id, path) => ({ id, name: id, description: id, path, enabled: true, trusted: true });
  store.mutate(state => { state.capabilities = { skills: [
    skill('gone-skill', join(`${store.file}.genomes`, '251ded93-1e75-48f4-957c-e8e8592ea65a', 'v1', 'skills', 'gone', 'SKILL.md')),
    skill('live-skill', join(`${store.file}.genomes`, project.id, 'v1', 'skills', 'live', 'SKILL.md')),
    skill('user-skill', join(dir, 'skills', 'mine', 'SKILL.md')),
  ], tools: [], mcpServers: [] }; });
  const ids = new CapabilityService(store).configuration().skills.map(row => row.id);
  assert.ok(ids.includes('live-skill')); assert.ok(ids.includes('user-skill'));
  assert.equal(ids.includes('gone-skill'), false);
});

test('deleting a project removes the skills installed into its genome from the saved catalog', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rna-orphan-skills-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json'));
  const { project: doomed } = store.createProject({ name: 'Doomed' }), { project: kept } = store.createProject({ name: 'Kept' });
  const skill = (id, path) => ({ id, name: id, description: id, path, enabled: true, trusted: true });
  store.mutate(state => { state.capabilities = { revision: 3, skills: [
    skill('doomed-skill', join(`${store.file}.genomes`, doomed.id, 'v1', 'skills', 'a', 'SKILL.md')),
    skill('kept-skill', join(`${store.file}.genomes`, kept.id, 'v1', 'skills', 'b', 'SKILL.md')),
    skill('user-skill', join(dir, 'skills', 'mine', 'SKILL.md')),
  ], tools: [], mcpServers: [] }; });
  store.deleteProject(doomed.id);
  assert.deepEqual(store.state.capabilities.skills.map(row => row.id), ['kept-skill', 'user-skill']);
  assert.equal(store.state.capabilities.revision, 4);
});
