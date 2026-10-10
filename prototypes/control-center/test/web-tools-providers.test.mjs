import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebToolsService, webProviderOf } from '../web-tools-service.mjs';

// The host side of the six search services: the same two tools, the service read from settings at each call.
// Each fixture answers in the documented shape of the service it stands for (packages/sdk/test/web-providers.test.mjs
// covers the shapes themselves).
const result = value => JSON.parse(value.content[0].text);
const replies = {
  brave: () => ({ type: 'search', web: { results: [{ url: 'https://example.com/brave', title: 'Brave result', description: 'From Brave' }] } }),
  tavily: path => (path === '/extract' ? { results: [{ url: 'https://example.com/', raw_content: '# Example Domain' }], failed_results: [] } : { results: [{ url: 'https://example.com/tavily', title: 'Tavily result', content: 'From Tavily', score: 0.9 }] }),
  fastcrw: path => (path.endsWith('/search') ? { success: true, data: { results: [{ url: 'https://example.com/crw', title: 'CRW result' }] } } : { success: true, data: { markdown: '# Example Domain', metadata: { sourceURL: 'https://example.com/', statusCode: 200 } } }),
};
async function fixture(t, provider, { status = 200, beforeReply = () => {} } = {}) {
  const requests = [], server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const path = req.url.split('?')[0]; requests.push({ method: req.method, path, query: new URL(req.url, 'http://x').searchParams, body: raw ? JSON.parse(raw) : null, headers: req.headers }); await beforeReply();
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(status === 200 ? replies[provider](path) : { error: 'refused' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
function host(t, webTools, options) {
  const store = { state: { configuration: { webTools: { enabled: true, timeoutMs: 2000, ...webTools } } }, key: 'synthetic-web-key', configurationService: {} };
  store.configurationService.secret = () => store.key;
  const service = new WebToolsService(store, options); t.after(() => service.close());
  return { store, service };
}

test('a configuration saved before there was a choice, or naming a service this version does not know, is FastCRW', () => {
  for (const config of [undefined, {}, { provider: 'fastcrw' }, { provider: 'unknown' }, { provider: 'constructor' }]) assert.equal(webProviderOf(config), 'fastcrw');
  assert.equal(webProviderOf({ provider: 'brave' }), 'brave');
});

test('the model sees the same two tools whichever service is configured, with no service name or address in them', t => {
  const descriptors = ['fastcrw', 'brave', 'zhipu'].map(provider => host(t, { provider, baseUrl: 'https://search.example.test' }).service.tools().map(({ execute, ...tool }) => tool));
  assert.deepEqual(descriptors[0], descriptors[1]); assert.deepEqual(descriptors[1], descriptors[2]);
  assert.deepEqual(descriptors[0].map(tool => [tool.name, tool.permission, tool.effect, tool.idempotent]), [['web_search', 'read', 'read', true], ['web_fetch', 'read', 'read', true]]);
  assert.doesNotMatch(JSON.stringify(descriptors[0]), /FastCRW|Brave|search\.example\.test|synthetic-web-key/);
});

test('Brave: the search goes to the service with its own key header, and the page is read from this machine without the key', async t => {
  const remote = await fixture(t, 'brave'), reads = [];
  const { service } = host(t, { provider: 'brave', baseUrl: remote.baseUrl }, { directFetch: async (url, options) => { reads.push({ url, timeoutMs: options.timeoutMs }); return { status: 200, finalUrl: url, contentType: 'text/html', title: 'Example Domain', description: '', markdown: '# Example Domain' }; } });
  const found = await service.execute('web_search', 's', { query: 'example domain', limit: 3 });
  assert.equal(found.isError, undefined); assert.deepEqual(result(found).results.map(row => row.url), ['https://example.com/brave']); assert.equal(found.details.provider, 'brave');
  assert.deepEqual(remote.requests.map(row => [row.method, row.path, row.query.get('q'), row.query.get('count'), row.headers['x-subscription-token'], row.headers.authorization]), [['GET', '/res/v1/web/search', 'example domain', '3', 'synthetic-web-key', undefined]]);
  const page = await service.execute('web_fetch', 'f', { url: 'https://example.com/' });
  assert.equal(page.isError, undefined); assert.deepEqual({ reader: result(page).reader, markdown: result(page).markdown }, { reader: 'direct', markdown: '# Example Domain' });
  assert.deepEqual(reads, [{ url: 'https://example.com/', timeoutMs: 2000 }]); assert.equal(remote.requests.length, 1, 'the search service is not asked for the page');
  for (const output of [found, page]) assert.equal(JSON.stringify(output).includes('synthetic-web-key'), false);
  assert.equal(service.controllers.size, 0);
});

test('a retained descriptor follows a change of service: the next call goes to the new one, in its shape, with its key', async t => {
  const crw = await fixture(t, 'fastcrw'), tavily = await fixture(t, 'tavily');
  const { store, service } = host(t, { provider: 'fastcrw', baseUrl: crw.baseUrl }), descriptor = service.tools()[0];
  assert.equal(result(await descriptor.execute('a', { query: 'q' })).provider, 'fastcrw');
  store.state.configuration.webTools = { ...store.state.configuration.webTools, provider: 'tavily', baseUrl: tavily.baseUrl }; store.key = 'synthetic-tavily-key';
  const second = result(await descriptor.execute('b', { query: 'q' }));
  assert.equal(second.provider, 'tavily'); assert.deepEqual(second.results.map(row => row.title), ['Tavily result']);
  assert.deepEqual([crw.requests.length, tavily.requests.length, tavily.requests[0].path, tavily.requests[0].headers.authorization], [1, 1, '/search', 'Bearer synthetic-tavily-key']);
});

test('a service changed while a call is being prepared stops that call: a key is never sent for a service it was not saved for', async t => {
  const remote = await fixture(t, 'tavily'); let store;
  // The call has read its configuration and key; the user then saves another service before the request leaves.
  let reached = 0; const made = host(t, { provider: 'tavily', baseUrl: remote.baseUrl }, { fetchImpl: () => { reached++; throw new Error('must not be reached'); } }); store = made.store;
  const original = store.configurationService.secret; let calls = 0;
  store.configurationService.secret = (...args) => { const key = original(...args); if (++calls === 1) store.state.configuration.webTools = { ...store.state.configuration.webTools, provider: 'brave' }; return key; };
  await assert.rejects(made.service.execute('web_search', 'x', { query: 'q' }), { code: 'WEB_ABORTED' });
  assert.equal(reached, 0); assert.equal(remote.requests.length, 0); assert.equal(made.service.controllers.size, 0);
});

test('the connection check names the service and how pages are read, and stops at a rejected key', async t => {
  const remote = await fixture(t, 'tavily'), ok = host(t, { provider: 'tavily', baseUrl: remote.baseUrl, enabled: false });
  assert.deepEqual(await ok.service.test(), { ok: true, provider: 'tavily', service: 'Tavily', reader: 'service', checks: [{ tool: 'web_search', ok: true }, { tool: 'web_fetch', ok: true }], testedTools: ['web_search', 'web_fetch'] });
  assert.deepEqual(remote.requests.map(row => row.path), ['/search', '/extract']); assert.equal(remote.requests[1].body.urls[0], 'https://example.com/');
  const refused = await fixture(t, 'brave', { status: 401 }), bad = host(t, { provider: 'brave', baseUrl: refused.baseUrl });
  const report = await bad.service.test();
  assert.deepEqual({ ok: report.ok, provider: report.provider, service: report.service, reader: report.reader, code: report.code, checks: report.checks.map(check => [check.tool, check.ok]) }, { ok: false, provider: 'brave', service: 'Brave Search', reader: 'direct', code: 'WEB_AUTH', checks: [['web_search', false]] });
  assert.equal(refused.requests.length, 1); assert.equal(JSON.stringify(report).includes('synthetic-web-key'), false);
});
