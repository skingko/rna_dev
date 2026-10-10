/**
 * Reads one public web page straight from this machine: an anonymous GET, for search providers that have no page
 * endpoint of their own (harness web-fetch-http: public addresses only, redirects followed by hand, bounded size,
 * text types only). Nothing here reads credentials or cookies.
 *
 * The address a name resolves to is checked and then the connection is made to that same address, so a name cannot
 * answer "public" to the check and "127.0.0.1" to the connection. Every redirect hop is checked the same way.
 */
import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export const DIRECT_FETCH_MAX_BYTES = 5 * 1024 * 1024, DIRECT_FETCH_REDIRECTS = 5;
export class DirectFetchError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'DirectFetchError'; this.code = code; this.details = details; }
}
const fail = (code, message, details) => new DirectFetchError(code, message, details);

/** The 16 bytes of an IPv6 address, or null. */
function ipv6Bytes(text) {
  let value = text.replace(/^\[|\]$/g, '').split('%')[0];
  const embedded = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (embedded) { const parts = embedded[2].split('.').map(Number); if (parts.some(part => part > 255)) return null; value = `${embedded[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`; }
  const halves = value.split('::'); if (halves.length > 2) return null;
  const groups = side => (side ? side.split(':') : []);
  const head = groups(halves[0]), tail = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - tail.length; if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail], bytes = [];
  for (const group of all) { if (!/^[0-9a-f]{1,4}$/i.test(group)) return null; const number = parseInt(group, 16); bytes.push(number >> 8, number & 255); }
  return bytes;
}
function publicIPv4(a, b, c, d) {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;                 // this network, private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false;                              // carrier-grade NAT
  if (a === 169 && b === 254) return false;                                        // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;                  // protocol assignments, documentation
  if (a === 192 && b === 88 && c === 99) return false;                             // 6to4 relay
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
  return d !== undefined;
}
/**
 * Whether an IP address is one a public web page can live on (not loopback, private, link-local, reserved or a wrapper
 * around one). The benchmarking ranges 198.18.0.0/15 and 2001:2::/48 are admitted: no real host lives there, and a
 * proxy client in fake-IP mode (common where the web is reached through one) answers every name with an address from
 * them, so refusing them would refuse every page on such a machine. Behind such a proxy the real address is not
 * visible here at all; names that are plainly local are refused by name instead (`localName`).
 */
export function publicAddress(address) {
  const text = String(address ?? '');
  if (isIP(text) === 4) { const parts = text.split('.').map(Number); return publicIPv4(...parts); }
  const bytes = ipv6Bytes(text); if (!bytes) return false;
  const zero = (from, to) => bytes.slice(from, to).every(byte => byte === 0);
  if (zero(0, 15) && bytes[15] <= 1) return false;                                 // :: and ::1
  if (zero(0, 10) && bytes[10] === 255 && bytes[11] === 255) return publicIPv4(...bytes.slice(12));   // IPv4-mapped
  if (zero(0, 12)) return false;                                                   // IPv4-compatible (deprecated)
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) return publicIPv4(...bytes.slice(12));   // NAT64
  if ((bytes[0] & 0xfe) === 0xfc) return false;                                    // unique local fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false;               // link-local fe80::/10
  if (bytes[0] === 0xff) return false;                                             // multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;  // documentation
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return publicIPv4(...bytes.slice(2, 6));                  // 6to4 carries an IPv4 address
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) return false;        // Teredo
  return true;
}

