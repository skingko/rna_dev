import { createWorld, scriptedModel, decide, FakeClock, fakeJev } from '../harness.mjs';

// Plan §5 episode "同一阻塞 18 分钟内换说法发了 3 次" (09-24 permission confusion):
// the background mind re-announces one blocker three times in different words.
// Quality bar: at most one of the paraphrases reaches the user. Runs on main.
const PARAPHRASES = [
  '写入权限还没有生效：你说了可以直接开始开发，但那条消息对应的回合失败了，所以我这边仍只有只读能力。请在项目权限里打开写入。',
  '我确认了卡住的原因：你让我直接开始开发的那条消息没有执行成功，系统里我依然只能读取文件，需要你在项目权限中开启写入后才能动手。',
  '状态说明，避免误会代码已经在写：我目前拿到的仍是只读权限，你“解锁写入、直接开发”的那次请求失败了，打开项目写入权限后我就开始。',
];
export default {
  id: 'paraphrased-repeat-suppressed', title: 'paraphrased repeat of one blocker is suppressed', requires: [],
  async run({ check }) {
    let index = 0;
    const model = scriptedModel(({ input }) => index < PARAPHRASES.length && input.events?.some(event => event.type === 'note') ? decide.share(input, PARAPHRASES[index++]) : decide.wait(input));
    // A fake JEV judge: it recognizes the rewordings of the told blocker (message.value already_reported).
    // The host has no wording rules; the judge's verdict must lead to a drop, not an inbox entry.
    const jev = fakeJev({ 'message.value': (_project, { text, findings }) => ({ probabilities: { new_information: findings.length ? .05 : .9, relevant_now: .8 }, alreadyReported: findings.length > 0 && text !== PARAPHRASES[0] }) });
    const world = await createWorld({ clock: new FakeClock('2026-10-01T07:09:00Z'), model, jev });
    try {
      for (const minutes of [0, 16, 2]) { world.observe(`权限状态复核 +${minutes}min`); await world.wake(minutes * 60000); }
      const delivered = world.delivered().filter(item => PARAPHRASES.includes(item.text));
      return [
        check('model offered all paraphrases', index === PARAPHRASES.length, { offered: index }),
        check('at most one paraphrase delivered', delivered.length <= 1, { delivered: delivered.length }),
        check('already-told rewordings are dropped, not filed to the inbox', world.inbox().filter(row => PARAPHRASES.slice(1).includes(row.text)).length === 0, { filed: world.inbox().filter(row => PARAPHRASES.slice(1).includes(row.text)).length }),
      ];
    } finally { await world.close(); }
  },
};
