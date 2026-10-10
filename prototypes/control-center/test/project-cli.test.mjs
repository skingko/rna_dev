import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../server.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-project-cli-'));
  const { server, store } = createServer({ stateFile: join(directory, 'state.json'), ticks: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(directory, { recursive: true, force: true });
  });
  const env = { ...process.env, PI_FORGE_PORT: String(server.address().port) };
  const invoke = (...args) => run(process.execPath, [cli, ...args], { env });
  const json = async (...args) => JSON.parse((await invoke(...args)).stdout);
  return { store, invoke, json };
}

test('项目 CLI 无 Goal 提交证据，候选自动评测，试用/回退/采用改变模拟策略', async t => {
  const { store, json } = await fixture(t);
  const { project, session } = await json('project-new', '命令行项目', '独立的项目状态', '--demo');
  assert.equal(project.observations.length, 1);
  // This scenario isolates the explicit CI observation from the demo welcome event.
  store.mutate(state => { state.projects.find(p => p.id === project.id).observations = []; });
  assert.equal(session.projectId, project.id);
  assert.equal((await json('projects'))[0].id, project.id);
  assert.equal((await json('project', project.id)).description, '独立的项目状态');
  await json('observe', project.id, 'ci_failure', '版本已变，不能只信依赖就绪信号');
  store.tick(); store.tick(); store.tick();
  const list = await json('versions', project.id, '--json');
  const candidate = list.versions.find(version => version.state === 'ready');
  assert.ok(candidate?.evaluation.gatePassed);
  assert.equal(store.get().goals.length, 0);
  assert.equal(list.activeVersionId, project.activeVersionId);
  assert.equal((await json('check', project.id)).reuse, true);
  await json('version', project.id, candidate.id, 'trial');
  assert.equal((await json('check', project.id)).reuse, false);
  assert.equal((await json('check', project.id, 'true', 'true', 'true')).reuse, true);
  await json('version', project.id, candidate.id, 'rollback');
  assert.equal((await json('check', project.id)).reuse, true);
  await json('version', project.id, candidate.id, 'trial');
  await json('version', project.id, candidate.id, 'adopt');
  assert.equal((await json('versions', project.id, '--json')).activeVersionId, candidate.id);
});

test('项目 CLI 主动开关与新会话归属正确，chat 能打印主动来源', async t => {
  const { store, invoke, json } = await fixture(t);
  const { project, session } = await json('project-new', '语境样本', '--demo');
  assert.equal(project.observations[0].kind, 'context');
  assert.equal((await json('initiative', project.id, 'off')).initiative.enabled, false);
  assert.equal((await json('initiative', project.id, 'on')).initiative.enabled, true);
  assert.ok((await json('initiative', project.id, 'quiet')).initiative.quietUntil);
  assert.equal((await json('initiative', project.id, 'resume')).initiative.quietUntil, null);
  store.tick(); store.tick(); store.tick();
  const existing = invoke('chat', session.id);
  existing.child.stdin.end('/quit\n');
  assert.match((await existing).stdout, /Rna Agent · 主动发现/);
  const fresh = invoke('chat', '--project', project.id);
  fresh.child.stdin.end('/quit\n');
  assert.match((await fresh).stdout, new RegExp(`项目 ${project.id}`));
  assert.equal(store.get().sessions[0].projectId, project.id);
  const named = await json('new', '项目第二会话', '--project', project.id);
  assert.equal(named.projectId, project.id);
  assert.equal(named.title, '项目第二会话');
});

test('项目 CLI 参数错误在请求前明确报告，非法操作不改变项目版本', async t => {
  const { invoke, json, store } = await fixture(t);
  const { project } = await json('project-new', '参数检查');
  for (const args of [
    ['project-new'], ['project-new', 'test', '--unknown'], ['project'],
    ['observe', project.id, 'unknown', 'text'], ['initiative', project.id, 'wrong'],
    ['check', project.id, 'true'], ['check', project.id, 'yes', 'true', 'false'],
    ['version', project.id, project.activeVersionId, 'wrong'],
    ['chat', '--project'], ['chat', 'session', '--project', project.id]
  ]) {
    await assert.rejects(invoke(...args), error => error.code === 1 && /Rna Agent:/.test(error.stderr));
  }
  assert.equal(store.get().projects[0].activeVersionId, project.activeVersionId);
  assert.equal(store.get().sessions.length, 1);
});
