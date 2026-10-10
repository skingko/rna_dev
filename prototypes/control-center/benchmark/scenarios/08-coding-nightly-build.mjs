import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, FakeClock, fakeJev, HOUR } from '../harness.mjs';
import { createRnaRuntime } from '../../rna-runtime.mjs';
import { createProjectSchedule } from '../../../../packages/sdk/src/project-schedules.mjs';

// Generic across project types: a coding project's scheduled "nightly build
// health". File references (the failing test and line) ARE what a coding user
// needs; the judge (fake JEV, project-kind aware) keeps them, and the full log
// is declared with project_present instead of being pasted into the message.
const FINAL = '夜间构建：2 个测试失败。\n- src/parser.test.ts:42 空文件时抛出 TypeError\n- src/lexer.test.ts:17 大文件超时\n最可能的原因是昨天合并的流式读取改动；其余 212 个测试通过。';
export default {
  id: 'coding-nightly-build', title: 'coding project: nightly build health keeps the file references the user needs; the log is a presented deliverable', requires: ['narrator'],
  async run({ check }) {
    const clock = new FakeClock('2026-10-06T23:30:00Z'), seenKinds = [];
    const jev = fakeJev({ 'message.check': (_project, { kind }) => { seenKinds.push(kind); return kind?.taskTypes?.includes('coding') ? [] : ['internal_id']; } });
    const world = await createWorld({ clock, jev, project: { name: 'Parser library', description: 'A TypeScript parser library', mutate: (target, state) => {
      target.taskTypes = ['coding'];
      target.schedules = [createProjectSchedule({ id: 'nightly', title: '夜间构建健康', task: '每天 08:00 跑全部测试，告诉我哪些失败、在哪、可能原因。', destinationSessionId: state.sessions.find(row => row.projectId === target.id).id, rule: { kind: 'daily', time: '08:00', timeZone: 'Asia/Shanghai' } }, { now: Date.parse('2026-10-06T23:30:00Z') })];
    } }, controller: {
      workMaxSteps: 3, independentLearning: true,
      runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
        if (!request.messages.some(message => message.role === 'toolResult')) { yield { type: 'tool_call', id: 'present', name: 'project_present', arguments: { files: [{ path: 'reports/nightly.log', description: '完整测试日志' }] } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
        yield { type: 'text_delta', delta: `${FINAL}\n交接：夜间构建检查完成，失败在 parser/lexer，下一步修空文件分支` }; yield { type: 'usage', usage: { input: 10, output: 10, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' };
      } }),
    } });
    mkdirSync(join(world.directory, 'reports'), { recursive: true }); writeFileSync(join(world.directory, 'reports', 'nightly.log'), 'FAIL src/parser.test.ts:42\nFAIL src/lexer.test.ts:17');
    try {
      await world.wake(HOUR);
      const [message] = world.session().items.filter(item => item.scheduleOccurrenceKey);
      return [
        check('delivered', Boolean(message)),
        check('the agent final response is delivered as written (handoff line removed)', message?.text === FINAL, { text: message?.text?.slice(0, 80) }),
        check('failing test locations kept for a coding user', /src\/parser\.test\.ts:42/.test(message?.text ?? '') && /src\/lexer\.test\.ts:17/.test(message?.text ?? '')),
        check('the judge saw the project kind and the stated deliverable', seenKinds.some(kind => kind?.taskTypes?.includes('coding') && /哪些失败/.test(kind.deliverable ?? ''))),
        check('the log is a presented deliverable, not pasted', message?.initiative?.deliverables?.[0]?.path === 'reports/nightly.log' && !/FAIL src/.test(message?.text ?? '')),
      ];
    } finally { await world.close(); }
  },
};
