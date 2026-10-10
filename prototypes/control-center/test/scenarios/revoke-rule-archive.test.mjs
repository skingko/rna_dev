// D4 scenario (plan A7): a rule the project learned reaches every request; the user revokes it in the evolution tree,
// and the next request carries a newer rules block without it; archiving the project then closes the tree and the
// project's background. Crosses the gene routes, the project mind, the foreground's mind context blocks, the stream
// (project.mind and index events) and the archive path. Model only is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../harness/world.mjs';
import { scenario } from '../harness/scenario.mjs';
import { MIND_CONTEXT_KEYS } from '../../project-mind.mjs';

const RULE = 'Never use the word nightwatch in chapter text.';

test('a revoked rule leaves the next request, and archiving closes the evolution tree', async t => {
  const world = await createWorld(t);
  const s = scenario(world), lessonId = 'scenario-rule-1', at = new Date().toISOString();
  // A standing rule as the mind's lesson writer leaves it (user-sourced, project scope).
  world.store.mutate(state => { const project = state.projects.find(row => row.id === world.projectId); project.mind ??= {}; project.mind.lessons = [{ id: lessonId, kind: 'constraint', scope: 'project', status: 'active', text: RULE, createdAt: at, updatedAt: at, source: { kind: 'user', sessionId: world.sessionId }, evidence: [], uses: { recalled: 0, applied: 0, contradicted: 0 } }]; });
  const index = await world.sse('/api/v2/stream');

  const first = await s.send('Write the opening line of chapter one.', { reply: 'The lamps were lit before the bells.' });
  await first.expect({ requests: rows => {
    const [request] = rows.filter(row => row.tag === 'foreground');
    assert.ok(request.wire.includes(MIND_CONTEXT_KEYS.rules) && request.wire.includes(RULE), 'the rule rides the rules block');
  } });

  const revoked = await s.evolve(`lesson:${lessonId}`, { action: 'revoke' });
  await revoked.expect({
    state: state => { const lesson = state.projects.find(row => row.id === world.projectId).mind.lessons.find(row => row.id === lessonId); assert.equal(lesson.status, 'retired'); assert.equal(lesson.retiredReason, 'user_revoked'); },
    frames: frames => assert.ok(frames.some(frame => frame.event === 'project.mind' && frame.data.projectId === world.projectId && frame.data.changed.includes('lessons')), 'the open tab heard the mind change'),
  });

  const next = await s.send('Write the second line.', { reply: 'The bells answered from the hill.' });
  await next.expect({ requests: rows => {
    const [request] = rows.filter(row => row.tag === 'foreground'), wire = request.wire;
    assert.ok(wire.split(RULE).length - 1 <= 1, 'the revoked rule is not sent again');
    assert.ok(wire.lastIndexOf(MIND_CONTEXT_KEYS.rules) > wire.lastIndexOf(RULE), 'a newer rules block replaces the copy that held it');
  } });

  const archived = await s.archive();
  await archived.expect({
    state: state => { const project = state.projects.find(row => row.id === world.projectId); assert.ok(project.archivedAt); assert.equal(project.initiative.enabled, false); },
    frames: frames => assert.ok(frames.some(frame => frame.event === 'index' && frame.data.projects?.some(row => row.id === world.projectId && row.archivedAt)), 'the index shows the project archived'),
  });
  const tree = await world.get(`/api/v2/projects/${world.projectId}/genes`);
  assert.equal(tree.status, 404, 'an archived project has no evolution tree to act on');
  const restored = await s.archive(world.projectId, { archived: false });
  await restored.expect({ state: state => assert.equal(state.projects.find(row => row.id === world.projectId).archivedAt, null) });
  assert.equal((await world.get(`/api/v2/projects/${world.projectId}/genes`)).status, 200);
  index.close();
});
