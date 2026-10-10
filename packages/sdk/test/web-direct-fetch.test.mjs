import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { DirectFetchError, fetchPageDirect, htmlToMarkdown, localName, publicAddress } from '../src/web-direct-fetch.mjs';

// The page reader for search providers without a page endpoint (harness web-fetch-http: an anonymous GET from this
// machine, public addresses only). The fixture server listens on loopback, so tests admit it through `allowAddress`.
async function fixture(t, handler) {
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const anywhere = { allowAddress: () => true, timeoutMs: 5000 };
const code = expected => error => error instanceof DirectFetchError && error.code === expected;

test('only addresses a public page can live on are admitted', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '::ffff:8.8.8.8', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e']) assert.equal(publicAddress(address), true, address);
  for (const address of ['127.0.0.1', '127.255.255.254', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.2.5', '198.51.100.1', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    '::', '::1', '[::1]', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::7f00:1', 'fe80::1', 'fe80::1%en0', 'fd12:3456::1', 'fc00::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::', '2002:c0a8:101::', '2001:0:4136:e378::1', 'example.com', '', '1.2.3', '999.1.1.1']) assert.equal(publicAddress(address), false, address);
  // Live, 2026-10-10: a proxy client in fake-IP mode answered every name with 198.18.0.x / 2001:2::x, the benchmarking
  // ranges no real host uses. Refusing them would refuse every page on such a machine.
  for (const address of ['198.18.0.24', '198.19.255.1', '2001:2::1a']) assert.equal(publicAddress(address), true, address);
  for (const name of ['localhost', 'LOCALHOST.', 'printer', 'nas.local', 'db.internal', 'router.lan', 'x.home.arpa', 'app.localhost']) assert.equal(localName(name), true, name);
  for (const name of ['example.com', 'local.example.com', 'internal.example.org', 'xn--fiq228c.cn']) assert.equal(localName(name), false, name);
});

