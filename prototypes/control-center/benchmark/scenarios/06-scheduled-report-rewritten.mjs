import { createWorld, FakeClock, fakeJev, HOUR } from '../harness.mjs';
import { createRnaRuntime } from '../../rna-runtime.mjs';
import { createProjectSchedule } from '../../../../packages/sdk/src/project-schedules.mjs';
import { hasDeliverableManifest, hashMentions } from '../labels.mjs';

// Plan §3 item 5 / §5 complaints "啰嗦" and "不要写交付物详单…只需要直接交付
// daily.md 的内容". Like Pi/Harness the agent's final response is the message;
// the host never rewrites it. The judge (JEV message.check, faked here) flags a
// manifest-style report against the schedule's stated deliverable, and the
// agent revises it once with the flags, the deliverable and the user's lesson.
const RAW = `每日 AI 新闻与应用调研

## 2026-10-06 日报已交付（校验 16/16 通过）

**交付物**
| 文件 | 内容 |
|---|---|
| reports/2026-10-06/daily.md | 日报正文（12 条） |
| reports/2026-10-06/sources.json | 来源清单 3f9c2ab71d |

校验：schema 16/16，链接可达 16/16。
交接：日报已生成，下一步明天 09:00`;
const REVISED = '今天值得看的三件事：\n1. 某开源模型发布 72B 版本，代码榜单进入前三。\n2. 一家浏览器厂商把本地小模型接入地址栏补全。\n3. 某协作工具上线“会议后自动生成待办”。';
const PREFERENCE = '后续交付内容不要写交付物详单之类，只需要直接交付 daily.md 的内容即可';
export default {
  id: 'scheduled-report-rewritten', title: 'scheduled report: judge flags a manifest, the agent revises once, the revision is delivered as written', requires: ['narrator'],
  async run({ check }) {
    const clock = new FakeClock('2026-10-06T00:30:00Z'), revisions = [];
    const jev = fakeJev({ 'message.check': (_project, { text, kind }) => kind?.deliverable && hasDeliverableManifest(text) ? ['describes_instead_of_delivering'] : [] });
    const world = await createWorld({ clock, jev, project: { name: 'AI 应用调研', mutate: (target, state) => {
      target.taskTypes = ['research', 'recurring'];
      target.mind = { lessons: [{ id: 'pref', kind: 'preference', status: 'active', scope: 'project', text: PREFERENCE }], agenda: [], commitments: [], threads: [], findings: [] };
      target.schedules = [createProjectSchedule({ id: 'daily', title: '每日 AI 新闻', task: '每天 09:00 收集最新 AI 新闻并直接交付日报正文。', destinationSessionId: target.primarySessionId ?? state.sessions.find(row => row.projectId === target.id).id, rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } }, { now: Date.parse('2026-10-06T00:30:00Z') })];
    } }, controller: {
      workMaxSteps: 2, independentLearning: true,
      runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* () { yield { type: 'text_delta', delta: RAW }; yield { type: 'usage', usage: { input: 10, output: 10, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' }; } }),
      narratorProvider: async function* (request) { revisions.push(request); yield { type: 'text_delta', delta: REVISED }; yield { type: 'usage', usage: { totalTokens: 9 } }; yield { type: 'done', stopReason: 'stop' }; },
    } });
    try {
      await world.wake(HOUR);
      const delivered = world.session().items.filter(item => item.scheduleOccurrenceKey);
      const text = delivered[0]?.text ?? '', prompt = JSON.stringify(revisions[0]?.messages ?? []);
      return [
        check('one scheduled delivery', delivered.length === 1, { delivered: delivered.length }),
        check('the judge flagged the manifest and the agent revised once', revisions.length === 1 && /describes_instead_of_delivering/.test(prompt), { revisions: revisions.length }),
        check('revision saw the deliverable and the user lesson', /直接交付日报正文/.test(prompt) && prompt.includes(PREFERENCE)),
        check('the revision is delivered exactly as written', text === REVISED),
        check('no deliverable manifest or hashes', !hasDeliverableManifest(text) && hashMentions(text) === 0),
        check('the host-protocol handoff line never reaches the user', !/(交接|HANDOFF)[:：]/.test(text)),
      ];
    } finally { await world.close(); }
  },
};
