import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.mjs';
import { createServer } from '../server.mjs';
import { saveAttachment, readAttachment, attachmentTools, attachmentPrompt } from '../session-attachments.mjs';
import { SessionDeletionService } from '../session-deletion.mjs';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rna-attachments-')), store = new Store(join(dir, 'state.json'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store, ...store.createProject({ name: 'Files', workspace: dir }) };
}
const input = (text, name = 'notes.txt') => ({ name, type: 'text/plain', dataBase64: Buffer.from(text).toString('base64') });
test('uploaded bytes are durable, session-scoped and only readable by agent after submission', async t => {
  const f = fixture(t), { attachment } = saveAttachment(f.store, f.session.id, input('第一行\n第二行\n第三行'));
  assert.equal(attachment.metadataOnly, false); assert.equal(attachment.readable, true);
  const tool = attachmentTools(f.store, f.session.id)[0];
  await assert.rejects(tool.execute('a', { id: attachment.id }), e => e.status === 403);
  const other = f.store.createSession({ projectId: f.project.id });
  assert.throws(() => f.store.message(other.id, { text: 'read', attachments: [attachment] }), e => e.status === 404);
  f.store.message(f.session.id, { text: 'read', attachments: [{ ...attachment, name: 'forged', size: 0 }] });
  const sent = f.store.state.sessions.find(s => s.id === f.session.id).items.find(i => i.kind === 'user');
  assert.equal(sent.attachments[0].name, 'notes.txt'); assert.match(attachmentPrompt(sent), /notes\.txt：文本.*附件 ID/); assert.match(attachmentPrompt(sent), /<file name="attachments\/notes\.txt">/);
  const result = await tool.execute('a', { id: attachment.id, offset: 2, limit: 1 });
  assert.equal(result.content[0].text, '第二行\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]'); assert.equal(result.details.nextOffset, 3);
  const reopened = new Store(f.store.file);
  assert.equal(readAttachment(reopened, f.session.id, attachment.id).bytes.toString(), '第一行\n第二行\n第三行');
});
test('binary is preserved without claiming parsed content; integrity mismatch is rejected', async t => {
  const f = fixture(t), { attachment } = saveAttachment(f.store, f.session.id, { name: 'image.png', type: 'image/png', dataBase64: Buffer.from([137, 0, 80, 78]).toString('base64') });
  f.store.message(f.session.id, { text: 'read', attachments: [attachment] });
  assert.equal(attachment.readable, false);
  assert.equal((await attachmentTools(f.store, f.session.id)[0].execute('a', { id: attachment.id })).isError, true);
  writeFileSync(join(f.store.file + '.rna', f.session.id, 'attachments', attachment.id), 'changed');
  assert.throws(() => readAttachment(f.store, f.session.id, attachment.id), e => e.status === 409);
});
const raster = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1kAAAAASUVORK5CYII=';
test('an attachment-only submission preserves empty user text, durable provenance and request idempotency', t => {
  const f = fixture(t), { attachment } = saveAttachment(f.store, f.session.id, { name: '截图.png', dataBase64: raster });
  f.store.updateSession(f.session.id, { title: '新会话' });
  const request = { text: '  \n', attachments: [{ id: attachment.id, name: 'forged.png' }], requestId: 'image-only-send' };
  const first = f.store.message(f.session.id, request), duplicate = f.store.message(f.session.id, request);
  assert.equal(first.entry.text, ''); assert.equal(duplicate.duplicate, true);
  const session = f.store.state.sessions.find(session => session.id === f.session.id);
  assert.equal(session.title, '附件 · 截图.png');
  assert.equal(session.turns.length, 1); assert.equal(session.items.filter(item => item.kind === 'user').length, 1);
  assert.equal(session.items.find(item => item.kind === 'user').text, '');
  assert.equal(session.items.find(item => item.kind === 'user').attachments[0].name, '截图.png');
  const observation = f.store.state.projects.find(project => project.id === f.project.id).observations.find(item => item.data?.messageId === first.entry.id);
  assert.match(observation.text, /内容尚未读取/); assert.equal(observation.data.parser, 'attachment-submission');
  assert.deepEqual(observation.data.attachmentIds, [attachment.id]);
  const reopened = new Store(f.store.file).state.sessions.find(session => session.id === f.session.id);
  assert.equal(reopened.items.find(item => item.kind === 'user').text, '');
  assert.match(attachmentPrompt(reopened.items.find(item => item.kind === 'user')), /用户随消息上传的文件/);
  assert.throws(() => f.store.message(f.session.id, { ...request, text: 'Different intent' }), error => error.status === 409);
});
test('empty requests require a persisted attachment from this session, not claimed metadata or another session upload', t => {
  const f = fixture(t), other = f.store.createSession({ projectId: f.project.id });
  const { attachment } = saveAttachment(f.store, other.id, { name: 'other.png', dataBase64: raster });
  for (const request of [{}, { text: '' }, { text: ' \n', attachments: [] }, { text: '', attachments: [{ name: 'claimed.png', metadataOnly: false }] }, { text: '', attachments: [{ name: 'legacy.png', type: 'image/png', path: '/private/example.png' }] }]) {
    assert.throws(() => f.store.message(f.session.id, request), error => error.status === 400);
  }
  assert.throws(() => f.store.message(f.session.id, { text: '', attachments: [attachment] }), error => error.status === 404);
  assert.throws(() => f.store.message(f.session.id, { text: null, attachments: [] }), error => error.status === 400);
  assert.equal(f.store.state.sessions.find(session => session.id === f.session.id).turns.length, 0);
});
test('attachment-only steering and follow-up retain separate queue intents and survive restart', async t => {
  const f = fixture(t), { attachment } = saveAttachment(f.store, f.session.id, input('Queued attachment content'));
  f.store.message(f.session.id, { text: 'A task is already running' });
  for (const delivery of ['steer', 'followup']) {
    const request = { text: '', attachments: [{ id: attachment.id }], delivery, requestId: `attachment-${delivery}` };
    const result = f.store.message(f.session.id, request);
    assert.equal(result.queued, true); assert.equal(result.entry.delivery, delivery); assert.equal(result.entry.text, '');
    assert.equal(f.store.message(f.session.id, request).duplicate, true);
  }
  const reopened = new Store(f.store.file), session = reopened.state.sessions.find(session => session.id === f.session.id);
  assert.equal(session.turns.length, 1); assert.equal(session.inbox.length, 2);
  assert.deepEqual(session.inbox.map(item => [item.delivery, item.text, item.attachments[0].id]), [['steer', '', attachment.id], ['followup', '', attachment.id]]);
  assert.match((await attachmentTools(reopened, session.id)[0].execute('queued', { id: attachment.id })).content[0].text, /^Queued attachment content\n\n\[End of file/);
});
test('submitted image attachment returns intact pixels with detected MIME and provenance, without accepting a forged upload type', async t => {
  const f = fixture(t), { attachment } = saveAttachment(f.store, f.session.id, { name: 'sample.bin', type: 'application/octet-stream', dataBase64: raster });
  assert.equal(attachment.readable, false); assert.equal(attachment.imageMimeType, 'image/png');
  const tool = attachmentTools(f.store, f.session.id)[0];
  await assert.rejects(tool.execute('image', { id: attachment.id }), error => error.status === 403);
  f.store.message(f.session.id, { text: 'Inspect this image', attachments: [attachment] });
  const result = await tool.execute('image', { id: attachment.id });
  assert.deepEqual(result.content[1], { type: 'image', data: raster, mimeType: 'image/png' });
  assert.match(result.content[0].text, new RegExp(attachment.sha256)); assert.equal(result.details.providedAs, 'image');
  assert.equal((await tool.execute('image', { id: attachment.id, offset: 1 })).isError, true);
  const sent = f.store.state.sessions.find(session => session.id === f.session.id).items.find(item => item.kind === 'user');
  assert.match(attachmentPrompt(sent), /图片 image\/png/); assert.match(attachmentPrompt(sent), /用 attachment_read 查看图片/);
});
test('image data remains integrity checked and cannot cross a conversation boundary', async t => {
  const f = fixture(t), { attachment } = saveAttachment(f.store, f.session.id, { name: 'sample.png', dataBase64: raster });
  f.store.message(f.session.id, { text: 'read', attachments: [attachment] });
  const second = f.store.createSession({ projectId: f.project.id });
  await assert.rejects(attachmentTools(f.store, second.id)[0].execute('image', { id: attachment.id }), error => error.status === 403);
  const bytes = Buffer.from(raster, 'base64'); bytes[bytes.length - 1] ^= 1;
  writeFileSync(join(f.store.file + '.rna', f.session.id, 'attachments', attachment.id), bytes);
  await assert.rejects(attachmentTools(f.store, f.session.id)[0].execute('image', { id: attachment.id }), error => error.status === 409);
});
test('archive retains attachment bytes; deleting a session removes them without touching project files', async t => {
  const f = fixture(t), { attachment } = saveAttachment(f.store, f.session.id, input('private conversation'));
  writeFileSync(join(f.dir, 'project.txt'), 'keep');
  f.store.updateSession(f.session.id, { archived: true });
  assert.equal(readAttachment(f.store, f.session.id, attachment.id).bytes.toString(), 'private conversation');
  assert.throws(() => saveAttachment(f.store, f.session.id, input('late')), e => e.status === 409);
  f.store.deleteSession(f.session.id); const deletions = new SessionDeletionService(f.store); t.after(() => deletions.close());
  assert.equal((await deletions.wait(f.session.id)).status, 'completed');
  assert.equal(existsSync(join(f.store.file + '.rna', f.session.id)), false); assert.equal(existsSync(join(f.dir, 'project.txt')), true);
  assert.throws(() => saveAttachment(f.store, f.session.id, input('late')), e => e.status === 404);
});
test('uploads cannot follow private storage symlinks or accept malformed encoding/paths', t => {
  const f = fixture(t);
  for (const row of [input('a', '../secret'), { ...input('a'), dataBase64: 'YQ===' }, { ...input('a'), dataBase64: 'Y@==' }]) assert.throws(() => saveAttachment(f.store, f.session.id, row));
  const outside = join(f.dir, 'outside'); mkdirSync(outside); symlinkSync(outside, f.store.file + '.rna');
  assert.throws(() => saveAttachment(f.store, f.session.id, input('no')), e => e.status === 409);
});
test('HTTP upload/download returns original bytes with download headers and blocks cross-origin upload', async t => {
  const f = fixture(t), app = createServer({ stateFile: f.store.file, ticks: false, runtime: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`, url = `${base}/api/sessions/${f.session.id}/attachments`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input('<script>bad()</script>', '中文.html')) });
  assert.equal(res.status, 201); const { attachment } = await res.json();
  const download = await fetch(`${url}/${attachment.id}`);
  assert.equal(await download.text(), '<script>bad()</script>'); assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:7777' }, body: JSON.stringify(input('bad')) })).status, 403);
});
test('HTTP accepts image-only messages without a fabricated caption and rejects empty metadata-only requests', async t => {
  const f = fixture(t), app = createServer({ stateFile: f.store.file, ticks: false, runtime: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}/api/sessions/${f.session.id}`;
  const post = (path, body) => fetch(`${url}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const uploaded = await post('attachments', { name: 'clipboard.png', type: 'image/png', dataBase64: raster });
  assert.equal(uploaded.status, 201); const { attachment } = await uploaded.json();
  assert.equal((await post('messages', { text: '', attachments: [{ name: 'not-uploaded.png' }] })).status, 400);
  const accepted = await post('messages', { attachments: [{ id: attachment.id }], requestId: 'http-image-only' });
  assert.equal(accepted.status, 200); const result = await accepted.json();
  assert.equal(result.entry.text, ''); assert.equal(result.entry.attachments[0].id, attachment.id);
  const retried = await post('messages', { text: '', attachments: [{ id: attachment.id }], requestId: 'http-image-only' });
  assert.equal(retried.status, 200); assert.equal((await retried.json()).duplicate, true);
});