test('this machine and private networks are refused before any connection, by address, by name, and through a redirect or a mixed answer', async t => {
  let hits = 0; const base = await fixture(t, (_req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>private</p>'); });
  for (const url of [`${base}/`, 'http://localhost:1/', 'http://[::1]:1/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://printer/', 'http://nas.local/']) await assert.rejects(fetchPageDirect(url, { timeoutMs: 2000 }), code('WEB_URL_NOT_PUBLIC'), url);
  assert.equal(hits, 0, 'nothing reached the loopback server');
  // A name answering both a public and a private address is refused: the connection could go to either.
  const mixed = (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
  await assert.rejects(fetchPageDirect('http://rebind.example/', { lookup: mixed, timeoutMs: 2000 }), code('WEB_URL_NOT_PUBLIC'));
  // The address that was checked is the one connected to: the name is resolved once, however often the socket asks.
  let lookups = 0; const once = (_host, _options, callback) => { lookups++; callback(null, [{ address: '127.0.0.1', family: 4 }]); };
  const page = await fetchPageDirect(`${base.replace('127.0.0.1', 'pinned.example')}/`, { lookup: once, allowAddress: () => true, timeoutMs: 5000 });
  assert.equal(page.markdown, 'private'); assert.equal(lookups, 1);
  // A public page that redirects to a private address is stopped at that hop.
  const outside = await fixture(t, (_req, res) => { res.writeHead(302, { location: 'http://192.168.1.1/admin' }); res.end(); });
  await assert.rejects(fetchPageDirect(`${outside}/`, { allowAddress: address => address === '127.0.0.1', timeoutMs: 2000 }), code('WEB_URL_NOT_PUBLIC'));
  for (const url of ['ftp://example.com/', 'file:///etc/passwd', 'https://user:pass@example.com/', 'not a url']) await assert.rejects(fetchPageDirect(url), code('WEB_ARGUMENTS'), url);
});

test('a page is followed through redirects, decompressed, decoded in its own charset and returned as Markdown', async t => {
  const html = '<!doctype html><html><head><title>报告 &amp; 说明</title><meta name="description" content="一段描述"><style>p{}</style></head><body><h1>标题</h1><p>正文，含 <a href="/a?b=1">链接</a>。</p><script>track()</script></body></html>';
  const base = await fixture(t, (req, res) => {
    if (req.url === '/start') { res.writeHead(301, { location: '/middle' }); return res.end(); }
    if (req.url === '/middle') { res.writeHead(302, { location: '/page#top' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (req.url === '/br') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br' }); return res.end(brotliCompressSync(html)); }
    if (req.url === '/gbk') { res.writeHead(200, { 'content-type': 'text/html; charset=gb2312' }); return res.end(Buffer.from([0x3c, 0x70, 0x3e, 0xc4, 0xe3, 0xba, 0xc3, 0x3c, 0x2f, 0x70, 0x3e])); }
    if (req.url === '/meta-gbk') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(Buffer.concat([Buffer.from('<meta charset="gbk"><p>'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from('</p>')])); }
    if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"a":1}'); }
    if (req.url === '/png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end('x'); }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('x'.repeat(5000)); }
    if (req.url === '/gone') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<p>missing</p>'); }
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined); assert.match(req.headers['user-agent'], /^RnaAgent\//);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' }); res.end(gzipSync(html));
  });
  const page = await fetchPageDirect(`${base}/start`, anywhere);
  assert.deepEqual({ status: page.status, finalUrl: page.finalUrl, title: page.title, description: page.description }, { status: 200, finalUrl: `${base}/page`, title: '报告 & 说明', description: '一段描述' });
  assert.equal(page.markdown, `# 标题\n\n正文，含 [链接](${base}/a?b=1)。`, 'links are absolute; scripts and styles are gone');
  assert.equal((await fetchPageDirect(`${base}/br`, anywhere)).title, '报告 & 说明');
  assert.equal((await fetchPageDirect(`${base}/gbk`, anywhere)).markdown, '你好'); assert.equal((await fetchPageDirect(`${base}/meta-gbk`, anywhere)).markdown, '你好');
  assert.equal((await fetchPageDirect(`${base}/json`, anywhere)).markdown, '{"a":1}', 'a text type that is not HTML is returned as it is');
  // A page that answers 404 is a fact about the page: its status comes back, with no text.
  assert.deepEqual(await fetchPageDirect(`${base}/gone`, anywhere), { status: 404, finalUrl: `${base}/gone`, contentType: 'text/html', title: '', description: '', markdown: '' });
  await assert.rejects(fetchPageDirect(`${base}/loop`, anywhere), code('WEB_REDIRECTS'));
  await assert.rejects(fetchPageDirect(`${base}/png`, anywhere), code('WEB_UNSUPPORTED_TYPE'));
  await assert.rejects(fetchPageDirect(`${base}/big`, { ...anywhere, maxBytes: 1000 }), code('WEB_RESPONSE_TOO_LARGE'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchPageDirect(`${base}/page`, { ...anywhere, signal: controller.signal }), code('WEB_ABORTED'));
});

test('a server that never answers ends at the timeout; a closed port is a network failure', async t => {
  const silent = await fixture(t, () => { /* never answers */ });
  await assert.rejects(fetchPageDirect(`${silent}/`, { allowAddress: () => true, timeoutMs: 200 }), code('WEB_TIMEOUT'));
  await assert.rejects(fetchPageDirect('http://127.0.0.1:1/', { allowAddress: () => true, timeoutMs: 2000 }), code('WEB_NETWORK'));
});

test('HTML becomes readable Markdown: headings, lists, links, code, tables; the main content is preferred', () => {
  const body = `<nav><a href="/home">首页</a></nav><main><h2>小节</h2><p>段落一。<br>换行后。</p><ul><li>甲</li><li>乙<ul><li>乙一</li></ul></li></ul><ol><li>一</li><li>二</li></ol><pre>line1\n  line2</pre><blockquote>引用</blockquote><table><tr><th>名</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table><p>结尾&nbsp;&#x4e2d;&#25991; &lt;tag&gt; &unknown; <img src="x.png" alt="图示"> <a href="javascript:alert(1)">坏链接</a> <a href="https://e.org/x">https://e.org/x</a></p>${'<p>填充内容用于超过主内容长度阈值。</p>'.repeat(12)}</main><footer>页脚</footer>`;
  const page = htmlToMarkdown(`<html><head><title> T </title></head><body>${body}</body></html>`, 'https://example.com/dir/page.html');
  assert.equal(page.title, 'T');
  assert.ok(page.markdown.startsWith('## 小节\n\n段落一。\n换行后。\n\n- 甲\n- 乙\n  - 乙一\n\n1. 一\n2. 二\n\n```\nline1\n  line2\n```\n\n> 引用\n\n名 | 值\na | 1\n\n结尾 中文 <tag> &unknown; [image: 图示] 坏链接 https://e.org/x'), page.markdown.slice(0, 220));
  assert.doesNotMatch(page.markdown, /首页|页脚|javascript:/, 'navigation outside <main> and script links are left out');
  // Without a main region the whole body is used; a description falls back to Open Graph.
  const plain = htmlToMarkdown('<head><meta property="og:title" content="OG 标题"><meta property="og:description" content="OG 描述"></head><body><div>一</div><div>二</div></body>', 'https://example.com/');
  assert.deepEqual(plain, { title: 'OG 标题', description: 'OG 描述', markdown: '一\n\n二' });
});
