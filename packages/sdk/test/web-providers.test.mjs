import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWebTools, normalizeWebBaseUrl, WEB_PROVIDERS, WEB_PROVIDER_IDS, WEB_TOOL_DECLARATIONS } from '../src/web-providers.mjs';

// web_search / web_fetch over the service the user chose. Each provider is driven against a local server that answers
// in the shape its official documentation gives (read 2026-10-10); only Firecrawl could be tried live, since it answers
// without a key. Synthetic keys only.
async function service(t, handler) {
  const calls = [], server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const call = { method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null }; calls.push(call);
    const answer = handler(call) ?? { status: 404, body: {} };
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...(answer.headers ?? {}) }); res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls };
}
const KEY = 'synthetic-web-key-0000';
const tools = (provider, baseUrl, extra = {}) => { const [search, fetch] = createWebTools({ provider, baseUrl, apiKey: KEY, timeoutMs: 5000, ...extra }); return { search: args => search.execute('c', args).then(result => ({ ...JSON.parse(result.content[0].text), isError: result.isError, details: result.details })), fetch: args => fetch.execute('c', args).then(result => ({ ...JSON.parse(result.content[0].text), isError: result.isError })) }; };

test('six services, one pair of tools: the model sees the same names and schemas whichever is configured', () => {
  assert.deepEqual(WEB_PROVIDER_IDS, ['fastcrw', 'firecrawl', 'tavily', 'brave', 'zhipu', 'bocha']);
  for (const id of WEB_PROVIDER_IDS) {
    const made = createWebTools({ provider: id, apiKey: KEY });
    assert.deepEqual(made.map(tool => [tool.name, tool.description, tool.parameters]), WEB_TOOL_DECLARATIONS.map(tool => [tool.name, tool.description, tool.parameters]), id);
    for (const tool of made) { assert.equal(tool.permission, 'read'); assert.equal(tool.effect, 'read'); assert.equal(tool.idempotent, true); assert.doesNotMatch(JSON.stringify(tool), new RegExp(KEY)); }
    assert.equal(normalizeWebBaseUrl(WEB_PROVIDERS[id].baseUrl), WEB_PROVIDERS[id].baseUrl);
  }
  assert.deepEqual(WEB_PROVIDER_IDS.filter(id => WEB_PROVIDERS[id].reader === 'direct'), ['brave', 'bocha'], 'the two that only search');
  assert.throws(() => createWebTools({ provider: 'bing' }), { code: 'WEB_CONFIGURATION' });
  for (const bad of ['http://example.com', 'https://example.com/?key=1', 'ftp://example.com', 'https://user:pass@example.com']) assert.throws(() => normalizeWebBaseUrl(bad), { code: 'WEB_CONFIGURATION' }, bad);
  assert.equal(normalizeWebBaseUrl('https://example.com/api/'), 'https://example.com/api'); assert.equal(normalizeWebBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
});

test('Firecrawl: v2 search (grouped or flat) and scrape, with a bearer key that is optional', async t => {
  const f = await service(t, call => {
    if (call.path === '/v2/search') return { body: call.body.query === 'flat' ? { success: true, data: [{ url: 'https://a.example/1', title: 'Flat', description: 'flat row' }] }
      : { success: true, warning: 'partial', data: { web: [{ url: 'https://a.example/w', title: 'Web', description: 'web snippet', position: 1 }, { url: 'javascript:alert(1)', title: 'bad' }], news: [{ url: 'https://a.example/n', title: 'News', snippet: 'news snippet', date: '3 days ago' }] } } };
    if (call.path === '/v2/scrape') return { body: call.body.url.endsWith('/gone') ? { success: true, data: { markdown: 'Not found', metadata: { statusCode: 404 } } } : { success: true, data: { markdown: `# Title\n\nBody with ${KEY} inside.`, metadata: { title: ['Title', 'Alt'], description: 'About', url: 'https://a.example/final', sourceURL: call.body.url, statusCode: 200 } } } };
  });
  const web = tools('firecrawl', f.baseUrl);
  const found = await web.search({ query: 'grouped', limit: 5, lang: 'zh', sources: ['web', 'news'] });
  assert.deepEqual(f.calls[0].body, { query: 'grouped', limit: 5, highlights: false, sources: ['web', 'news'] }); assert.equal(f.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(found.results, [{ url: 'https://a.example/w', title: 'Web', snippet: 'web snippet', source: 'web', position: 1 }, { url: 'https://a.example/n', title: 'News', snippet: 'news snippet', source: 'news', date: '3 days ago' }]);
  assert.deepEqual([found.provider, found.returnedResults, found.omittedResults, found.truncated], ['firecrawl', 2, 1, true], 'a row without a usable URL is counted, not returned');
  assert.deepEqual(found.warnings, ['partial', 'Firecrawl does not take lang; the results are not filtered by it.']);
  assert.deepEqual((await web.search({ query: 'flat' })).results, [{ url: 'https://a.example/1', title: 'Flat', snippet: 'flat row', source: 'web' }]);
  const page = await web.fetch({ url: 'https://a.example/page#part', maxChars: 12 });
  assert.equal(f.calls.at(-1).body.url, 'https://a.example/page'); assert.deepEqual(f.calls.at(-1).body.formats, ['markdown']);
  assert.deepEqual([page.provider, page.reader, page.title, page.description, page.sourceUrl, page.targetStatus, page.markdown, page.truncated], ['firecrawl', 'service', 'Title', 'About', 'https://a.example/final', 200, '# Title\n\nBod', true]);
  assert.doesNotMatch(JSON.stringify(page), new RegExp(KEY), 'a key echoed by a page is redacted');
  const gone = await web.fetch({ url: 'https://a.example/gone' }); assert.deepEqual([gone.isError, gone.code, gone.targetStatus], [true, 'WEB_TARGET_HTTP', 404]); assert.match(gone.message, /find the current address with web_search/);
  // No key: no Authorization header at all.
  const [keyless] = createWebTools({ provider: 'firecrawl', baseUrl: f.baseUrl }); await keyless.execute('c', { query: 'flat' }); assert.equal(f.calls.at(-1).headers.authorization, undefined);
});

test('Tavily: search with published dates, extract as Markdown, and its own quota statuses', async t => {
  let status = 200;
  const f = await service(t, call => {
    if (status !== 200) return { status, body: { detail: { error: 'limit' } } };
    if (call.path === '/search') return { body: { query: call.body.query, results: [{ title: 'T', url: 'https://t.example/a', content: 'tavily content', score: 0.91, published_date: 'Tue, 11 Mar 2025 17:00:00 GMT' }] } };
    if (call.path === '/extract') return { body: call.body.urls[0].endsWith('/blocked') ? { results: [], failed_results: [{ url: call.body.urls[0], error: 'blocked' }] } : { results: [{ url: call.body.urls[0], raw_content: 'Extracted **markdown**' }], failed_results: [] } };
  });
  const web = tools('tavily', f.baseUrl);
  const found = await web.search({ query: 'q', limit: 3 });
  assert.deepEqual(f.calls[0].body, { query: 'q', max_results: 3, include_published_date: true }); assert.equal(f.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(found.results, [{ url: 'https://t.example/a', title: 'T', snippet: 'tavily content', date: 'Tue, 11 Mar 2025 17:00:00 GMT', score: 0.91 }]);
  await web.search({ query: 'q', sources: ['news'] }); assert.deepEqual(f.calls.at(-1).body, { query: 'q', max_results: 5, topic: 'news' });
  const page = await web.fetch({ url: 'https://t.example/a' }); assert.deepEqual(f.calls.at(-1).body, { urls: ['https://t.example/a'], format: 'markdown' }); assert.equal(page.markdown, 'Extracted **markdown**');
  const blocked = await web.fetch({ url: 'https://t.example/blocked' }); assert.equal(blocked.code, 'WEB_TARGET_FAILED'); assert.match(blocked.message, /Do not fetch it again/);
  for (const [code, expected] of [[432, 'WEB_QUOTA'], [433, 'WEB_QUOTA'], [401, 'WEB_AUTH'], [429, 'WEB_RATE_LIMIT'], [503, 'WEB_UPSTREAM'], [400, 'WEB_REQUEST_REJECTED']]) { status = code; const failed = await web.search({ query: 'q' }); assert.deepEqual([failed.isError, failed.code, failed.status], [true, expected, code]); }
});

test('Brave: a GET with the subscription token, language mapped, and pages read straight from this machine', async t => {
  let invalid = false;
  const f = await service(t, call => invalid ? { status: 422, body: { type: 'ErrorResponse', error: { status: 422, code: 'SUBSCRIPTION_TOKEN_INVALID' } } }
    : { body: { type: 'search', web: { results: [{ title: 'B', url: 'https://b.example/a', description: 'brave description', age: '2 days ago', page_age: '2026-10-08T09:00:00' }] }, news: { results: [{ title: 'BN', url: 'https://b.example/n', description: 'news', age: '1 hour ago' }] } } });
  const read = []; const web = tools('brave', f.baseUrl, { directFetch: async (url, options) => { read.push([url, typeof options.timeoutMs, options.signal instanceof AbortSignal]); return url.endsWith('/gone') ? { status: 410, finalUrl: url, title: '', description: '', markdown: '' } : { status: 200, finalUrl: 'https://b.example/final', title: 'Read here', description: 'd', markdown: '# Read here\n\nDirect text.' }; } });
  const found = await web.search({ query: '卡丁车 背景音乐', limit: 4, lang: 'zh', sources: ['web', 'news', 'images'] });
  const sent = new URL(f.calls[0].path, 'http://x'); assert.equal(f.calls[0].method, 'GET'); assert.equal(sent.pathname, '/res/v1/web/search');
  assert.deepEqual(Object.fromEntries(sent.searchParams), { q: '卡丁车 背景音乐', count: '4', text_decorations: 'false', result_filter: 'web,news', search_lang: 'zh-hans' });
  assert.equal(f.calls[0].headers['x-subscription-token'], KEY); assert.equal(f.calls[0].headers.authorization, undefined);
  assert.deepEqual(found.results, [{ url: 'https://b.example/a', title: 'B', snippet: 'brave description', source: 'web', date: '2026-10-08T09:00:00' }, { url: 'https://b.example/n', title: 'BN', snippet: 'news', source: 'news', date: '1 hour ago' }]);
  assert.deepEqual(found.warnings, ['Brave Search does not take sources:images; the results are not filtered by it.']);
  // Brave has no page endpoint: web_fetch reads the page from this machine and says so.
  const page = await web.fetch({ url: 'https://b.example/a' });
  assert.deepEqual(read, [['https://b.example/a', 'number', true]]); assert.equal(f.calls.length, 1, 'the search service is not asked for a page');
  assert.deepEqual([page.provider, page.reader, page.title, page.sourceUrl, page.markdown], ['brave', 'direct', 'Read here', 'https://b.example/final', '# Read here\n\nDirect text.']); assert.match(page.evidence, /text drawn by scripts is missing/);
  assert.deepEqual(await web.fetch({ url: 'https://b.example/gone' }).then(row => [row.code, row.targetStatus]), ['WEB_TARGET_HTTP', 410]);
  // An invalid token answers 422 there, not 401.
  invalid = true; const failed = await web.search({ query: 'q' }); assert.equal(failed.code, 'WEB_AUTH'); assert.match(failed.message, /tell the user to check the key/);
});

test('Zhipu and Bocha: the mainland services, with a reader for one and direct reading for the other', async t => {
  let arrears = false;
  const zhipu = await service(t, call => {
    if (arrears) return { status: 429, body: { error: { code: '1113', message: '余额不足' } } };
    if (call.path === '/web_search') return { body: { id: 'x', search_result: [{ title: '智谱结果', content: '内容摘要', link: 'https://z.example/a', media: '媒体', publish_date: '2025-05-23' }] } };
    if (call.path === '/reader') return { body: { reader_result: { title: '页面', description: '描述', url: call.body.url, content: '# 页面\n\n正文' } } };
  });
  const z = tools('zhipu', zhipu.baseUrl);
  assert.deepEqual((await z.search({ query: '国产大模型 发布', limit: 2, lang: 'zh' })).results, [{ url: 'https://z.example/a', title: '智谱结果', snippet: '内容摘要', date: '2025-05-23' }]);
  assert.deepEqual(zhipu.calls[0].body, { search_query: '国产大模型 发布', search_engine: 'search_std', search_intent: false, count: 2 }); assert.equal(zhipu.calls[0].headers.authorization, `Bearer ${KEY}`);
  const page = await z.fetch({ url: 'https://z.example/a' }); assert.deepEqual(zhipu.calls.at(-1).body, { url: 'https://z.example/a', return_format: 'markdown' }); assert.deepEqual([page.title, page.markdown, page.reader], ['页面', '# 页面\n\n正文', 'service']);
  arrears = true; assert.equal((await z.search({ query: 'q' })).code, 'WEB_QUOTA', 'code 1113 (arrears) arrives as HTTP 429');

  const bocha = await service(t, call => ({ body: call.body.query === 'bare' ? { webPages: { value: [{ name: '裸结构', url: 'https://c.example/b', summary: '摘要' }] } }
    : { code: 200, log_id: 'l', msg: null, data: { _type: 'SearchResponse', webPages: { value: [{ id: '1', name: '博查结果', url: 'https://c.example/a', siteName: '站点', snippet: '片段', datePublished: '2024-07-22T00:00:00+08:00' }] } } } }));
  const b = tools('bocha', bocha.baseUrl, { directFetch: async url => ({ status: 200, finalUrl: url, title: 't', description: '', markdown: '直接读取的正文' }) });
  assert.deepEqual((await b.search({ query: '搜索', limit: 3 })).results, [{ url: 'https://c.example/a', title: '博查结果', snippet: '片段', date: '2024-07-22T00:00:00+08:00' }]);
  assert.equal(bocha.calls[0].path, '/v1/web-search'); assert.deepEqual(bocha.calls[0].body, { query: '搜索', count: 3, summary: false, freshness: 'noLimit' });
  assert.deepEqual((await b.search({ query: 'bare' })).results, [{ url: 'https://c.example/b', title: '裸结构', snippet: '摘要' }], 'with or without the outer wrapper');
  assert.equal((await b.fetch({ url: 'https://c.example/a' })).reader, 'direct');
});

test('whatever the service: bad arguments never leave, a redirect is refused, a silent or broken answer is named, a page here is not read', async t => {
  let mode = 'redirect';
  const f = await service(t, () => mode === 'redirect' ? { status: 302, headers: { location: 'https://elsewhere.example/' } } : mode === 'html' ? { body: '<html>not json</html>' } : mode === 'empty' ? { body: { results: [] } } : mode === 'slow' ? null : { body: { results: [{ url: 'https://t.example/a' }] } });
  const web = tools('tavily', f.baseUrl);
  for (const args of [{}, { query: '' }, { query: 'q', limit: 0 }, { query: 'q', limit: 21 }, { query: 'q', lang: '中文' }, { query: 'q', sources: ['video'] }, { query: 'q', extra: 1 }]) assert.equal((await web.search(args)).code, 'WEB_ARGUMENTS', JSON.stringify(args));
  for (const args of [{}, { url: 'ftp://x.example/' }, { url: 'https://user:pass@x.example/' }, { url: 'https://x.example/', maxChars: 0 }]) assert.equal((await web.fetch(args)).code, 'WEB_ARGUMENTS', JSON.stringify(args));
  assert.equal(f.calls.length, 0, 'nothing was sent for invalid arguments');
  assert.deepEqual(await web.search({ query: 'q' }).then(row => [row.code, row.status]), ['WEB_REDIRECT', 302]);
  mode = 'html'; assert.equal((await web.search({ query: 'q' })).code, 'WEB_RESPONSE_INVALID');
  mode = 'untitled'; assert.equal((await web.search({ query: 'q' })).code, 'WEB_RESPONSE_INVALID', 'rows the tool cannot use at all are not an empty result');
  mode = 'empty'; assert.deepEqual(await web.search({ query: 'q' }).then(row => [row.ok, row.returnedResults]), [true, 0]);
  const [search] = createWebTools({ provider: 'tavily', baseUrl: 'http://127.0.0.1:1', apiKey: KEY, timeoutMs: 2000 }); assert.equal(JSON.parse((await search.execute('c', { query: 'q' })).content[0].text).code, 'WEB_NETWORK');
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(createWebTools({ provider: 'tavily', baseUrl: f.baseUrl })[0].execute('c', { query: 'q' }, aborted.signal), { code: 'WEB_ABORTED' });
  // The built-in reader's own refusals come through with their reasons (web-direct-fetch.test.mjs covers the reader).
  const local = await tools('brave', f.baseUrl).fetch({ url: 'http://127.0.0.1:1/' }); assert.equal(local.code, 'WEB_URL_NOT_PUBLIC'); assert.match(local.message, /not read/);
  // A service that needs a key is not asked without one; reading a page from this machine needs no key.
  const sent = f.calls.length, keyless = tools('brave', f.baseUrl, { apiKey: '', directFetch: async url => ({ status: 200, finalUrl: url, contentType: 'text/html', title: 'T', description: '', markdown: 'page text' }) });
  assert.deepEqual(await keyless.search({ query: 'q' }).then(row => [row.code, row.keyMissing, /Brave Search.*add the key in settings/.test(row.message)]), ['WEB_AUTH', true, true]);
  assert.equal(f.calls.length, sent, 'nothing was sent'); assert.equal((await keyless.fetch({ url: 'https://example.com/' })).markdown, 'page text');
  // Firecrawl answers without a key, so it is asked.
  assert.notEqual((await tools('firecrawl', f.baseUrl, { apiKey: '' }).search({ query: 'q' })).code, 'WEB_AUTH'); assert.equal(f.calls.length, sent + 1); assert.equal(f.calls.at(-1).headers.authorization, undefined);
});
