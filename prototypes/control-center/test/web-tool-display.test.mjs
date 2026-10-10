import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { RuntimeController } from '../runtime-controller.mjs';

const receipt = () => ({ provider: 'fastcrw', operation: 'search', filterApplied: false, filterStatus: 'not_applied', notice: 'PRIVATE_PROVIDER_DETAIL must not be copied', stack: 'PRIVATE_STACK' });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-web-notice-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json')), { session } = store.createProject({ name: 'Tool notice projection', workspace: dir });
  store.mutate(state => { const current = state.sessions.find(row => row.id === session.id); current.status = 'running'; current.activeTurnId = 'turn'; current.turns = [{ id: 'turn', status: 'running' }]; });
  // Exercise the real durable event projection without starting provider,
  // memory, scheduler, or controller background loops.
  const controller = Object.assign(Object.create(RuntimeController.prototype), { store, closed: false });
  const context = { sessionId: session.id, turnId: 'turn' };
  const tool = () => store.state.sessions.find(row => row.id === session.id).items.find(row => row.tool?.id === 'call').tool;
  controller.event(context, { type: 'tool_execution_start', toolName: 'web_search', toolCallId: 'call', callKey: 'canonical-call', args: { query: 'current news', tbs: 'qdr:d' } });
  const settle = extra => controller.event(context, { type: 'tool_execution_end', toolName: 'web_search', toolCallId: 'call', callKey: 'canonical-call', result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, results: ['a'.repeat(80000)], filterApplied: false, filterStatus: 'not_applied' }) }], details: receipt() }, isError: false, ...extra });
  return { store, controller, context, tool, settle };
}

test('durable tool projection preserves a fixed warning independently from truncated output and provider prose', t => {
  const f = fixture(t); f.settle(); const tool = f.tool();
  assert.equal(tool.status, 'succeeded'); assert.equal(tool.output.length, 64000); assert.throws(() => JSON.parse(tool.output));
  assert.deepEqual(tool.notice, { kind: 'web_time_filter_not_applied' }); assert.doesNotMatch(JSON.stringify(tool), /PRIVATE_PROVIDER_DETAIL|PRIVATE_STACK/);
  const reloaded = new Store(f.store.file).state.sessions.find(row => row.id === f.context.sessionId).items.find(row => row.tool?.id === 'call').tool;
  assert.deepEqual(reloaded.notice, tool.notice);
  f.settle({ result: { content: [{ type: 'text', text: '{"ok":true}' }], details: { ...receipt(), filterApplied: null, filterStatus: 'submitted_unverified' } } });
  assert.equal(f.tool().notice, undefined);
});

test('failed, uncertain, wrong-tool and non-authoritative metadata cannot create a succeeded search notice', t => {
  const f = fixture(t);
  for (const extra of [{ isError: true }, { uncertain: true }, { toolName: 'web_fetch' }, ...[{ provider: 'other' }, { operation: 'scrape' }, { filterApplied: null }, { filterStatus: 'submitted_unverified' }].map(change => ({ result: { content: [], details: { ...receipt(), ...change } } }))]) {
    f.settle(extra); assert.equal(f.tool().notice, undefined);
  }
  f.settle({ toolCallId: 'unrelated', callKey: 'unrelated' }); assert.equal(f.tool().notice, undefined);
});

test('a media tool keeps the files it wrote so the conversation can show them; nothing else is copied', t => {
  // Live, 2026-10-03: an image was generated, but the tool record kept only its text, so the image could not be shown.
  const dir = mkdtempSync(join(tmpdir(), 'rna-media-receipt-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json')), { session } = store.createProject({ name: 'Media receipts', workspace: dir });
  store.mutate(state => { const current = state.sessions.find(row => row.id === session.id); current.status = 'running'; current.activeTurnId = 'turn'; current.turns = [{ id: 'turn', status: 'running' }]; });
  const controller = Object.assign(Object.create(RuntimeController.prototype), { store, closed: false }), context = { sessionId: session.id, turnId: 'turn' };
  const tool = id => store.state.sessions.find(row => row.id === session.id).items.find(row => row.tool?.id === id).tool;
  const run = (id, name, details, extra = {}) => {
    controller.event(context, { type: 'tool_execution_start', toolName: name, toolCallId: id, callKey: `key-${id}`, args: { prompt: 'logo' } });
    controller.event(context, { type: 'tool_execution_end', toolName: name, toolCallId: id, callKey: `key-${id}`, result: { content: [{ type: 'text', text: '已生成 2 张图片' }], details }, isError: false, ...extra });
    return tool(id);
  };
  const files = [{ path: 'media/logo.png', mimeType: 'image/png', bytes: 1200, provider: 'PRIVATE' }, { path: 'media/logo-2.png', mimeType: 'image/png', bytes: 1300 }];
  assert.deepEqual(run('a', 'image_generate', { kind: 'image', model: 'gpt-image-2', providerId: 'p', files }).files, [{ path: 'media/logo.png', mimeType: 'image/png', bytes: 1200 }, { path: 'media/logo-2.png', mimeType: 'image/png', bytes: 1300 }]);
  assert.deepEqual(new Store(store.file).state.sessions.find(row => row.id === session.id).items.find(row => row.tool?.id === 'a').tool.files.map(file => file.path), ['media/logo.png', 'media/logo-2.png']);
  // Only media tools, only successes, only project-relative media files.
  assert.equal(run('b', 'project_write', { files }).files, undefined);
  assert.equal(run('c', 'image_generate', { files }, { isError: true }).files, undefined);
  assert.equal(run('d', 'image_generate', { files: [{ path: '/etc/passwd', mimeType: 'image/png', bytes: 1 }, { path: '../out.png', mimeType: 'image/png', bytes: 1 }, { path: 'a.html', mimeType: 'text/html', bytes: 1 }] }).files, undefined);
});
