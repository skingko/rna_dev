import { createWorld, scriptedModel, decide, FakeClock } from '../harness.mjs';

// Plan §1 "初始化时的 7 个开放问题至今未更新": when the user answers an open
// question, the matching awaiting_user agenda entry closes (after capture and
// at most one background wake). Requires K1 mind + capture.
const QUESTION = '目标平台是桌面浏览器、移动端网页还是两者兼顾？';
const NOW = '2026-10-07T03:00:00.000Z';
const agendaItem = { id: 'agenda-platform', kind: 'awaiting_user', text: QUESTION, status: 'open', createdAt: NOW, updatedAt: NOW, source: { kind: 'initialization' }, evidence: [] };
export default {
  id: 'answered-question-closes-agenda', title: 'answered open question closes its agenda entry', requires: ['mind', 'capture'],
  async run({ check, features }) {
    const model = scriptedModel(({ input }) => decide.wait(input));
    const world = await createWorld({ clock: new FakeClock(NOW), model, project: { openQuestions: [QUESTION], mind: { lessons: [], agenda: [agendaItem], commitments: [], findings: [], threads: [], notes: { facts: [], preferences: [] } } } });
    try {
      const before = await features.mind.adapter.read(world.store, world.projectId);
      const seeded = (before?.agenda ?? []).find(row => row.id === agendaItem.id || row.text === QUESTION);
      const { itemId } = world.user('目标平台就是桌面浏览器，移动端先不考虑', { turn: 'completed', reply: '明白。' });
      await features.capture.adapter.captureUserMessage({ store: world.store, projectId: world.projectId, sessionId: world.sessionId, itemId, jev: world.jev });
      await world.wake(60000);
      const after = await features.mind.adapter.read(world.store, world.projectId);
      const entry = (after?.agenda ?? []).find(row => row.id === seeded?.id || row.text === QUESTION);
      return [
        check('agenda entry seeded as open', seeded?.status === 'open'),
        check('agenda entry closed after the answer', entry && entry.status !== 'open', entry ? { status: entry.status } : null),
        check('answer recorded as a fact or evidence', JSON.stringify(after ?? {}).includes('桌面浏览器')),
      ];
    } finally { await world.close(); }
  },
};
