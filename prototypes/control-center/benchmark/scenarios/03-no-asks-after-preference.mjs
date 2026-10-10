import { createWorld, scriptedModel, decide, FakeClock, HOUR, DAY } from '../harness.mjs';

// Plan §5 episode "你应该自己决策，不需要问我" followed by more asks.
// After the preference is captured, the background mind must stop asking for
// N days. The scripted model is obedient: it asks unless the host shows it a
// lesson carrying the preference. Requires K1 capture + mind.
const PREFERENCE = '继续开发，另外你应该自己决策，不需要问我';
const DAYS = 3;
const lessonVisible = raw => /lessons?/i.test(raw) && /(不需要问|自己决策|without asking|don't ask|do not ask)/i.test(raw.slice(raw.search(/lessons?/i)));
export default {
  id: 'no-asks-after-preference', title: '"不需要问我" → no asks for N days', requires: ['capture', 'mind'],
  async run({ check, features }) {
    const clock = new FakeClock('2026-10-05T01:00:00Z');
    let tried = 0, sawLesson = false;
    const model = scriptedModel(({ input, raw }) => {
      if (lessonVisible(raw)) { sawLesson = true; return input.events?.some(event => event.type === 'note') ? decide.share(input, `已按默认方案推进：${input.events.at(-1).summary ?? ''}`.slice(0, 200)) : decide.wait(input); }
      tried++; return decide.ask(input, '下一步先做关卡还是先做美术？');
    });
    const world = await createWorld({ clock, model });
    try {
      const { itemId } = world.user(PREFERENCE, { turn: 'completed', reply: '好的。' });
      await features.capture.adapter.captureUserMessage({ store: world.store, projectId: world.projectId, sessionId: world.sessionId, itemId, jev: world.jev });
      const mind = await features.mind.adapter.read(world.store, world.projectId);
      const lesson = (mind?.lessons ?? []).find(row => row.status === 'active' && /(问|ask)/i.test(row.text ?? ''));
      const asksBefore = world.asks().length;
      for (let step = 0; step < DAYS * 4; step++) { world.observe(`新的开发取舍 ${step}：关卡或美术`); await world.wake(DAY / 4); }
      return [
        check('preference captured as an active lesson', Boolean(lesson), lesson ? { kind: lesson.kind } : null),
        check('lesson visible to the background mind', sawLesson),
        check(`no asks delivered for ${DAYS} days`, world.asks().length - asksBefore === 0, { asks: world.asks().length - asksBefore, attempted: tried }),
      ];
    } finally { await world.close(); }
  },
};
