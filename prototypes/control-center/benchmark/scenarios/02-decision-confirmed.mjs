import { createWorld, scriptedModel, decide, FakeClock } from '../harness.mjs';

// Plan §5 episode "用户给出决定后约 7 小时才确认": the user answers a pending
// decision, the foreground turn fails, and nobody confirms for hours.
// Quality bar: the very next background wake sees the decision and confirms it.
// Runs on main; with the mind feature it also checks the commitment lifecycle.
const ANSWER = '报告字段以现实为准，更新 README；模板暂不同步';
export default {
  id: 'decision-confirmed-within-one-wake', title: 'decision given + failed foreground turn is confirmed within one wake', requires: [],
  async run({ check, features }) {
    const clock = new FakeClock('2026-10-02T05:40:00Z');
    let confirmedAtCall = null;
    const model = scriptedModel(({ input, raw, call }) => {
      if (confirmedAtCall === null && raw.includes(ANSWER)) { confirmedAtCall = call; return decide.share(input, `已按你的决定执行：字段说明以实际报告为准并已更新 README，模板保持不变。`); }
      return decide.wait(input);
    });
    const world = await createWorld({ clock, model });
    try {
      world.user('报告字段往哪个方向统一？请给我选项', { turn: 'completed', reply: '两个方向：以现实为准，或回到模板定义。你选哪个？' });
      await world.wake(60000);
      const before = model.calls.length, askedAt = clock.now();
      world.user(ANSWER, { turn: 'failed' });
      await world.wake(0);
      const wakes = model.calls.slice(before).filter(row => !row.repair).length;
      const confirmation = world.delivered().find(item => /已按你的决定执行/.test(item.text));
      const checks = [
        check('first wake after the failed turn sees the decision', model.calls.slice(before).find(row => !row.repair)?.raw.includes(ANSWER) === true),
        check('confirmation delivered', Boolean(confirmation)),
        check('confirmed within one wake', confirmation && wakes <= 1, { wakes }),
        check('confirmation latency ≤ 15 min (simulated)', confirmation && Date.parse(confirmation.createdAt) - askedAt <= 15 * 60000, confirmation ? { minutes: Math.round((Date.parse(confirmation.createdAt) - askedAt) / 60000) } : null),
      ];
      if (features.mind?.available) {
        const mind = await features.mind.adapter.read(world.store, world.projectId);
        const row = (mind?.commitments ?? []).find(item => String(item.request ?? '').includes('以现实为准'));
        checks.push(check('mind: commitment recorded for the decision', Boolean(row)), check('mind: commitment resolved by the confirmation', row?.status === 'resolved', row ? { status: row.status } : null));
      }
      return checks;
    } finally { await world.close(); }
  },
};
