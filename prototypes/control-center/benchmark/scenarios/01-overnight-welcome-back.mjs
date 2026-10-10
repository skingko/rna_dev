import { createWorld, scriptedModel, decide, FakeClock, HOUR } from '../harness.mjs';

// Plan §3.1 / §5 episode "凌晨连续 12 条无人回复": findings made overnight while
// the user is away must be held and told once, as a welcome-back summary, when
// the user returns. Requires K2 pacing (+ narrator for the summary).
const FINDINGS = ['第二关闪烁的根因是天空平面接缝，已修复并通过回归。', '难度曲线里有一跳在人类误差下几乎不可能完成，已把最大风力从 2.4 调到 2.0。', '通关后的重开流程此前没有任何测试，现在已补上并通过。'];
export default {
  id: 'overnight-welcome-back', title: 'overnight findings → one batched welcome-back message', requires: ['pacing', 'narrator'],
  async run({ check }) {
    // 02:00 in Asia/Shanghai; the user's last message was 6 hours earlier.
    const clock = new FakeClock('2026-10-04T12:00:00Z');
    let shared = 0;
    const model = scriptedModel(({ input }) => shared < FINDINGS.length && input.events?.some(event => event.type === 'note') ? decide.share(input, FINDINGS[shared++]) : decide.wait(input));
    const world = await createWorld({ clock, model });
    try {
      world.user('继续完善第二关的场景', { turn: 'completed', reply: '好的，我会在后台继续检查。' });
      await world.wake(6 * HOUR);
      const before = world.delivered().length;
      for (let step = 0; step < FINDINGS.length; step++) { world.observe(`夜间后台核查 ${step}`); await world.wake(2 * HOUR); }
      const overnight = world.delivered().slice(before).filter(item => (item.initiative?.reach ?? 'inline') === 'inline' && item.initiative?.kind !== 'digest');
      clock.advance(HOUR); world.present(true); world.user('早，我回来了', { turn: 'completed', reply: '早。' });
      await world.wake(60000);
      const after = world.delivered().slice(before + overnight.length);
      const summary = after.find(item => FINDINGS.every(finding => item.text.includes(finding.slice(0, 6))) || FINDINGS.filter(finding => item.text.includes(finding.slice(0, 6))).length >= 2);
      return [
        check('model produced the overnight findings', shared === FINDINGS.length, { shared }),
        check('no inline interruption while away at night', overnight.length === 0, { inline: overnight.length }),
        check('one welcome-back message after return', after.length === 1, { messages: after.length }),
        check('welcome-back message carries the findings', Boolean(summary)),
      ];
    } finally { await world.close(); }
  },
};
