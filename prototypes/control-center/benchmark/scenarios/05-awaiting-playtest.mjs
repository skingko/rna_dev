import { createWorld, scriptedModel, decide, FakeClock, fakeJev, HOUR, DAY } from '../harness.mjs';
import { isStatusReport, salientSimilarity } from '../labels.mjs';

// Plan §5: a recurring project waiting for the user's playtest. Production
// sent daily "checkpoint passed, zero drift, still awaiting feedback" reports.
// Quality assertions (not a count cap): over three simulated days nothing
// delivered is a status report or a repeat of an earlier idea, and the project
// does not go silent — at least one genuinely new idea reaches the user.
const IDEAS = ['新想法：把“墨干倒计时”显示成笔尖墨量渐淡，玩家不用看数字也能感到紧迫。', '新想法：连击时让落点溅出更大的墨晕，作为不打断操作的手感反馈。', '新想法：每五关换一种纸张纹理（宣纸、绢、竹简），让关卡推进在视觉上可感知。'];
const STATUS = '试玩反馈检查点：锚点核验零漂移，全部只读，零代码改动，仍待你试玩后裁决。';
export default {
  id: 'awaiting-playtest-quality', title: 'recurring + awaiting playtest → new ideas, no status reports or repeats', requires: [],
  async run({ check }) {
    const clock = new FakeClock('2026-10-03T01:00:00Z'), start = clock.now();
    const offered = { status: 0, ideas: 0, repeats: 0 };
    const model = scriptedModel(({ input }) => {
      const day = Math.floor((clock.now() - start) / DAY), hour = Math.floor(((clock.now() - start) % DAY) / HOUR);
      if (hour < 4 && IDEAS[day]) { offered.ideas++; return decide.share(input, IDEAS[day]); }
      if (hour >= 4 && hour < 8 && day > 0) { offered.repeats++; return decide.share(input, `再提一次：${IDEAS[day - 1].replace('新想法：', '')}`); }
      offered.status++; return decide.share(input, STATUS);
    });
    // Fake JEV judge: message.check flags the status report (the model gets one revision round and waits);
    // message.value says a restated idea was already told. No host text rules are involved.
    const told = new Set();
    const jev = fakeJev({ 'message.check': (_project, { text }) => text === STATUS ? ['status_ping'] : [],
      'message.value': (_project, { text }) => { const core = text.replace(/^(新想法|再提一次)：/, ''), repeat = [...told].some(idea => idea.includes(core.slice(0, 12))); if (!repeat) told.add(core); return { probabilities: { new_information: repeat ? .05 : .9, relevant_now: .8 }, alreadyReported: repeat }; } });
    const world = await createWorld({ clock, model, jev, project: { overview: '水墨跳跃小游戏：第九轮已交付，等待用户实机试玩反馈', mutate: target => { target.focus = '等待试玩反馈'; } } });
    try {
      for (let step = 0; step < 3 * 6; step++) { world.observe(`每日检查点 ${step}：构建通过，未发现回归`); await world.wake(4 * HOUR); }
      const delivered = world.delivered().map(item => item.text);
      const status = delivered.filter(isStatusReport), ideas = delivered.filter(text => text.startsWith('新想法'));
      const substantive = delivered.filter(text => !isStatusReport(text)), repeats = substantive.filter((text, index) => substantive.slice(0, index).some(earlier => salientSimilarity(earlier.replace(/^(新想法|再提一次)：/, ''), text.replace(/^(新想法|再提一次)：/, '')) >= 0.6));
      return [
        check('model offered status reports, ideas and repeats', offered.status > 0 && offered.ideas > 0 && offered.repeats > 0, offered),
        check('no status report delivered', status.length === 0, { delivered: status.length }),
        check('no repeated idea delivered', repeats.length === 0, { delivered: repeats.length }),
        check('not silent: at least one new idea delivered', ideas.length >= 1, { ideas: ideas.length }),
      ];
    } finally { await world.close(); }
  },
};