/** A name that can only be this machine or its local network, whatever it resolves to. */
export const localName = hostname => { const name = String(hostname).toLowerCase().replace(/\.$/, ''); return name === 'localhost' || !name.includes('.') && !name.includes(':') || /\.(?:localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/.test(name); };
const TEXT_TYPES = /^(?:text\/(?:html|plain|markdown|xml|csv)|application\/(?:xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))$/i;
const resolve = (hostname, lookup) => new Promise((done, reject) => lookup(hostname, { all: true }, (error, addresses) => (error ? reject(error) : done(Array.isArray(addresses) ? addresses : [{ address: addresses, family: isIP(addresses) }]))));

/** One GET with no redirect following. Resolves `{ status, headers, body }`; the body is read only for a 2xx text response. */
function getOnce(url, { timeoutMs, maxBytes, signal, lookup, allowAddress, userAgent }) {
  return new Promise((done, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    (async () => {
      let addresses;
      if (!isIP(host) && localName(host)) throw fail('WEB_URL_NOT_PUBLIC', 'The URL names this machine or a local network; such pages are not read.');
      if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
      else { try { addresses = await resolve(host, lookup); } catch { throw fail('WEB_NETWORK', 'The site\'s name could not be resolved.'); } }
      if (!addresses.length || addresses.some(row => !allowAddress(row.address))) throw fail('WEB_URL_NOT_PUBLIC', 'The URL does not lead to a public internet address; pages on this machine or a private network are not read.');
      // The connection goes to the address that was checked, whatever the name answers next.
      const pinned = addresses[0], pin = (_hostname, options, callback) => (options?.all ? callback(null, [{ address: pinned.address, family: pinned.family }]) : callback(null, pinned.address, pinned.family));
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'GET', lookup: pin, signal, timeout: timeoutMs,
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'accept-encoding': 'gzip, deflate, br' } });
      request.on('timeout', () => request.destroy(fail('WEB_TIMEOUT', 'The page did not answer in time.')));
      request.on('error', error => reject(error instanceof DirectFetchError ? error : signal?.aborted ? fail('WEB_ABORTED', 'Web request cancelled.') : fail('WEB_NETWORK', 'The site could not be reached.')));
      request.on('response', response => {
        const status = response.statusCode ?? 0, headers = response.headers, type = String(headers['content-type'] ?? '').split(';')[0].trim();
        if (status < 200 || status >= 300) { response.resume(); return done({ status, headers, body: null }); }
        if (type && !TEXT_TYPES.test(type)) { response.destroy(); return reject(fail('WEB_UNSUPPORTED_TYPE', `The URL is not a text page (${type.slice(0, 80)}).`, { contentType: type.slice(0, 80) })); }
        if (Number(headers['content-length']) > maxBytes) { response.destroy(); return reject(fail('WEB_RESPONSE_TOO_LARGE', 'The page is larger than the reading limit.')); }
        const encoding = String(headers['content-encoding'] ?? '').toLowerCase().trim();
        const stream = encoding === 'gzip' || encoding === 'x-gzip' ? response.pipe(createGunzip()) : encoding === 'deflate' ? response.pipe(createInflate()) : encoding === 'br' ? response.pipe(createBrotliDecompress()) : response;
        const chunks = []; let size = 0;
        stream.on('data', chunk => { size += chunk.length; if (size > maxBytes) { response.destroy(); stream.destroy(); reject(fail('WEB_RESPONSE_TOO_LARGE', 'The page is larger than the reading limit.')); } else chunks.push(chunk); });
        stream.on('error', () => reject(fail('WEB_NETWORK', 'The page could not be read completely.')));
        stream.on('end', () => done({ status, headers, body: Buffer.concat(chunks) }));
      });
      request.end();
    })().catch(reject);
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', deg: '°' };
const decodeEntities = text => text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});/gi, (whole, name) => {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
  const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
});
const attribute = (tag, name) => { const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag); return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : ''; };

/** The page's charset: the HTTP header, else a byte-order mark, else its meta tag, else UTF-8. */
function decodeBody(bytes, contentType) {
  const header = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8' : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'))?.[1];
  for (const label of [header, bom, meta, 'utf-8']) { if (!label) continue; try { return new TextDecoder(label.toLowerCase() === 'gb2312' ? 'gbk' : label).decode(bytes); } catch { /* an unknown label falls through to the next source */ } }
  return bytes.toString('utf8');
}

const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'ul', 'ol', 'table', 'tr', 'blockquote', 'pre', 'figure', 'figcaption', 'form', 'dl', 'dt', 'dd', 'details', 'summary', 'address', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'thead', 'tbody', 'tfoot', 'caption']);
/**
 * A page's readable text as Markdown: headings, paragraphs, lists, links (made absolute), code and table rows. Scripts,
 * styles, forms' controls and other non-content elements are dropped; `<main>` or `<article>` is preferred when present.
 */
