import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebToolsService } from '../web-tools-service.mjs';

const result = value => JSON.parse(value.content[0].text);
async function fixture(t, beforeReply = () => {}, status = 200) {
  const requests = [], server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ path: req.url, body, authorization: req.headers.authorization }); beforeReply(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { success: true, data: { results: [{ url: 'https://example.com/source', title: 'Source' }] } } : { success: false, errorCode: 'search_degraded' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = { state: { configuration: { webTools: { enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 } } }, key: 'isolated-first-credential', configurationService: {} };
  store.configurationService.secret = () => store.key;
  const service = new WebToolsService(store);
  t.after(async () => { service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, store, service };
}

test('global descriptor hides tbs and historical input sends one ordinary request without new downgrade metadata', async t => {
  const f = await fixture(t), descriptor = f.service.tools().find(tool => tool.name === 'web_search');
  assert.equal(Object.hasOwn(descriptor.parameters.properties, 'tbs'), false);
  const output = await descriptor.execute('search', { query: 'ai tools', limit: 5, tbs: 'qdr:w' });
  assert.equal(output.isError, undefined); assert.equal(result(output).ok, true); assert.equal(output.details.notice, undefined); assert.equal(output.details.filterApplied, undefined);
  assert.deepEqual(f.requests.map(({ path, body }) => ({ path, body })), [{ path: '/v1/search', body: { query: 'ai tools', limit: 5 } }]); assert.ok(!JSON.stringify(output).includes(f.store.key));
});

test('upstream search_degraded remains an error without a host or SDK retry', async t => {
  const f = await fixture(t, () => {}, 503);
  const output = await f.service.execute('web_search', 'once', { query: 'ai tools', tbs: 'qdr:w' });
  assert.equal(output.isError, true); assert.equal(output.details.code, 'FASTCRW_UPSTREAM'); assert.equal(f.requests.length, 1); assert.equal(f.service.controllers.size, 0);
});

test('close aborts the sole request and blocks retained descriptors after shutdown', async t => {
  let f; f = await fixture(t, () => f.service.close()); const descriptor = f.service.tools()[0];
  await assert.rejects(descriptor.execute('before', { query: 'ai tools', tbs: 'qdr:w' }), { code: 'FASTCRW_ABORTED' });
  assert.equal((await descriptor.execute('after', { query: 'ai tools' })).details.code, 'WEB_TOOLS_CLOSED'); assert.equal(f.requests.length, 1); assert.equal(f.service.controllers.size, 0);
});

test('retained global descriptor uses replacement credentials and endpoint at its next single dispatch', async t => {
  const first = await fixture(t), second = await fixture(t), descriptor = first.service.tools()[0];
  await descriptor.execute('first', { query: 'ai tools', tbs: 'qdr:w' }); first.store.key = 'replacement-secret'; first.store.state.configuration.webTools.baseUrl = second.store.state.configuration.webTools.baseUrl;
  const output = await descriptor.execute('second', { query: 'ai tools', tbs: 'qdr:w' });
  assert.equal(output.isError, undefined); assert.equal(first.requests.length, 1); assert.equal(second.requests.length, 1); assert.equal(second.requests[0].authorization, 'Bearer replacement-secret');
  assert.equal(Object.hasOwn(second.requests[0].body, 'tbs'), false); assert.ok(!JSON.stringify(output).includes('replacement-secret'));
});
