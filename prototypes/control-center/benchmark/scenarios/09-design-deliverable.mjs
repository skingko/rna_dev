import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, scriptedModel, decide, FakeClock, fakeJev, HOUR } from '../harness.mjs';
import { createRnaRuntime } from '../../rna-runtime.mjs';

// Generic across project types: a design project. Background work produces a
// poster draft and declares it with project_present; the agent's later share
// carries the file as a deliverable card and its own words unchanged. The
// judge (fake JEV) values it; no news/report shaping is applied anywhere.
const SHARE = '海报第二稿好了：主色换成墨绿，标题改为竖排，按你说的去掉了渐变。你看看竖排标题是否太挤。';
export default {
  id: 'design-deliverable', title: 'design project: a presented design file travels with the agent share, text unchanged', requires: ['narrator'],
  async run({ check }) {
    const clock = new FakeClock('2026-10-06T03:00:00Z');
    let worked = false, shared = false;
    const model = scriptedModel(({ input }) => {
      const done = input.events?.find(event => event.type === 'action_completed');
      if (done && !shared) { shared = true; return decide.share({ events: [done] }, SHARE); }
      if (!worked && input.events?.some(event => event.type === 'note')) { worked = true; return { action: 'work', content: 'Produce the second poster draft from the feedback.', evidenceIds: [input.events.at(-1).id], reason: 'The user asked for a revised draft.', nextReviewAfterMs: HOUR }; }
      return decide.wait(input);
    });
    const jev = fakeJev({ 'message.check': () => [], 'message.value': () => ({ probabilities: { new_information: .95, relevant_now: .9, needs_user_decision: .7 } }) });
    const world = await createWorld({ clock, model, jev, project: { name: 'Poster series', description: 'Weekly poster designs', mutate: target => { target.taskTypes = ['design', 'creative']; target.permissions = { ...(target.permissions ?? {}) }; } }, controller: {
      workMaxSteps: 3,
      runtimeFactory: options => createRnaRuntime({ ...options, provider: async function* (request) {
        if (!request.messages.some(message => message.role === 'toolResult')) { yield { type: 'tool_call', id: 'present', name: 'project_present', arguments: { files: [{ path: 'designs/poster-v2.png', description: '第二稿导出图' }] } }; yield { type: 'done', stopReason: 'toolUse' }; return; }
        yield { type: 'text_delta', delta: '第二稿已导出。\n交接：第二稿完成，下一步等反馈' }; yield { type: 'usage', usage: { input: 10, output: 10, totalTokens: 20 } }; yield { type: 'done', stopReason: 'stop' };
      } }),
    } });
    mkdirSync(join(world.directory, 'designs'), { recursive: true }); writeFileSync(join(world.directory, 'designs', 'poster-v2.png'), 'png');
    try {
      world.user('标题换成竖排、去掉渐变，出第二稿', { turn: 'completed', reply: '好的，后台出第二稿。' });
      world.present(true);
      world.observe('用户给出第二稿的修改意见');
      for (let step = 0; step < 4 && !world.delivered().some(item => item.text === SHARE); step++) await world.wake(10 * 60000);
      const message = world.delivered().find(item => item.text === SHARE);
      return [
        check('model worked then shared', worked && shared, { worked, shared }),
        check('the share is delivered with the agent words unchanged', Boolean(message)),
        check('the presented design file is its deliverable card', message?.initiative?.deliverables?.[0]?.path === 'designs/poster-v2.png' && message.initiative.deliverables[0].description === '第二稿导出图', { deliverables: message?.initiative?.deliverables }),
      ];
    } finally { await world.close(); }
  },
};