export function htmlToMarkdown(html, baseUrl) {
  const head = html.slice(0, html.search(/<body[\s>]/i) >= 0 ? html.search(/<body[\s>]/i) : Math.min(html.length, 32768));
  const metaContent = pattern => { const tag = pattern.exec(head)?.[0]; return tag ? attribute(tag, 'content').replace(/\s+/g, ' ').trim() : ''; };
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() || metaContent(/<meta[^>]+property\s*=\s*["']og:title["'][^>]*>/i);
  const description = metaContent(/<meta[^>]+name\s*=\s*["']description["'][^>]*>/i) || metaContent(/<meta[^>]+property\s*=\s*["']og:description["'][^>]*>/i);
  let body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|iframe|template|select|button|canvas|object|embed|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  for (const name of ['main', 'article']) { const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*)<\\/${name}\\s*>`, 'i').exec(body); if (match && match[1].replace(/<[^>]*>/g, '').trim().length > 200) { body = match[1]; break; } }
  const absolute = href => { try { const url = new URL(href, baseUrl); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
  const out = []; let pre = 0, list = [], link = null, cell = false;
  const push = text => { out.push(text); };
  const newline = (count = 2) => { const tail = out.join('').slice(-2), have = tail.endsWith('\n\n') ? 2 : tail.endsWith('\n') ? 1 : out.length ? 0 : 2; if (have < count) push('\n'.repeat(count - have)); };
  for (const part of body.split(/(<[^>]*>)/)) {
    if (!part) continue;
    if (part[0] !== '<') {
      const text = decodeEntities(part);
      push(pre ? text : text.replace(/\s+/g, ' ').replace(/^ (?=$)/, ' '));
      continue;
    }
    const match = /^<(\/?)([a-z][a-z0-9]*)/i.exec(part); if (!match) continue;
    const closing = match[1] === '/', name = match[2].toLowerCase();
    if (name === 'br') { push('\n'); continue; }
    if (name === 'pre') { newline(closing ? 1 : 2); push(closing ? '```' : '```\n'); pre += closing ? -1 : 1; if (closing) newline(); continue; }
    if (name === 'code' && !pre) { push('`'); continue; }
    if (/^h[1-6]$/.test(name)) { newline(); if (!closing) push(`${'#'.repeat(Number(name[1]))} `); continue; }
    if (name === 'li') { if (!closing) { newline(1); const top = list.at(-1); push(`${'  '.repeat(Math.max(0, list.length - 1))}${top?.ordered ? `${++top.index}. ` : '- '}`); } continue; }
    if (name === 'ul' || name === 'ol') { if (closing) list.pop(); else list.push({ ordered: name === 'ol', index: 0 }); newline(list.length ? 1 : 2); continue; }
    if (name === 'a') {
      if (!closing) { const href = absolute(attribute(part, 'href')); link = href ? { href, at: out.length } : null; if (link) push('['); }
      else if (link) { const text = out.slice(link.at + 1).join('').trim(); out.length = link.at; if (text) push(text === link.href ? link.href : `[${text.replace(/\s*\n\s*/g, ' ')}](${link.href})`); link = null; }
      continue;
    }
    if (name === 'img') { const alt = attribute(part, 'alt').trim(); if (alt) push(`[image: ${alt}]`); continue; }
    if (name === 'td' || name === 'th') { if (!closing) { push(cell ? ' | ' : ''); cell = true; } continue; }
    if (name === 'tr') { cell = false; newline(1); continue; }
    if (name === 'blockquote') { newline(); if (!closing) push('> '); continue; }
    if (name === 'hr') { newline(); push('---'); newline(); continue; }
    if (BLOCK.has(name)) newline(name === 'p' || name === 'div' ? 2 : 2);
  }
  const markdown = out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+(?=\S)/g, match => (/\n {2,}/.test(match) ? match : '\n')).replace(/\n{3,}/g, '\n\n').trim();
  return { title, description, markdown };
}

/**
 * GET `target` and return `{ status, finalUrl, contentType, title, description, markdown }`. A non-2xx answer is
 * returned with its status and no text; transport and policy failures throw `DirectFetchError`.
 * `lookup` and `allowAddress` are seams for tests; the defaults resolve with the system resolver and admit public addresses only.
 */
export async function fetchPageDirect(target, { timeoutMs = 30000, maxBytes = DIRECT_FETCH_MAX_BYTES, maxRedirects = DIRECT_FETCH_REDIRECTS, signal, lookup = dnsLookup, allowAddress = publicAddress, userAgent = 'RnaAgent/1 (local web_fetch; +https://github.com/skingko/rna_dev)' } = {}) {
  let url; try { url = new URL(target); } catch { throw fail('WEB_ARGUMENTS', 'A complete http(s) URL is required.'); }
  for (let hop = 0; ; hop++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('WEB_ARGUMENTS', 'Only http(s) URLs without credentials are read.');
    if (signal?.aborted) throw fail('WEB_ABORTED', 'Web request cancelled.');
    const answer = await getOnce(url, { timeoutMs, maxBytes, signal, lookup, allowAddress, userAgent });
    if (answer.status >= 300 && answer.status < 400 && answer.headers.location) {
      if (hop >= maxRedirects) throw fail('WEB_REDIRECTS', `The page redirected more than ${maxRedirects} times.`);
      try { url = new URL(answer.headers.location, url); } catch { throw fail('WEB_REDIRECTS', 'The page redirected to an invalid address.'); }
      url.hash = ''; continue;
    }
    const contentType = String(answer.headers['content-type'] ?? '').slice(0, 200);
    if (!answer.body) return { status: answer.status, finalUrl: url.href, contentType, title: '', description: '', markdown: '' };
    const text = decodeBody(answer.body, contentType), type = contentType.split(';')[0].trim().toLowerCase();
    const page = !type || type === 'text/html' || type === 'application/xhtml+xml' || /^\s*(?:<!doctype html|<html[\s>])/i.test(text.slice(0, 512)) ? htmlToMarkdown(text, url.href) : { title: '', description: '', markdown: text.trim() };
    return { status: answer.status, finalUrl: url.href, contentType, ...page };
  }
}
